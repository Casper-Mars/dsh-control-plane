/**
 * Instance reachability: the tree's per-node state, the retry path, and the
 * automatic recovery policy.
 *
 * These are the seams S3-03 added: `buildTree` must tell an offline instance
 * apart from an empty one, `InstanceConnections.reconnect` must turn a retry
 * failure into a value (not a throw) and share one attempt between concurrent
 * callers, and `recover` must retry without a connection at a bounded rate so
 * the 6s tree poll cannot become a connection storm.
 *
 * No network here: `open` is injected, so every upstream is a fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedInstance } from '../src/config.ts'
import {
  DEFAULT_RETRY_INTERVAL_MS, InstanceConnections, type InstanceConnection, type OpenUpstream,
} from '../src/connections.ts'
import { buildTree } from '../src/tree.ts'
import type { InstanceStateReport, SessionRow, UpstreamState } from '../src/types.ts'

beforeEach(() => {
  // Failed attempts log the reason; the assertions already read it.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Two configured instances; order matters for `connect()`. */
const INSTANCES: readonly ResolvedInstance[] = [
  { id: 'alpha', name: 'Alpha', host: 'a.local', port: 1, baseUrl: 'http://a.local:1' },
  { id: 'beta', name: 'Beta', host: 'b.local', port: 2, baseUrl: 'http://b.local:2' },
]

/** One session row. */
function row(sessionId: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return { sessionId, updatedAt: 1, running: false, ...overrides }
}

/** Observable half of a fake upstream, so tests can assert disposal. */
interface FakeState {
  disposed: boolean
  reachability: UpstreamState
  error: string | undefined
  listCalls: number
}

/** A fake upstream's probe outcome; mutable so a test can let it recover. */
interface FakeBehavior {
  rows: readonly SessionRow[] | undefined
  listError: string | undefined
}

/**
 * A fake upstream whose probe either succeeds with `rows` or throws `listError`.
 * @param behavior - initial probe outcome.
 * @returns the upstream face, its observable state, and its mutable behavior.
 */
function fakeUpstream(behavior: { rows?: readonly SessionRow[]; listError?: string } = {}): {
  upstream: InstanceConnection
  state: FakeState
  behavior: FakeBehavior
} {
  const state: FakeState = { disposed: false, reachability: 'connected', error: undefined, listCalls: 0 }
  const probe: FakeBehavior = { rows: behavior.rows, listError: behavior.listError }
  const upstream: InstanceConnection = {
    get reachability(): UpstreamState { return state.reachability },
    get error(): string | undefined { return state.error },
    async listSessions(): Promise<SessionRow[]> {
      state.listCalls += 1
      if (probe.listError !== undefined) {
        state.reachability = 'unreachable'
        state.error = probe.listError
        throw new Error(probe.listError)
      }
      state.reachability = 'connected'
      state.error = undefined
      return [...(probe.rows ?? [])]
    },
    createSession: async (): Promise<string> => 'session-new',
    onSessionStatus: (): (() => void) => () => {},
    async dispose(): Promise<void> { state.disposed = true },
  }
  return { upstream, state, behavior: probe }
}

/**
 * Drain the microtask queue enough for a background attempt to settle.
 * `recover()` deliberately does not return its attempt, so tests cannot await
 * it directly.
 */
async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

/** A deferred promise, for asserting the in-flight window. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------------------
// 1 — the tree carries reachability, so "offline" and "empty" differ
// ---------------------------------------------------------------------------
describe('buildTree instance state', () => {
  it('writes the reported state and error onto every node', () => {
    const states: Record<string, InstanceStateReport> = {
      alpha: { state: 'connected' },
      beta: { state: 'unreachable', error: 'connect ECONNREFUSED' },
    }
    const [alpha, beta] = buildTree(INSTANCES, new Map([['alpha', [row('s1')]]]), states)
    expect(alpha?.state).toBe('connected')
    expect(alpha).not.toHaveProperty('error')
    expect(alpha?.sessionCount).toBe(1)
    expect(beta?.state).toBe('unreachable')
    expect(beta?.error).toBe('connect ECONNREFUSED')
  })

  it('keeps an unreachable instance in configuration order with no sessions', () => {
    const tree = buildTree(INSTANCES, new Map(), { alpha: { state: 'unreachable', error: 'down' } })
    expect(tree.map(node => node.instanceId)).toEqual(['alpha', 'beta'])
    expect(tree[0]?.workspaces).toEqual([])
    expect(tree[0]?.sessionCount).toBe(0)
    expect(tree[0]?.state).toBe('unreachable')
  })

  it('reports connecting as its own state', () => {
    const [node] = buildTree(INSTANCES, new Map(), { alpha: { state: 'connecting' } })
    expect(node?.state).toBe('connecting')
  })

  it('defaults a node without a reported state to connected', () => {
    const [node] = buildTree(INSTANCES, new Map([['alpha', [row('s1')]]]))
    expect(node?.state).toBe('connected')
    expect(node).not.toHaveProperty('error')
  })
})

// ---------------------------------------------------------------------------
// 2 — connect pass: outcomes per instance, never a rejected pass
// ---------------------------------------------------------------------------
describe('InstanceConnections.connect', () => {
  it('reports the connected ids in configuration order and records failures', async () => {
    const alpha = fakeUpstream()
    const open = vi.fn<OpenUpstream>(async (instance) => {
      if (instance.id === 'beta') throw new Error('beta refused')
      return alpha.upstream
    })
    const connections = new InstanceConnections(INSTANCES, { open })
    await expect(connections.connect()).resolves.toEqual(['alpha'])
    expect(connections.get('alpha')).toBe(alpha.upstream)
    expect(connections.get('beta')).toBeUndefined()
    expect(connections.states()).toEqual({
      alpha: { state: 'connected' },
      beta: { state: 'unreachable', error: 'beta refused' },
    })
  })

  it('attaches before probing, so an early event is not lost', async () => {
    const open = vi.fn<OpenUpstream>(async () => fakeUpstream().upstream)
    const attach = vi.fn()
    const connections = new InstanceConnections(INSTANCES, { open, attach })
    await connections.connect()
    expect(attach).toHaveBeenCalledTimes(2)
    expect(attach.mock.calls[0]?.[0]).toMatchObject({ id: 'alpha' })
  })

  it('reports connecting while an attempt is in flight', async () => {
    const gate = deferred<InstanceConnection>()
    const connections = new InstanceConnections(INSTANCES, {
      open: async instance => instance.id === 'alpha' ? await gate.promise : fakeUpstream().upstream,
    })
    const pass = connections.connect()
    expect(connections.states()['alpha']).toEqual({ state: 'connecting' })
    gate.resolve(fakeUpstream().upstream)
    await pass
    expect(connections.states()['alpha']).toEqual({ state: 'connected' })
  })
})

// ---------------------------------------------------------------------------
// 3 — reconnect: success, failure-as-value, dedupe, unknown id
// ---------------------------------------------------------------------------
describe('InstanceConnections.reconnect', () => {
  it('disposes the old connection and reports connected', async () => {
    const first = fakeUpstream()
    const second = fakeUpstream({ rows: [row('s1')] })
    const open = vi.fn<OpenUpstream>()
      .mockResolvedValueOnce(first.upstream)
      .mockResolvedValueOnce(second.upstream)
    const connections = new InstanceConnections([INSTANCES[0]!], { open })
    await connections.connect()
    expect(connections.get('alpha')).toBe(first.upstream)

    await expect(connections.reconnect('alpha')).resolves.toEqual({ state: 'connected' })
    expect(first.state.disposed).toBe(true)
    expect(connections.get('alpha')).toBe(second.upstream)
    expect(connections.states()['alpha']).toEqual({ state: 'connected' })
  })

  it('returns the failure as a value and keeps the reason for the next frame', async () => {
    const open = vi.fn<OpenUpstream>()
      .mockRejectedValueOnce(new Error('第一次: refused'))
      .mockRejectedValueOnce(new Error('第二次: timeout'))
    const connections = new InstanceConnections([INSTANCES[0]!], { open })
    await expect(connections.reconnect('alpha')).resolves.toEqual({
      state: 'unreachable', error: '第一次: refused',
    })
    await expect(connections.reconnect('alpha')).resolves.toEqual({
      state: 'unreachable', error: '第二次: timeout',
    })
    expect(connections.states()['alpha']?.error).toBe('第二次: timeout')
  })

  it('keeps a mounted-but-unreachable connection so its next read can recover it', async () => {
    const flaky = fakeUpstream({ listError: 'probe failed' })
    const connections = new InstanceConnections([INSTANCES[0]!], {
      open: async () => flaky.upstream,
    })
    await expect(connections.reconnect('alpha')).resolves.toEqual({ state: 'unreachable', error: 'probe failed' })
    expect(connections.get('alpha')).toBe(flaky.upstream)
    expect(connections.states()['alpha']).toEqual({ state: 'unreachable', error: 'probe failed' })

    // The same connection answers on the next read: back online, no reconnect.
    flaky.behavior.listError = undefined
    await flaky.upstream.listSessions()
    expect(connections.states()['alpha']).toEqual({ state: 'connected' })
  })

  it('shares one attempt between concurrent callers of the same instance', async () => {
    const gate = deferred<InstanceConnection>()
    const open = vi.fn<OpenUpstream>(async () => await gate.promise)
    const connections = new InstanceConnections([INSTANCES[0]!], { open })
    const first = connections.reconnect('alpha')
    const second = connections.reconnect('alpha')
    await settle()
    expect(open).toHaveBeenCalledTimes(1)
    gate.resolve(fakeUpstream().upstream)
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual({ state: 'connected' })
    expect(b).toEqual(a)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('rejects an unconfigured instance id', async () => {
    const connections = new InstanceConnections(INSTANCES, { open: async () => fakeUpstream().upstream })
    await expect(connections.reconnect('gamma')).rejects.toThrow(/未知实例/)
  })

  it('reconnects the instance named by the request only', async () => {
    const open = vi.fn<OpenUpstream>(async () => fakeUpstream().upstream)
    const connections = new InstanceConnections(INSTANCES, { open })
    await connections.reconnect('beta')
    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0]?.[0]).toMatchObject({ id: 'beta' })
  })
})

// ---------------------------------------------------------------------------
// 4 — automatic recovery: retry only what has no connection, rate limited
// ---------------------------------------------------------------------------
describe('InstanceConnections.recover', () => {
  it('retries an instance that never connected, then leaves it alone', async () => {
    let create = 0
    const open = vi.fn<OpenUpstream>(async () => {
      create += 1
      if (create === 1) throw new Error('down')
      return fakeUpstream().upstream
    })
    let clock = 0
    const connections = new InstanceConnections([INSTANCES[0]!], { open, now: () => clock })
    await connections.connect()
    expect(connections.states()['alpha']?.state).toBe('unreachable')

    // The activation pass counts as an attempt: the next one waits a window.
    clock += DEFAULT_RETRY_INTERVAL_MS
    connections.recover()
    await settle()
    expect(connections.get('alpha')).toBeDefined()
    expect(open).toHaveBeenCalledTimes(2)

    // A mounted instance is never re-opened by recovery.
    clock += DEFAULT_RETRY_INTERVAL_MS * 10
    connections.recover()
    await Promise.resolve()
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('limits retries of one instance to one per interval', async () => {
    const open = vi.fn<OpenUpstream>(async () => { throw new Error('down') })
    let clock = 1000
    const connections = new InstanceConnections([INSTANCES[0]!], {
      open,
      now: () => clock,
      retryIntervalMs: 5000,
    })
    await connections.connect()
    expect(open).toHaveBeenCalledTimes(1)

    // Inside the window: no new attempt.
    clock += 4999
    connections.recover()
    await Promise.resolve()
    expect(open).toHaveBeenCalledTimes(1)

    // Past the window: exactly one new attempt.
    clock += 1
    connections.recover()
    await settle()
    expect(open).toHaveBeenCalledTimes(2)

    // Every 6s poll past the window retries once, not per instance per frame.
    clock += 6000
    connections.recover()
    await settle()
    expect(open).toHaveBeenCalledTimes(3)
  })

  it('does not start a second attempt while one is in flight', async () => {
    const gate = deferred<InstanceConnection>()
    const open = vi.fn<OpenUpstream>(async () => await gate.promise)
    let clock = 0
    const connections = new InstanceConnections([INSTANCES[0]!], { open, now: () => clock })
    connections.recover()
    await settle()
    expect(open).toHaveBeenCalledTimes(1)
    clock += DEFAULT_RETRY_INTERVAL_MS * 3
    connections.recover()
    await settle()
    expect(open).toHaveBeenCalledTimes(1)
    gate.reject(new Error('down'))
    await settle()
    expect(connections.states()['alpha']?.state).toBe('unreachable')
  })

  it('does nothing after dispose', async () => {
    const open = vi.fn<OpenUpstream>(async () => fakeUpstream().upstream)
    const connections = new InstanceConnections(INSTANCES, { open })
    await connections.dispose()
    connections.recover()
    await Promise.resolve()
    expect(open).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 5 — dispose closes what it owns and what is still being opened
// ---------------------------------------------------------------------------
describe('InstanceConnections.dispose', () => {
  it('disposes every mounted connection and clears the registry', async () => {
    const alpha = fakeUpstream()
    const beta = fakeUpstream()
    const connections = new InstanceConnections(INSTANCES, {
      open: async instance => instance.id === 'alpha' ? alpha.upstream : beta.upstream,
    })
    await connections.connect()
    await connections.dispose()
    expect(alpha.state.disposed).toBe(true)
    expect(beta.state.disposed).toBe(true)
    expect(connections.get('alpha')).toBeUndefined()
  })

  it('closes a connection that finishes opening after dispose', async () => {
    const gate = deferred<InstanceConnection>()
    const late = fakeUpstream()
    const connections = new InstanceConnections([INSTANCES[0]!], { open: async () => await gate.promise })
    const attempt = connections.reconnect('alpha')
    await connections.dispose()
    gate.resolve(late.upstream)
    await expect(attempt).resolves.toEqual({ state: 'unreachable' })
    expect(late.state.disposed).toBe(true)
    expect(connections.get('alpha')).toBeUndefined()
  })
})
