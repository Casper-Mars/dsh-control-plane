/**
 * t100642 — the control-plane event stream.
 *
 * Two layers are checked:
 *
 * 1. {@link ControlPlaneEventHub} in isolation: the initial tree, each frame
 *    kind, the bounded per-subscriber queue (a slow reader must not stall a
 *    fast one, and must not lose a `tree`), and abort/close cleanup.
 * 2. `ControlPlane.events()` over a fake connection registry: the first frame
 *    is a real composed tree, a status change reaches the wire through the same
 *    `diff` → `publishStatus` path the sidebar uses, a list change reaches it
 *    through `emitChange`, and a failed/recovered probe produces `states` plus
 *    a fresh `tree`.
 *
 * The generated artifact is also asserted to carry `controlPlane/events` as a
 * stream endpoint, because the client can only subscribe to a schema the Host
 * actually publishes.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedInstance } from '../src/config.ts'
import {
  InstanceConnections, type InstanceConnection, type OpenUpstream,
} from '../src/connections.ts'
import { ControlPlaneEventHub, diffInstanceStates } from '../src/events.ts'
import { ControlPlane } from '../src/index.ts'
import type { ControlPlaneEvent, InstanceNode, SessionRow, UpstreamState } from '../src/types.ts'
import { TYPERT_REMOTE } from '../lib/typert.remote-client.js'

const INSTANCES: readonly ResolvedInstance[] = [
  { id: 'alpha', name: 'Alpha', host: '127.0.0.1', port: 1, baseUrl: 'http://127.0.0.1:1' },
]

/** One session row. */
function row(sessionId: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return { sessionId, updatedAt: 1, running: false, ...overrides }
}

/** A tree with one instance and one session, for hub-only tests. */
function treeOf(running = false): readonly InstanceNode[] {
  return [{
    instanceId: 'alpha',
    label: 'Alpha(alpha)',
    state: 'connected',
    runningCount: running ? 1 : 0,
    sessionCount: 1,
    workspaces: [{
      key: 'alpha:/w',
      path: '/w',
      runningCount: running ? 1 : 0,
      latestUpdatedAt: 1,
      sessions: [{
        key: 'alpha:s-1',
        sessionId: 's-1',
        instanceId: 'alpha',
        running,
        updatedAt: 1,
      }],
    }],
  }]
}

/** Pull one frame, failing loudly when the stream ended early. */
async function nextFrame(iterator: AsyncIterator<ControlPlaneEvent>): Promise<ControlPlaneEvent> {
  const result = await iterator.next()
  if (result.done === true) throw new Error('fixture: event stream ended early')
  return result.value
}

beforeEach(() => {
  // Construction and failed probes log; the assertions read the same values.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 1 — hub frames
// ---------------------------------------------------------------------------
describe('t100642 / ControlPlaneEventHub frames', () => {
  it('yields the initial tree before any published frame', async () => {
    const hub = new ControlPlaneEventHub()
    const controller = new AbortController()
    const iterator = hub.subscribe(async () => treeOf(), controller.signal)[Symbol.asyncIterator]()

    const first = await nextFrame(iterator)
    expect(first.kind).toBe('tree')
    if (first.kind !== 'tree') throw new Error('unreachable')
    expect(first.tree[0]?.instanceId).toBe('alpha')
    expect(first.tree[0]?.sessionCount).toBe(1)

    controller.abort()
  })

  it('publishes status, change, states, and tree frames in publication order', async () => {
    const hub = new ControlPlaneEventHub()
    const controller = new AbortController()
    const iterator = hub.subscribe(async () => treeOf(), controller.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)

    hub.publishStatus('alpha:s-1', true)
    hub.publishChange('alpha:s-2', 'added')
    hub.publishStates([{ instanceId: 'alpha', state: 'unreachable', error: 'boom' }])
    hub.publishTree(treeOf(true))

    expect(await nextFrame(iterator)).toEqual({ kind: 'status', key: 'alpha:s-1', running: true })
    expect(await nextFrame(iterator)).toEqual({ kind: 'change', key: 'alpha:s-2', change: 'added' })
    expect(await nextFrame(iterator)).toEqual({
      kind: 'states',
      states: [{ instanceId: 'alpha', state: 'unreachable', error: 'boom' }],
    })
    const tree = await nextFrame(iterator)
    expect(tree.kind).toBe('tree')
    if (tree.kind !== 'tree') throw new Error('unreachable')
    expect(tree.tree[0]?.runningCount).toBe(1)

    controller.abort()
  })

  it('drops an empty states frame instead of waking clients for nothing', async () => {
    const hub = new ControlPlaneEventHub()
    const controller = new AbortController()
    const iterator = hub.subscribe(async () => treeOf(), controller.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)

    hub.publishStates([])
    hub.publishStatus('alpha:s-1', true)

    // The empty states frame never enters the queue, so the status is next.
    expect((await nextFrame(iterator)).kind).toBe('status')
    controller.abort()
  })
})

// ---------------------------------------------------------------------------
// 2 — backpressure: one stalled subscriber never holds the others back
// ---------------------------------------------------------------------------
describe('t100642 / backpressure', () => {
  it('drops the oldest non-tree frames for a slow subscriber while a fast one sees all', async () => {
    const hub = new ControlPlaneEventHub(4)
    const slowController = new AbortController()
    const fastController = new AbortController()
    const slow = hub.subscribe(async () => treeOf(), slowController.signal)[Symbol.asyncIterator]()
    const fast = hub.subscribe(async () => treeOf(), fastController.signal)[Symbol.asyncIterator]()
    await nextFrame(slow)
    await nextFrame(fast)

    // The fast reader drains each frame as it lands, so its four-slot queue
    // never overflows and it sees every key.
    const seen: string[] = []
    for (let index = 0; index < 10; index += 1) {
      const key = `alpha:s-${String(index)}`
      hub.publishStatus(key, true)
      const frame = await nextFrame(fast)
      if (frame.kind === 'status') seen.push(frame.key)
    }
    expect(seen).toEqual(Array.from({ length: 10 }, (_, index) => `alpha:s-${String(index)}`))

    // The slow reader kept only the newest four; its queue never grew past the limit.
    expect(hub.pendingCounts()[0]).toEqual({ queued: 4 })
    const kept: string[] = []
    for (let index = 0; index < 4; index += 1) {
      const frame = await nextFrame(slow)
      if (frame.kind === 'status') kept.push(frame.key)
    }
    expect(kept).toEqual(['alpha:s-6', 'alpha:s-7', 'alpha:s-8', 'alpha:s-9'])

    slowController.abort()
    fastController.abort()
  })

  it('never evicts a tree frame in favour of a status frame', async () => {
    const hub = new ControlPlaneEventHub(2)
    const controller = new AbortController()
    const iterator = hub.subscribe(async () => treeOf(), controller.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)

    hub.publishTree(treeOf(true))
    hub.publishStatus('alpha:s-1', false)
    // A third frame overflows the two-slot queue: the oldest *non-tree* frame
    // (the status) goes, the tree stays.
    hub.publishStatus('alpha:s-2', true)

    const first = await nextFrame(iterator)
    expect(first.kind).toBe('tree')
    if (first.kind !== 'tree') throw new Error('unreachable')
    expect(first.tree[0]?.runningCount).toBe(1)
    expect(await nextFrame(iterator)).toEqual({ kind: 'status', key: 'alpha:s-2', running: true })

    controller.abort()
  })
})

// ---------------------------------------------------------------------------
// 3 — abort and dispose cleanup
// ---------------------------------------------------------------------------
describe('t100642 / lifecycle', () => {
  it('abort clears the queue, removes the subscriber, and ends the iterator', async () => {
    const hub = new ControlPlaneEventHub()
    const controller = new AbortController()
    const iterator = hub.subscribe(async () => treeOf(), controller.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)

    hub.publishStatus('alpha:s-1', true)
    expect(hub.pendingCounts()).toEqual([{ queued: 1 }])

    controller.abort()
    expect(hub.subscriberCount).toBe(0)
    expect(hub.pendingCounts()).toEqual([])
    const ended = await iterator.next()
    expect(ended.done).toBe(true)

    // Publishing to a hub with no subscribers is a no-op, not a throw.
    hub.publishStatus('alpha:s-2', true)
  })

  it('an already-aborted signal never opens a subscription', async () => {
    const hub = new ControlPlaneEventHub()
    const controller = new AbortController()
    controller.abort()
    const iterator = hub.subscribe(async () => treeOf(), controller.signal)[Symbol.asyncIterator]()

    const result = await iterator.next()
    expect(result.done).toBe(true)
    expect(hub.subscriberCount).toBe(0)
  })

  it('abort while the initial snapshot is pending still clears the subscriber and its queue', async () => {
    const hub = new ControlPlaneEventHub()
    const controller = new AbortController()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    const iterator = hub.subscribe(async () => {
      await gate
      return treeOf()
    }, controller.signal)[Symbol.asyncIterator]()

    // The generator is parked inside the snapshot, not in the queue wait.
    const pending = iterator.next()
    await Promise.resolve()
    hub.publishStatus('alpha:s-1', true)

    controller.abort()
    // Cleanup cannot wait for the snapshot to settle: the subscriber and the
    // frames published meanwhile are gone at abort time.
    expect(hub.subscriberCount).toBe(0)
    expect(hub.pendingCounts()).toEqual([])

    release()
    expect((await pending).done).toBe(true)
  })

  it('a subscription opened after close ends immediately', async () => {
    const hub = new ControlPlaneEventHub()
    hub.close()
    const iterator = hub.subscribe(async () => treeOf(), new AbortController().signal)[Symbol.asyncIterator]()

    const result = await iterator.next()
    expect(result.done).toBe(true)
    expect(hub.subscriberCount).toBe(0)
  })

  it('close ends every live subscription', async () => {
    const hub = new ControlPlaneEventHub()
    const first = hub.subscribe(async () => treeOf(), new AbortController().signal)[Symbol.asyncIterator]()
    const second = hub.subscribe(async () => treeOf(), new AbortController().signal)[Symbol.asyncIterator]()
    await nextFrame(first)
    await nextFrame(second)

    hub.close()
    expect(hub.subscriberCount).toBe(0)
    expect((await first.next()).done).toBe(true)
    expect((await second.next()).done).toBe(true)
  })

  it('does not replay a tree published while the initial snapshot was composing', async () => {
    const hub = new ControlPlaneEventHub()
    const controller = new AbortController()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    const iterator = hub.subscribe(async () => {
      await gate
      return treeOf(true)
    }, controller.signal)[Symbol.asyncIterator]()

    // Start the generator so the subscription exists and is suspended in the
    // initial snapshot, then publish. Both frames land while composing.
    const pending = nextFrame(iterator)
    await Promise.resolve()

    // Published before the snapshot resolved: older than the frame the client
    // is about to receive, so it must not be replayed after it.
    hub.publishTree(treeOf(false))
    hub.publishStatus('alpha:s-1', true)
    release()

    const first = await pending
    expect(first.kind).toBe('tree')
    if (first.kind !== 'tree') throw new Error('unreachable')
    expect(first.tree[0]?.runningCount).toBe(1)
    expect(await nextFrame(iterator)).toEqual({ kind: 'status', key: 'alpha:s-1', running: true })

    controller.abort()
  })
})

// ---------------------------------------------------------------------------
// 4 — reachability diffing
// ---------------------------------------------------------------------------
describe('t100642 / diffInstanceStates', () => {
  it('reports state and error changes in configuration order and ignores stable instances', () => {
    const before = {
      alpha: { state: 'connected' as UpstreamState },
      beta: { state: 'unreachable' as UpstreamState, error: 'down' },
      gamma: { state: 'connecting' as UpstreamState },
    }
    const after = {
      alpha: { state: 'unreachable' as UpstreamState, error: 'refused' },
      beta: { state: 'connected' as UpstreamState },
      gamma: { state: 'connecting' as UpstreamState },
    }
    expect(diffInstanceStates(before, after, ['gamma', 'beta', 'alpha'])).toEqual([
      { instanceId: 'beta', state: 'connected' },
      { instanceId: 'alpha', state: 'unreachable', error: 'refused' },
    ])
  })
})

// ---------------------------------------------------------------------------
// 5 — ControlPlane.events() over a fake registry
// ---------------------------------------------------------------------------

/** Mutable outcome of one fake upstream. */
interface FakeState {
  rows: readonly SessionRow[]
  reachability: UpstreamState
  error: string | undefined
  failWith: string | undefined
  disposed: boolean
}

/** A fake upstream whose probe either lists `rows` or throws `failWith`. */
function fakeUpstream(state: FakeState): InstanceConnection {
  return {
    get reachability(): UpstreamState { return state.reachability },
    get error(): string | undefined { return state.error },
    async listSessions(): Promise<SessionRow[]> {
      if (state.failWith !== undefined) {
        state.reachability = 'unreachable'
        state.error = state.failWith
        throw new Error(state.failWith)
      }
      state.reachability = 'connected'
      state.error = undefined
      return [...state.rows]
    },
    createSession: async (): Promise<string> => 'session-new',
    onSessionStatus: (): (() => void) => () => {},
    async dispose(): Promise<void> { state.disposed = true },
  }
}

/**
 * Read one Context member without letting its `any` leak into the enclosing
 * proxy handler (the lint gate rejects unsafe returns).
 * @param target - real Context behind the proxy.
 * @param property - member being read.
 * @param receiver - proxy the read came through.
 * @returns the member value.
 */
function readMember(target: Context, property: PropertyKey, receiver: unknown): unknown {
  return Reflect.get(target, property, receiver)
}

/**
 * A ControlPlane whose own dial-out effect is stubbed out and whose connection
 * registry is replaced with one built on an injected `open`.
 * @param open - the connection seam.
 * @returns the control plane plus the registry it now uses.
 */
function bench(open: OpenUpstream): { control: ControlPlane; connections: InstanceConnections } {
  // A real Context gives the service base class what it expects; the proxy
  // only replaces the constructor's dial-out effect so no host is contacted.
  const root = new Context()
  const ctx: Context = new Proxy(root, {
    get(target, property, receiver) {
      if (property === 'effect') return () => () => Promise.resolve()
      return readMember(target, property, receiver)
    },
  })
  const control = new ControlPlane(ctx, {
    instances: INSTANCES.map(({ id, name, host, port }) => ({ id, name, host, port })),
  })
  const connections = new InstanceConnections(INSTANCES, { open })
  // The constructor's own registry would dial the configured host; tests own it.
  Object.assign(control, { connections })
  return { control, connections }
}

describe('t100642 / ControlPlane.events', () => {
  it('starts with a composed tree and pushes status, change, and states frames', async () => {
    vi.useFakeTimers()
    const state: FakeState = {
      rows: [row('s-1', { updatedAt: 10, running: false })],
      reachability: 'connected',
      error: undefined,
      failWith: undefined,
      disposed: false,
    }
    const upstream = fakeUpstream(state)
    const { control, connections } = bench(async () => upstream)
    await connections.connect()

    const controller = new AbortController()
    const iterator = control.events(controller.signal)[Symbol.asyncIterator]()

    const first = await nextFrame(iterator)
    expect(first.kind).toBe('tree')
    if (first.kind !== 'tree') throw new Error('unreachable')
    expect(first.tree[0]?.sessionCount).toBe(1)
    expect(first.tree[0]?.workspaces[0]?.sessions[0]?.running).toBe(false)

    // A probe now reports the turn as running and a second session added: the
    // same `diff` path the 2s loop uses produces one status and one change.
    state.rows = [row('s-1', { updatedAt: 10, running: true }), row('s-2', { updatedAt: 20 })]
    await control.snapshot()

    const status = await nextFrame(iterator)
    expect(status).toEqual({ kind: 'status', key: 'alpha:s-1', running: true })
    const change = await nextFrame(iterator)
    expect(change).toEqual({ kind: 'change', key: 'alpha:s-2', change: 'added' })

    controller.abort()
    await control.dispose()
  })

  it('reports a failed probe as states + tree and a recovery the same way', async () => {
    vi.useFakeTimers()
    const state: FakeState = {
      rows: [row('s-1')],
      reachability: 'connected',
      error: undefined,
      failWith: undefined,
      disposed: false,
    }
    const upstream = fakeUpstream(state)
    const { control, connections } = bench(async () => upstream)
    await connections.connect()

    const controller = new AbortController()
    const iterator = control.events(controller.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)

    // Probe failure: connected → unreachable with a reason.
    state.failWith = 'probe timeout'
    await control.snapshot()

    const down = await nextFrame(iterator)
    expect(down).toEqual({
      kind: 'states',
      states: [{ instanceId: 'alpha', state: 'unreachable', error: 'probe timeout' }],
    })
    const downTree = await nextFrame(iterator)
    expect(downTree.kind).toBe('tree')
    if (downTree.kind !== 'tree') throw new Error('unreachable')
    expect(downTree.tree[0]?.state).toBe('unreachable')

    // The instance recovers on its next read without a reconnect: unreachable
    // → connected, and the tree brings its rows back.
    state.failWith = undefined
    await control.snapshot()

    const up = await nextFrame(iterator)
    expect(up).toEqual({ kind: 'states', states: [{ instanceId: 'alpha', state: 'connected' }] })
    const upTree = await nextFrame(iterator)
    expect(upTree.kind).toBe('tree')
    if (upTree.kind !== 'tree') throw new Error('unreachable')
    expect(upTree.tree[0]?.state).toBe('connected')
    expect(upTree.tree[0]?.sessionCount).toBe(1)

    controller.abort()
    await control.dispose()
  })

  it('reports a failed reconnect as a states frame and a successful one after it', async () => {
    vi.useFakeTimers()
    let failConnect = true
    const state: FakeState = {
      rows: [row('s-1')],
      reachability: 'connected',
      error: undefined,
      failWith: undefined,
      disposed: false,
    }
    const upstream = fakeUpstream(state)
    const { control, connections } = bench(async () => {
      if (failConnect) throw new Error('connect refused')
      return upstream
    })
    await connections.connect()

    const controller = new AbortController()
    const iterator = control.events(controller.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)

    failConnect = false
    await control.reconnect({ instanceId: 'alpha' })

    const up = await nextFrame(iterator)
    expect(up).toEqual({ kind: 'states', states: [{ instanceId: 'alpha', state: 'connected' }] })
    const tree = await nextFrame(iterator)
    expect(tree.kind).toBe('tree')
    if (tree.kind !== 'tree') throw new Error('unreachable')
    expect(tree.tree[0]?.sessionCount).toBe(1)

    controller.abort()
    await control.dispose()
  })

  it('publishes a states frame when a background recover succeeds without a snapshot', async () => {
    vi.useFakeTimers()
    let refuse = true
    const state: FakeState = {
      rows: [row('s-1')],
      reachability: 'connected',
      error: undefined,
      failWith: undefined,
      disposed: false,
    }
    const upstream = fakeUpstream(state)
    const { control, connections } = bench(async () => {
      if (refuse) throw new Error('connect refused')
      return upstream
    })
    await connections.connect()

    const controller = new AbortController()
    const iterator = control.events(controller.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)

    // The 2s loop cannot retry before the 5s throttle allows it, so no frame
    // for the first ticks.
    refuse = false
    await vi.advanceTimersByTimeAsync(5_000)

    // The retry an unreachable instance gets on its own (no snapshot call, no
    // sidebar poll) has to reach the wire as `states` + a fresh tree.
    connections.recover()
    expect(await nextFrame(iterator)).toEqual({
      kind: 'states',
      states: [{ instanceId: 'alpha', state: 'connected' }],
    })
    const tree = await nextFrame(iterator)
    expect(tree.kind).toBe('tree')
    if (tree.kind !== 'tree') throw new Error('unreachable')
    expect(tree.tree[0]?.sessionCount).toBe(1)

    controller.abort()
    await control.dispose()
  })

  it('closes live subscribers on dispose', async () => {
    vi.useFakeTimers()
    const state: FakeState = {
      rows: [],
      reachability: 'connected',
      error: undefined,
      failWith: undefined,
      disposed: false,
    }
    const { control, connections } = bench(async () => fakeUpstream(state))
    await connections.connect()

    const iterator = control.events(new AbortController().signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)

    await control.dispose()
    expect((await iterator.next()).done).toBe(true)
    expect(state.disposed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 6 — the generated schema publishes the stream endpoint
// ---------------------------------------------------------------------------
describe('t100642 / controlPlane/events schema', () => {
  it('declares the endpoint as a stream with cancellation', () => {
    const method = TYPERT_REMOTE.methods['controlPlane/events']
    expect(method.mode).toBe('stream')
    expect(method.cancellation?.parameter).toBe('signal')
  })

  it('writes the event union into the generated artifact', () => {
    const artifact = readFileSync(
      resolve(process.cwd(), 'packages/control/control-plane/lib/typert.remote-client.d.ts'),
      'utf8',
    )
    expect(artifact).toContain("'controlPlane/events'")
    expect(artifact).toContain('ControlPlaneEvent')
  })
})
