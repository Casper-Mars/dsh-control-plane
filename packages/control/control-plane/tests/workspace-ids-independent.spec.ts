/**
 * Independent adversarial pass over Workspace-id propagation (control plane).
 *
 * Deliberately not a copy of `workspace-ids.spec.ts`: every case here starts
 * from a different seam or races a different pair of events.
 *
 * Covered:
 *  A. the real generated `workspace/follow` codec decodes a wire baseline /
 *     upsert / remove and the folded mapping is usable (and the id really is a
 *     runtime `string`, not a branded object);
 *  B. the generated codec's strictness on a Host that omits `items` (the
 *     compatibility boundary the fold-level guard can reach);
 *  C. `Upstream.awaitWorkspaceIds` — late baseline, timeout bookkeeping,
 *     generation failure, mount failure, and dispose while parked;
 *  D. `ControlPlane`: a failed session read still parks the compose on the
 *     Workspace wait (the suspected 1.5s white wait), a baseline that lands
 *     while the opening tree composes, a late baseline next to a reachability
 *     change, and a subscriber that aborts mid-compose.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TYPERT_REMOTE as WORKSPACE_REMOTE } from '@deepseek-ai/dsh-api-workspace-controller/remote'
import type { ResolvedInstance } from '../src/config.ts'
import { InstanceConnections, type InstanceConnection, type OpenUpstream } from '../src/connections.ts'
import { ControlPlane } from '../src/index.ts'
import { buildTree } from '../src/tree.ts'
import {
  applyWorkspaceFrame, Upstream, type WorkspaceFollowFrame,
} from '../src/upstream.ts'
import type { ControlPlaneEvent, InstanceNode, SessionRow, UpstreamState } from '../src/types.ts'

const INSTANCES: readonly ResolvedInstance[] = [
  { id: 'alpha', name: 'Alpha', host: '127.0.0.1', port: 1, baseUrl: 'http://127.0.0.1:1' },
  { id: 'beta', name: 'Beta', host: '127.0.0.1', port: 2, baseUrl: 'http://127.0.0.1:2' },
]

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'

function row(sessionId: string, cwd?: string): SessionRow {
  return {
    sessionId,
    updatedAt: 1,
    running: false,
    ...(cwd === undefined ? {} : { cwd }),
  }
}

interface GeneratedCodec { readonly parse: (value: unknown) => unknown }

/**
 * The `workspace/follow` result codec the control plane decodes upstream
 * frames with, read structurally from the generated artifact.
 * @returns the codec.
 */
function followCodec(): GeneratedCodec {
  const spec = Reflect.get(WORKSPACE_REMOTE, 'spec') as {
    methods?: Readonly<Record<string, { result: { create: () => GeneratedCodec } }>>
  } | undefined
  const codec = spec?.methods?.['workspace/follow']?.result.create()
  if (codec === undefined) throw new Error('the generated workspace/follow codec is missing')
  return codec
}

/** One wire Workspace row exactly as the Host's encoder emits it. */
function wireWorkspace(workspaceId: string, path: string): Record<string, unknown> {
  return {
    workspaceId,
    path,
    title: path,
    sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// A. real generated codec → fold
// ---------------------------------------------------------------------------

describe('A. generated workspace/follow wire → path/id mapping', () => {
  it('decodes a baseline, an upsert and a remove into the same map', () => {
    const codec = followCodec()
    const map = new Map<string, string>()
    const archived = new Set<string>()
    const pinned = new Set<string>()

    const baseline = codec.parse({
      type: 'baseline',
      value: {
        items: [wireWorkspace(UUID, '/repo')],
        archivedSessionIds: ['s-archived'],
        pinnedSessionIds: ['s-pinned'],
      },
    })
    const items = Reflect.get(baseline as object, 'value') as { items: readonly { workspaceId: unknown }[] }
    // The branded `WorkspaceId` is a plain runtime string on the wire.
    expect(typeof items.items[0]?.workspaceId).toBe('string')
    expect(items.items[0]?.workspaceId).toBe(UUID)

    expect(applyWorkspaceFrame(baseline as WorkspaceFollowFrame, archived, pinned, map)).toBe(true)
    expect(map.get('/repo')).toBe(UUID)
    // Pin/archive folded by the same call, unchanged by the id work.
    expect([...archived]).toEqual(['s-archived'])
    expect([...pinned]).toEqual(['s-pinned'])
    // The id itself is a UUID, not the path used as identity before the fix.
    expect(map.get('/repo')).not.toBe('/repo')

    const upsert = codec.parse({ type: 'upsert', workspace: wireWorkspace(UUID, '/repo-renamed') })
    expect(applyWorkspaceFrame(upsert as WorkspaceFollowFrame, archived, pinned, map)).toBe(true)
    // Same id under a new path: the old path is gone.
    expect([...map]).toEqual([['/repo-renamed', UUID]])

    const remove = codec.parse({ type: 'remove', workspaceId: UUID })
    expect(applyWorkspaceFrame(remove as WorkspaceFollowFrame, archived, pinned, map)).toBe(true)
    expect(map.size).toBe(0)
  })

  it('never stamps the placeholder or a cwd the owner did not register', () => {
    const rows: SessionRow[] = [row('s-repo', '/repo'), row('s-unknown', '/unknown'), row('s-none')]
    const [group] = buildTree(
      [INSTANCES[0]!],
      new Map([['alpha', rows]]),
      {},
      new Map([['alpha', new Map([['/repo', UUID]])]]),
    )
    const byPath = new Map((group?.workspaces ?? []).map(entry => [entry.path, entry]))
    expect(byPath.get('/repo')?.workspaceId).toBe(UUID)
    expect(byPath.get('/unknown')).not.toHaveProperty('workspaceId')
    expect(byPath.get('(no workspace)')).not.toHaveProperty('workspaceId')
  })

  it('keeps pinned-first ordering and drops archived rows while stamping the id', () => {
    const rows: SessionRow[] = [
      { sessionId: 's-archived', cwd: '/repo', updatedAt: 9, running: false, archived: true },
      { sessionId: 's-plain', cwd: '/repo', updatedAt: 5, running: false },
      { sessionId: 's-pinned', cwd: '/repo', updatedAt: 1, running: false, pinned: true },
    ]
    const [group] = buildTree(
      [INSTANCES[0]!],
      new Map([['alpha', rows]]),
      {},
      new Map([['alpha', new Map([['/repo', UUID]])]]),
    )
    const [workspaceNode] = group?.workspaces ?? []
    expect(workspaceNode?.workspaceId).toBe(UUID)
    expect(workspaceNode?.sessions.map(session => session.sessionId)).toEqual(['s-pinned', 's-plain'])
    expect(group?.sessionCount).toBe(2)
  })

  it('replaces the mapping from a decoded replace frame', () => {
    const map = new Map([['/stale', 'ws-stale']])
    const decoded = followCodec().parse({
      type: 'replace',
      value: {
        items: [wireWorkspace('ws-2', '/a'), wireWorkspace('ws-3', '/b')],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
    })
    expect(applyWorkspaceFrame(decoded as WorkspaceFollowFrame, new Set(), new Set(), map)).toBe(true)
    expect([...map]).toEqual([['/a', 'ws-2'], ['/b', 'ws-3']])
  })
})

describe('B. generated codec compatibility boundary', () => {
  it('rejects a wire baseline that omits items (the fold guard is not reachable on the wire)', () => {
    // The fold keeps an existing map when `items` is absent, but a frame from
    // an older Host first has to survive this codec. Pinning the boundary is
    // the point: the compatibility guard protects the fold, not the stream.
    expect(() => followCodec().parse({
      type: 'baseline',
      value: { archivedSessionIds: [], pinnedSessionIds: [] },
    })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// C. Upstream.awaitWorkspaceIds (the real implementation)
// ---------------------------------------------------------------------------

/** A follow generation whose frames the test pushes by hand. */
interface ManualFollow {
  readonly follow: (signal: AbortSignal) => AsyncIterable<WorkspaceFollowFrame>
  push(frame: WorkspaceFollowFrame): void
  fail(error: unknown): void
  end(): void
  readonly opened: number
}

function manualFollow(): ManualFollow {
  const frames: WorkspaceFollowFrame[] = []
  let wake: (() => void) | undefined
  let done = false
  let failure: unknown
  let opened = 0

  const notify = (): void => {
    const resolve = wake
    wake = undefined
    resolve?.()
  }

  const follow = (signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> => {
    opened += 1
    let closed = false
    const onAbort = (): void => { closed = true; notify() }
    signal.addEventListener('abort', onAbort, { once: true })
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (!closed) {
            const next = frames.shift()
            if (next !== undefined) {
              yield next
              continue
            }
            if (failure !== undefined) throw failure
            if (done) return
            await new Promise<void>((resolve) => { wake = resolve })
            wake = undefined
          }
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      },
    }
  }

  return {
    follow,
    push: (frame) => { frames.push(frame); notify() },
    fail: (error) => { failure = error; notify() },
    end: () => { done = true; notify() },
    get opened(): number { return opened },
  }
}

/**
 * A bare `Upstream` whose namespace mount and Remote root are test seams.
 * @param follow - the `workspace/follow` generation factory.
 * @returns the connection under test.
 */
function bareUpstream(follow: (signal: AbortSignal) => AsyncIterable<WorkspaceFollowFrame>): Upstream {
  const root = new Context()
  // The constructor is private so production always goes through `connect`;
  // this unit lane builds a bare instance and replaces the mount seams itself.
  const upstream = Reflect.construct(Upstream, [INSTANCES[0]!, root]) as Upstream
  Reflect.set(upstream, 'mountNamespace', async (): Promise<void> => {})
  Reflect.set(root, 'remote', { workspace: { follow } })
  return upstream
}

function startFollow(upstream: Upstream): Promise<void> {
  const ensure = Reflect.get(upstream, 'ensureWorkspaceSets') as () => void
  ensure.call(upstream)
  return Reflect.get(upstream, 'workspaceSets') as Promise<void>
}

function baselineFrame(items: readonly { workspaceId: string; path: string }[]): WorkspaceFollowFrame {
  return { type: 'baseline', value: { items, archivedSessionIds: [], pinnedSessionIds: [] } }
}

describe('C. Upstream.awaitWorkspaceIds', () => {
  it('returns as soon as a late baseline lands, not at the cap', async () => {
    vi.useFakeTimers()
    const follow = manualFollow()
    const upstream = bareUpstream(follow.follow)
    void startFollow(upstream)

    let settled = false
    const wait = upstream.awaitWorkspaceIds(60_000).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1_200)
    follow.push(baselineFrame([{ workspaceId: UUID, path: '/repo' }]))
    await wait
    expect(settled).toBe(true)
    expect(upstream.workspaceIdMap.get('/repo')).toBe(UUID)
    // The cap timer was cleared, so nothing is left counting down.
    expect(vi.getTimerCount()).toBe(0)
    await upstream.dispose()
  })

  it('pays the cap once and later calls return without a timer', async () => {
    vi.useFakeTimers()
    const follow = manualFollow()
    const upstream = bareUpstream(follow.follow)
    void startFollow(upstream)

    const first = upstream.awaitWorkspaceIds(1_500)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_500)
    await first
    expect(upstream.workspaceIdMap.size).toBe(0)

    const second = upstream.awaitWorkspaceIds(1_500)
    expect(vi.getTimerCount()).toBe(0)
    await second
    await upstream.dispose()
  })

  it('releases the wait when the generation dies before its baseline, keeping learned ids', async () => {
    const follow = manualFollow()
    const upstream = bareUpstream(follow.follow)
    void startFollow(upstream)

    follow.push(baselineFrame([{ workspaceId: UUID, path: '/repo' }]))
    await vi.waitFor(() => { expect(upstream.workspaceIdMap.get('/repo')).toBe(UUID) })

    // A later failure must not clear the mapping the tree already shows.
    follow.fail(new Error('generation dropped'))
    await vi.waitFor(() => {
      expect(Reflect.get(upstream, 'workspaceIdsSettled')).toBe(true)
    })
    await upstream.awaitWorkspaceIds(60_000)
    expect(upstream.workspaceIdMap.get('/repo')).toBe(UUID)
    await upstream.dispose()
  })

  it('releases a parked wait on dispose', async () => {
    const follow = manualFollow()
    const upstream = bareUpstream(follow.follow)
    void startFollow(upstream)

    let settled = false
    void upstream.awaitWorkspaceIds(600_000).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    await upstream.dispose()
    await vi.waitFor(() => { expect(settled).toBe(true) })
  })

  it('bounds the first wait even when the workspace namespace cannot mount', async () => {
    // Characterisation: a mount failure skips `settleWorkspaceIds` (its
    // `finally` starts after the mount), so the cap is what releases compose.
    // The tree is therefore delayed by up to the cap once per connection.
    vi.useFakeTimers()
    const root = new Context()
    // The constructor is private so production always goes through `connect`;
    // this unit lane builds a bare instance and replaces the mount seams itself.
    const upstream = Reflect.construct(Upstream, [INSTANCES[0]!, root]) as Upstream
    Reflect.set(upstream, 'mountNamespace', async (): Promise<void> => {
      throw new Error('gateway/method-unavailable: workspace')
    })
    Reflect.set(root, 'remote', { workspace: { follow: manualFollow().follow } })
    void startFollow(upstream)

    const wait = upstream.awaitWorkspaceIds(1_500)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_500)
    await wait
    expect(upstream.workspaceIdMap.size).toBe(0)
    await upstream.dispose()
  })
})

// ---------------------------------------------------------------------------
// D. ControlPlane compose / opening tree / late baseline
// ---------------------------------------------------------------------------

interface FakeState {
  rows: readonly SessionRow[]
  reachability: UpstreamState
}

/**
 * A structural connection whose Workspace wait the test controls.
 * @param state - session rows and reachability the probe reports.
 * @param ids - shared path → id map.
 * @param listeners - listeners the control plane registers.
 * @param gate - when given, `awaitWorkspaceIds` parks until it resolves.
 * @param log - call order sink.
 * @returns the connection face.
 */
function fakeUpstream(options: {
  readonly state: FakeState
  readonly ids: Map<string, string>
  readonly listeners: Set<() => void>
  readonly gate?: Promise<void> | undefined
  readonly log?: string[] | undefined
  readonly failList?: boolean | undefined
}): InstanceConnection {
  const { state, ids, listeners, gate, log, failList } = options
  return {
    get reachability(): UpstreamState { return state.reachability },
    error: undefined,
    async listSessions(): Promise<SessionRow[]> {
      log?.push('list')
      if (failList === true) throw new Error('instance unreachable')
      return [...state.rows]
    },
    createSession: async (): Promise<string> => 'session-new',
    onSessionStatus: (): (() => void) => () => {},
    async awaitWorkspaceIds(): Promise<void> {
      log?.push('awaitIds')
      if (gate !== undefined) await gate
    },
    get workspaceIdMap(): ReadonlyMap<string, string> { return ids },
    onWorkspaceIdsChange: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async dispose(): Promise<void> {},
  }
}

function readMember(target: Context, property: PropertyKey, receiver: unknown): unknown {
  return Reflect.get(target, property, receiver)
}

/**
 * A ControlPlane over injected connections (no dial-out).
 * @param upstreams - connections by instance id.
 * @returns the control plane and its registry.
 */
function bench(upstreams: Readonly<Record<string, InstanceConnection>>): {
  control: ControlPlane
  connections: InstanceConnections
} {
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
  const open: OpenUpstream = async (instance) => {
    const found = upstreams[instance.id]
    if (found === undefined) throw new Error(`no fixture for ${instance.id}`)
    return found
  }
  const connections = new InstanceConnections(INSTANCES, { open })
  Object.assign(control, { connections })
  return { control, connections }
}

function attachOf(control: ControlPlane): (instance: ResolvedInstance, upstream: InstanceConnection) => void {
  const observe = Reflect.get(control, 'observeUpstream') as (
    instance: ResolvedInstance, upstream: InstanceConnection,
  ) => void
  return observe.bind(control)
}

async function nextFrame(iterator: AsyncIterator<ControlPlaneEvent>): Promise<ControlPlaneEvent> {
  const result = await iterator.next()
  if (result.done === true) throw new Error('fixture: event stream ended early')
  return result.value
}

function workspaceNode(tree: readonly InstanceNode[], path: string): InstanceNode['workspaces'][number] | undefined {
  return tree[0]?.workspaces.find(workspace => workspace.path === path)
}

/** Flush pending microtasks without advancing fake timers. */
async function flush(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}

describe('D. ControlPlane compose and republish', () => {
  it('parks the compose on the Workspace wait even when the session read failed', async () => {
    vi.useFakeTimers()
    const ids = new Map<string, string>()
    const listeners = new Set<() => void>()
    const log: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const upstream = fakeUpstream({
      state: { rows: [row('s-1', '/repo')], reachability: 'unreachable' },
      ids,
      listeners,
      gate,
      log,
      failList: true,
    })
    const { control, connections } = bench({ alpha: upstream })
    await connections.connect()
    attachOf(control)(INSTANCES[0]!, upstream)

    const controller = new AbortController()
    const iterator = control.events(controller.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    let landed = false
    void pending.then(() => { landed = true })
    await flush()

    // The read failed, yet the opening tree is still held by the baseline wait.
    expect(log.slice(-2)).toEqual(['list', 'awaitIds'])
    expect(landed).toBe(false)

    release()
    await pending

    controller.abort()
    await control.dispose()
  })

  it('republishes exactly one tree for one baseline, with nothing queued behind it', async () => {
    vi.useFakeTimers()
    const ids = new Map<string, string>()
    const listeners = new Set<() => void>()
    const upstream = fakeUpstream({
      state: { rows: [row('s-1', '/repo')], reachability: 'connected' },
      ids,
      listeners,
    })
    const { control, connections } = bench({ alpha: upstream })
    await connections.connect()
    attachOf(control)(INSTANCES[0]!, upstream)

    const controller = new AbortController()
    const iterator = control.events(controller.signal)[Symbol.asyncIterator]()
    const first = await nextFrame(iterator)
    if (first.kind !== 'tree') throw new Error('the first frame must be a tree')
    expect(workspaceNode(first.tree, '/repo')).not.toHaveProperty('workspaceId')

    ids.set('/repo', UUID)
    for (const listener of [...listeners]) listener()

    const pushed = await nextFrame(iterator)
    if (pushed.kind !== 'tree') throw new Error('the republished frame must be a tree')
    expect(workspaceNode(pushed.tree, '/repo')?.workspaceId).toBe(UUID)

    let extra = false
    void iterator.next().then(() => { extra = true })
    await flush(30)
    expect(extra).toBe(false)

    controller.abort()
    await control.dispose()
  })

  it('carries the id in the opening tree when the baseline lands mid-compose', async () => {
    vi.useFakeTimers()
    const alphaIds = new Map<string, string>()
    const alphaListeners = new Set<() => void>()
    const betaIds = new Map<string, string>()
    const betaListeners = new Set<() => void>()
    let releaseBeta: () => void = () => {}
    const betaGate = new Promise<void>((resolve) => { releaseBeta = resolve })

    const alpha = fakeUpstream({
      state: { rows: [row('a-1', '/repo')], reachability: 'connected' },
      ids: alphaIds,
      listeners: alphaListeners,
    })
    const beta = fakeUpstream({
      state: { rows: [row('b-1', '/repo')], reachability: 'connected' },
      ids: betaIds,
      listeners: betaListeners,
      gate: betaGate,
    })
    const { control, connections } = bench({ alpha, beta })
    await Promise.all([connections.connect(), connections.connect()])
    attachOf(control)(INSTANCES[0]!, alpha)
    attachOf(control)(INSTANCES[1]!, beta)

    const controller = new AbortController()
    const iterator = control.events(controller.signal)[Symbol.asyncIterator]()
    const pending = nextFrame(iterator)
    await flush()

    // Alpha already passed its wait; its mapping moves while beta still holds
    // the compose open (the `composingInitial > 0` pending window).
    alphaIds.set('/repo', UUID)
    for (const listener of [...alphaListeners]) listener()

    releaseBeta()
    const first = await pending
    if (first.kind !== 'tree') throw new Error('the first frame must be a tree')
    expect(first.tree[0]?.instanceId).toBe('alpha')
    expect(workspaceNode(first.tree, '/repo')?.workspaceId).toBe(UUID)

    controller.abort()
    await control.dispose()
  })

  it('keeps a just-learned id in the tree a reachability change republishes', async () => {
    vi.useFakeTimers()
    const alphaIds = new Map<string, string>()
    const alphaListeners = new Set<() => void>()
    const betaState: FakeState = { rows: [row('b-1', '/repo')], reachability: 'connected' }
    const alpha = fakeUpstream({
      state: { rows: [row('s-1', '/repo')], reachability: 'connected' },
      ids: alphaIds,
      listeners: alphaListeners,
    })
    const beta = fakeUpstream({ state: betaState, ids: new Map(), listeners: new Set() })
    const { control, connections } = bench({ alpha, beta })
    await Promise.all([connections.connect(), connections.connect()])
    attachOf(control)(INSTANCES[0]!, alpha)
    attachOf(control)(INSTANCES[1]!, beta)

    const controller = new AbortController()
    const iterator = control.events(controller.signal)[Symbol.asyncIterator]()
    const first = await nextFrame(iterator)
    if (first.kind !== 'tree') throw new Error('the first frame must be a tree')
    expect(workspaceNode(first.tree, '/repo')).not.toHaveProperty('workspaceId')

    // Alpha's baseline and Beta's reachability move land in the same turn.
    alphaIds.set('/repo', UUID)
    for (const listener of [...alphaListeners]) listener()
    betaState.reachability = 'unreachable'
    const notify = Reflect.get(connections, 'notifyStateChange') as (() => void) | undefined
    notify?.call(connections)

    // Read until the reachability move is visible; every tree read on the way
    // must keep the id Alpha just reported. One pass may coalesce both facts.
    let sawStates = false
    let final: readonly InstanceNode[] | undefined
    for (let index = 0; index < 4; index += 1) {
      const frame = await nextFrame(iterator)
      if (frame.kind === 'states') sawStates = true
      if (frame.kind === 'tree') {
        final = frame.tree
        expect(workspaceNode(frame.tree, '/repo')?.workspaceId).toBe(UUID)
        if (frame.tree[1]?.state === 'unreachable') break
      }
    }
    expect(sawStates).toBe(true)
    expect(final?.[1]?.state).toBe('unreachable')

    controller.abort()
    await control.dispose()
  })

  it('still delivers the id-bearing tree to a subscriber that replaces one aborted mid-compose', async () => {
    vi.useFakeTimers()
    const ids = new Map<string, string>()
    const listeners = new Set<() => void>()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const upstream = fakeUpstream({
      state: { rows: [row('s-1', '/repo')], reachability: 'connected' },
      ids,
      listeners,
      gate,
    })
    const { control, connections } = bench({ alpha: upstream })
    await connections.connect()
    attachOf(control)(INSTANCES[0]!, upstream)

    // First subscriber aborts while its opening compose is parked.
    const firstController = new AbortController()
    const firstIterator = control.events(firstController.signal)[Symbol.asyncIterator]()
    void firstIterator.next()
    await flush()
    firstController.abort()
    await flush()

    // The mapping lands with no live subscriber: it must not be dropped.
    ids.set('/repo', UUID)
    for (const listener of [...listeners]) listener()
    release()
    await flush()

    const controller = new AbortController()
    const iterator = control.events(controller.signal)[Symbol.asyncIterator]()
    const frame = await nextFrame(iterator)
    if (frame.kind !== 'tree') throw new Error('the first frame must be a tree')
    expect(workspaceNode(frame.tree, '/repo')?.workspaceId).toBe(UUID)

    controller.abort()
    await control.dispose()
  })
})
