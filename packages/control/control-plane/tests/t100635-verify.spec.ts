/**
 * Independent t100635 verification (tester-authored).
 *
 * Black-box runtime checks of instance reachability, retry, and automatic
 * recovery through the exported seams only:
 *
 * - `buildTree` keeps an unreachable instance distinguishable from a connected
 *   one that simply has no sessions.
 * - `ControlPlane.snapshot()` never writes an empty row list for a failed
 *   `listSessions()`, and a mounted-but-failing connection recovers on its
 *   next successful read without a reconnect.
 * - `InstanceConnections.reconnect` shares concurrent attempts, reports
 *   `connecting` while in flight, returns failures as values, and throws for
 *   an unknown id.
 * - `InstanceConnections.recover` respects the injected clock's retry window
 *   and keeps retrying an instance that never mounted.
 * - The generated `controlPlane/tree` schema keeps `state` and optional
 *   `error` (both static JSON schema and the runtime decode).
 *
 * No network: every upstream is a fake injected through `open`. The
 * `ControlPlane` bench replaces its private connection registry with an
 * injected one and stubs `ctx.effect`, so construction never dials out.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedInstance } from '../src/config.ts'
import {
  DEFAULT_RETRY_INTERVAL_MS, InstanceConnections, type InstanceConnection, type OpenUpstream,
} from '../src/connections.ts'
import { ControlPlane } from '../src/index.ts'
import { buildTree } from '../src/tree.ts'
import type { InstanceStateReport, SessionRow, UpstreamState } from '../src/types.ts'
import { TYPERT_REMOTE } from '../lib/typert.remote-client.js'

/** The generated result codec face this check reads (runtime shape, not the .d.ts type). */
interface GeneratedCodec { readonly parse: (value: unknown) => unknown }
interface GeneratedTreeMethod {
  readonly result: { readonly create: () => GeneratedCodec; readonly jsonSchema: unknown }
}
interface GeneratedRemoteProduct {
  readonly spec: { readonly methods: Readonly<Record<string, GeneratedTreeMethod>> }
}

const controlPlaneRemote = TYPERT_REMOTE as unknown as GeneratedRemoteProduct

beforeEach(() => {
  // A failed attempt logs its reason; the assertions read the same reason.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Two configured instances; order is the sidebar order. */
const INSTANCES: readonly ResolvedInstance[] = [
  { id: 'alpha', name: 'Alpha', host: 'a.local', port: 1, baseUrl: 'http://a.local:1' },
  { id: 'beta', name: 'Beta', host: 'b.local', port: 2, baseUrl: 'http://b.local:2' },
]

/** One session row. */
function row(sessionId: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return { sessionId, updatedAt: 1, running: false, ...overrides }
}

/** Probe behavior a test can flip between reads. */
interface Probe {
  rows: readonly SessionRow[]
  listError: string | undefined
}

/** A fake upstream plus the state the test can observe and mutate. */
interface FakeUpstream {
  readonly upstream: InstanceConnection
  readonly probe: Probe
  readonly state: { disposed: boolean; listCalls: number }
}

/**
 * Build a fake upstream whose probe succeeds with `rows` or throws `listError`.
 * @param rows - rows a successful probe returns.
 * @param listError - when set, the probe throws this message.
 * @returns the connection face and its mutable probe behavior.
 */
function fakeUpstream(rows: readonly SessionRow[] = [], listError?: string): FakeUpstream {
  const probe: Probe = { rows, listError }
  const state = { disposed: false, listCalls: 0 }
  const upstream: InstanceConnection = {
    get reachability(): UpstreamState { return probe.listError === undefined ? 'connected' : 'unreachable' },
    get error(): string | undefined { return probe.listError },
    async listSessions(): Promise<SessionRow[]> {
      state.listCalls += 1
      if (probe.listError !== undefined) throw new Error(probe.listError)
      return [...probe.rows]
    },
    createSession: async (): Promise<string> => 'session-new',
    onSessionStatus: (): (() => void) => () => {},
    async dispose(): Promise<void> { state.disposed = true },
  }
  return { upstream, probe, state }
}

/** Drain the microtask queue for background work `recover()` never returns. */
async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

/** A promise plus its setters, for pinning the in-flight window. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}

/**
 * A Context stand-in good enough for `ControlPlane`'s constructor: it registers
 * the service but never activates the effect (that would dial out).
 * @returns the fake context.
 */
function inertContext(): Context {
  const ctx = {
    reflect: { provide: (): void => {} },
    get: (): undefined => undefined,
    effect: (): (() => void) => () => {},
  }
  return ctx as unknown as Context
}

/** A `ControlPlane` whose connection registry is the injected fake one. */
function controlPlaneBench(
  instances: readonly ResolvedInstance[],
  open: OpenUpstream,
  options: { now?: () => number; retryIntervalMs?: number } = {},
): { control: ControlPlane; connections: InstanceConnections } {
  const control = new ControlPlane(inertContext(), { instances: instances.map(instance => ({
    id: instance.id, name: instance.name, host: instance.host, port: instance.port,
  })) })
  const connections = new InstanceConnections(instances, { open, ...options })
  // Private at compile time only; the constructor already built the real one,
  // which never opened anything because the effect was never activated.
  ;(control as unknown as { connections: InstanceConnections }).connections = connections
  return { control, connections }
}

// ---------------------------------------------------------------------------
// 1 — the tree frame separates "offline" from "connected and empty"
// ---------------------------------------------------------------------------
describe('t100635 / tree frame: unreachable ≠ empty', () => {
  it('keeps an unreachable instance with workspaces=[] and state=unreachable', () => {
    const [alpha, beta] = buildTree(INSTANCES, new Map(), {
      alpha: { state: 'unreachable', error: 'connect ECONNREFUSED' },
      beta: { state: 'connected' },
    })
    expect(alpha?.state).toBe('unreachable')
    expect(alpha?.workspaces).toEqual([])
    expect(alpha?.sessionCount).toBe(0)
    expect(alpha?.error).toBe('connect ECONNREFUSED')
    // A connected instance with no rows is the *other* shape of empty.
    expect(beta?.state).toBe('connected')
    expect(beta?.workspaces).toEqual([])
    expect(beta?.sessionCount).toBe(0)
    expect(beta).not.toHaveProperty('error')
  })

  it('keeps the reported state when rows do arrive (snapshot is what withholds them)', () => {
    const states: Record<string, InstanceStateReport> = { alpha: { state: 'unreachable', error: 'down' } }
    const [node] = buildTree(INSTANCES, new Map([['alpha', [row('s1')]]]), states)
    // The frame never fabricates rows: buildTree composes what it is given and
    // reports the reachability it was told. Withholding rows on failure is the
    // snapshot() contract, asserted below.
    expect(node?.state).toBe('unreachable')
    expect(node?.error).toBe('down')
    expect(node?.sessionCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 2 — snapshot(): a failed listSessions contributes no row entry at all
// ---------------------------------------------------------------------------
describe('t100635 / ControlPlane.snapshot', () => {
  it('reports state, error, and empty workspaces for a failing upstream', async () => {
    const broken = fakeUpstream([], 'read ECONNRESET')
    const healthy = fakeUpstream([])
    const open = vi.fn<OpenUpstream>(async instance => instance.id === 'alpha' ? broken.upstream : healthy.upstream)
    const { control } = controlPlaneBench(INSTANCES, open)

    await control.connect()
    const tree = await control.snapshot()
    const alpha = tree.find(node => node.instanceId === 'alpha')
    const beta = tree.find(node => node.instanceId === 'beta')

    expect(alpha?.state).toBe('unreachable')
    expect(alpha?.error).toBe('read ECONNRESET')
    expect(alpha?.workspaces).toEqual([])
    expect(alpha?.sessionCount).toBe(0)

    // The connected-empty instance differs in exactly one field: state.
    expect(beta?.state).toBe('connected')
    expect(beta?.workspaces).toEqual([])
    expect(beta?.sessionCount).toBe(0)
    expect(beta).not.toHaveProperty('error')

    await control.dispose()
  })

  it('keeps a mounted failing connection and heals it on the next successful read', async () => {
    const flaky = fakeUpstream([row('s1')], 'probe timed out')
    const open = vi.fn<OpenUpstream>(async () => flaky.upstream)
    const { control } = controlPlaneBench([INSTANCES[0]!], open)

    const first = await control.reconnect({ instanceId: 'alpha' })
    expect(first).toEqual({ state: 'unreachable', error: 'probe timed out' })
    let frame = await control.snapshot()
    expect(frame[0]?.state).toBe('unreachable')
    expect(frame[0]?.workspaces).toEqual([])

    // Same connection, next read succeeds: connected again without re-opening.
    flaky.probe.listError = undefined
    frame = await control.snapshot()
    expect(frame[0]?.state).toBe('connected')
    expect(frame[0]?.sessionCount).toBe(1)
    expect(open).toHaveBeenCalledTimes(1)

    await control.dispose()
  })

  it('a failed retry value reaches the next snapshot as the new reason', async () => {
    const open = vi.fn<OpenUpstream>()
      .mockRejectedValueOnce(new Error('first: refused'))
      .mockRejectedValueOnce(new Error('second: timeout'))
    const { control } = controlPlaneBench([INSTANCES[0]!], open)

    await expect(control.reconnect({ instanceId: 'alpha' })).resolves.toEqual({
      state: 'unreachable', error: 'first: refused',
    })
    await expect(control.reconnect({ instanceId: 'alpha' })).resolves.toEqual({
      state: 'unreachable', error: 'second: timeout',
    })
    const [node] = await control.snapshot()
    expect(node?.state).toBe('unreachable')
    expect(node?.error).toBe('second: timeout')
    expect(node?.workspaces).toEqual([])

    await control.dispose()
  })
})

// ---------------------------------------------------------------------------
// 3 — reconnect: in-flight state, failure as value, unknown id, dedupe
// ---------------------------------------------------------------------------
describe('t100635 / InstanceConnections.reconnect', () => {
  it('reports connecting while the retry is in flight, then connected', async () => {
    const gate = deferred<InstanceConnection>()
    const connections = new InstanceConnections([INSTANCES[0]!], { open: async () => await gate.promise })

    const attempt = connections.reconnect('alpha')
    await settle()
    // The sidebar shows progress, not a stale failure, while the retry runs.
    expect(connections.states()['alpha']).toEqual({ state: 'connecting' })

    gate.resolve(fakeUpstream().upstream)
    await expect(attempt).resolves.toEqual({ state: 'connected' })
    expect(connections.states()['alpha']).toEqual({ state: 'connected' })
  })

  it('returns { state: unreachable, error } instead of rejecting', async () => {
    const connections = new InstanceConnections([INSTANCES[0]!], {
      open: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1') },
    })
    const value = await connections.reconnect('alpha')
    expect(value).toEqual({ state: 'unreachable', error: 'connect ECONNREFUSED 127.0.0.1:1' })
    expect(connections.states()['alpha']).toEqual(value)
  })

  it('throws for an unconfigured instance id', async () => {
    const connections = new InstanceConnections(INSTANCES, { open: async () => fakeUpstream().upstream })
    await expect(connections.reconnect('gamma')).rejects.toThrow(/未知实例/)
  })

  it('opens once for two concurrent reconnects of the same instance', async () => {
    const gate = deferred<InstanceConnection>()
    const open = vi.fn<OpenUpstream>(async () => await gate.promise)
    const connections = new InstanceConnections([INSTANCES[0]!], { open })

    const first = connections.reconnect('alpha')
    const second = connections.reconnect('alpha')
    await settle()
    expect(open).toHaveBeenCalledTimes(1)

    gate.resolve(fakeUpstream([row('s1')]).upstream)
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual({ state: 'connected' })
    expect(b).toEqual(a)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('reconnects only the requested instance', async () => {
    const open = vi.fn<OpenUpstream>(async () => fakeUpstream().upstream)
    const connections = new InstanceConnections(INSTANCES, { open })
    await connections.reconnect('beta')
    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0]?.[0]).toMatchObject({ id: 'beta' })
  })
})

// ---------------------------------------------------------------------------
// 4 — automatic recovery: bounded rate, keeps trying, never for mounted ones
// ---------------------------------------------------------------------------
describe('t100635 / InstanceConnections.recover', () => {
  it('does not retry inside the interval and retries after it', async () => {
    const open = vi.fn<OpenUpstream>(async () => { throw new Error('still down') })
    let clock = 1_000
    const connections = new InstanceConnections([INSTANCES[0]!], {
      open, now: () => clock, retryIntervalMs: 5_000,
    })
    await connections.connect()
    expect(open).toHaveBeenCalledTimes(1)

    clock += 4_999
    connections.recover()
    await settle()
    expect(open).toHaveBeenCalledTimes(1)

    clock += 1
    connections.recover()
    await settle()
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('keeps retrying after a failed attempt on the next window', async () => {
    const open = vi.fn<OpenUpstream>(async () => { throw new Error('down') })
    let clock = 0
    const connections = new InstanceConnections([INSTANCES[0]!], { open, now: () => clock })
    await connections.connect()
    expect(connections.states()['alpha']?.state).toBe('unreachable')

    clock += DEFAULT_RETRY_INTERVAL_MS
    connections.recover()
    await settle()
    expect(open).toHaveBeenCalledTimes(2)

    // Failure did not stick as "give up": the next window tries again.
    clock += DEFAULT_RETRY_INTERVAL_MS
    connections.recover()
    await settle()
    expect(open).toHaveBeenCalledTimes(3)
  })

  it('stops retrying once an instance finally mounts', async () => {
    const healthy = fakeUpstream()
    const open = vi.fn<OpenUpstream>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(healthy.upstream)
    let clock = 0
    const connections = new InstanceConnections([INSTANCES[0]!], { open, now: () => clock })
    await connections.connect()
    clock += DEFAULT_RETRY_INTERVAL_MS
    connections.recover()
    await settle()
    expect(connections.get('alpha')).toBe(healthy.upstream)

    clock += DEFAULT_RETRY_INTERVAL_MS * 5
    connections.recover()
    await settle()
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('does not start a second attempt while one is still in flight', async () => {
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
})

// ---------------------------------------------------------------------------
// 5 — the generated controlPlane/tree schema keeps state and optional error
// ---------------------------------------------------------------------------
describe('t100635 / controlPlane/tree schema', () => {
  const method = controlPlaneRemote.spec.methods['controlPlane/tree']
  if (method === undefined) throw new Error('control-plane artifact exposes no controlPlane/tree method')

  it('declares the state enum and an optional error in the static JSON schema', () => {
    const jsonSchema = method.result.jsonSchema as {
      items?: {
        properties?: Record<string, { enum?: unknown; type?: string }>
        required?: readonly string[]
      }
    }
    const properties = jsonSchema.items?.properties ?? {}
    expect(properties['state']?.enum).toEqual(['connecting', 'connected', 'unreachable'])
    expect(properties['error']?.type).toBe('string')
    expect(jsonSchema.items?.required).toContain('state')
    expect(jsonSchema.items?.required).not.toContain('error')
  })

  it('declares the state enum in the generated zod schema text', () => {
    const artifact = readFileSync(resolve(process.cwd(), 'packages/control/control-plane/lib/typert.remote-client.js'), 'utf8')
    // The zod declaration (not the method table, which only references it).
    const start = artifact.indexOf('_deepseek_ai_dsh_control_plane_controlPlane_tree_result$schema = () =>')
    const end = artifact.indexOf('_deepseek_ai_dsh_control_plane_controlPlane_reconnect_parameter_0_strict$schema', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = artifact.slice(start, end)
    expect(block).toContain("'state':")
    expect(block).toContain('z.literal("unreachable")')
    expect(block).toContain("'error': z.union([z.undefined(), z.string()])")
  })

  it('keeps state and error after the browser-side decode', () => {
    const codec = method.result.create()
    const decoded = codec.parse([{
      instanceId: 'alpha',
      label: 'Alpha(alpha)',
      state: 'connected',
      runningCount: 0,
      sessionCount: 0,
      workspaces: [],
    }, {
      instanceId: 'beta',
      label: 'Beta(beta)',
      state: 'unreachable',
      error: 'connect ECONNREFUSED',
      runningCount: 0,
      sessionCount: 0,
      workspaces: [],
    }]) as readonly { state?: string; error?: string }[]

    expect(decoded[0]?.state).toBe('connected')
    expect(decoded[0]).not.toHaveProperty('error')
    expect(decoded[1]?.state).toBe('unreachable')
    expect(decoded[1]?.error).toBe('connect ECONNREFUSED')
  })

  it('rejects a state outside the enum (proves the literal union is enforced)', () => {
    const codec = method.result.create()
    expect(() => codec.parse([{
      instanceId: 'alpha',
      label: 'Alpha(alpha)',
      state: 'offline',
      runningCount: 0,
      sessionCount: 0,
      workspaces: [],
    }])).toThrow()
  })
})
