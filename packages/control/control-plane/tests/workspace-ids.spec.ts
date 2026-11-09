/**
 * Workspace identity through the control plane.
 *
 * The sidebar creates a Session with a Workspace **id**, never with the path it
 * grouped a row under: the owner's registry is keyed by `randomUUID`, and a
 * path is rejected as `workspace/not-found` (the bug this suite pins). Three
 * seams cooperate:
 *
 * 1. `applyWorkspaceFrame` folds the `workspace/follow` baseline/upsert/remove
 *    frames into a `path → workspaceId` map.
 * 2. `buildTree` stamps that id onto the workspace row, leaving the
 *    `(no workspace)` placeholder and paths the owner never registered blank.
 * 3. `ControlPlane.events()` republishes the tree when a baseline arrives
 *    after the opening frame, so the "+" control appears without a poll.
 *
 * No network: the connection registry is replaced with an injected `open`, as
 * in `t100642-events`.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedInstance } from '../src/config.ts'
import { InstanceConnections, type InstanceConnection, type OpenUpstream } from '../src/connections.ts'
import { ControlPlane } from '../src/index.ts'
import { buildTree, NO_WORKSPACE } from '../src/tree.ts'
import type { ControlPlaneEvent, InstanceNode, SessionRow, UpstreamState } from '../src/types.ts'
import {
  applyWorkspaceFrame, type WorkspaceFollowFrame, type WorkspaceFrameItem,
} from '../src/upstream.ts'
import { TYPERT_REMOTE } from '../lib/typert.remote-client.js'

const INSTANCES: readonly ResolvedInstance[] = [
  { id: 'alpha', name: 'Alpha', host: '127.0.0.1', port: 1, baseUrl: 'http://127.0.0.1:1' },
]

function row(sessionId: string, cwd?: string): SessionRow {
  return {
    sessionId,
    updatedAt: 1,
    running: false,
    ...(cwd === undefined ? {} : { cwd }),
  }
}

function baseline(items: readonly WorkspaceFrameItem[]): WorkspaceFollowFrame {
  return { type: 'baseline', value: { items, archivedSessionIds: [], pinnedSessionIds: [] } }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('buildTree workspace ids', () => {
  it('stamps the registered id and leaves unknown paths and the placeholder blank', () => {
    const rows = [row('s-repo', '/repo'), row('s-other', '/other'), row('s-none')]
    const [group] = buildTree(
      INSTANCES,
      new Map([['alpha', rows]]),
      {},
      new Map([['alpha', new Map([['/repo', 'ws-1']])]]),
    )
    const byPath = new Map((group?.workspaces ?? []).map(workspace => [workspace.path, workspace]))
    expect(byPath.get('/repo')?.workspaceId).toBe('ws-1')
    expect(byPath.get('/other')).not.toHaveProperty('workspaceId')
    expect(byPath.get(NO_WORKSPACE)).not.toHaveProperty('workspaceId')
  })

  it('omits the id entirely when no mapping was supplied', () => {
    const [group] = buildTree(INSTANCES, new Map([['alpha', [row('s-1', '/repo')]]]))
    expect(group?.workspaces[0]).not.toHaveProperty('workspaceId')
  })
})

/** The generated tree result codec's runtime face. */
interface GeneratedCodec { readonly parse: (value: unknown) => unknown }

/**
 * The tree result codec the browser uses, read structurally from the generated
 * artifact (its exported type is opaque by design).
 * @returns the codec, or undefined when the artifact predates the method.
 */
function treeCodec(): GeneratedCodec | undefined {
  const spec = Reflect.get(TYPERT_REMOTE, 'spec') as {
    methods?: Readonly<Record<string, { result: { create: () => GeneratedCodec } }>>
  } | undefined
  return spec?.methods?.['controlPlane/tree']?.result.create()
}

describe('generated tree codec', () => {
  it('keeps workspaceId through the browser-side decode', () => {
    const codec = treeCodec()
    if (codec === undefined) throw new Error('the generated controlPlane/tree codec is missing')
    const decoded = codec.parse([{
      instanceId: 'alpha',
      label: 'Alpha(alpha)',
      state: 'connected',
      runningCount: 0,
      sessionCount: 1,
      workspaces: [{
        key: 'alpha:/repo',
        path: '/repo',
        workspaceId: 'ws-1',
        runningCount: 0,
        latestUpdatedAt: 1,
        sessions: [{
          key: 'alpha:s-1', instanceId: 'alpha', sessionId: 's-1', updatedAt: 1, running: false,
        }],
      }],
    }]) as readonly { workspaces: readonly { workspaceId?: string }[] }[]
    expect(decoded[0]?.workspaces[0]?.workspaceId).toBe('ws-1')
  })
})

describe('applyWorkspaceFrame workspace ids', () => {
  it('rebuilds the whole map from a baseline and a replace', () => {
    const ids = new Map([['/old', 'ws-old']])
    expect(applyWorkspaceFrame(baseline([{ path: '/repo', workspaceId: 'ws-1' }]), new Set(), new Set(), ids))
      .toBe(true)
    expect([...ids]).toEqual([['/repo', 'ws-1']])

    const replace: WorkspaceFollowFrame = {
      type: 'replace',
      value: { items: [{ path: '/repo', workspaceId: 'ws-2' }], archivedSessionIds: [], pinnedSessionIds: [] },
    }
    expect(applyWorkspaceFrame(replace, new Set(), new Set(), ids)).toBe(true)
    expect([...ids]).toEqual([['/repo', 'ws-2']])

    expect(applyWorkspaceFrame(baseline([]), new Set(), new Set(), ids)).toBe(true)
    expect(ids.size).toBe(0)
  })

  it('treats an identical baseline as unchanged', () => {
    const ids = new Map([['/repo', 'ws-1']])
    expect(applyWorkspaceFrame(baseline([{ path: '/repo', workspaceId: 'ws-1' }]), new Set(), new Set(), ids))
      .toBe(false)
  })

  it('upserts one row without duplicating its id under another path', () => {
    const ids = new Map([['/repo', 'ws-1'], ['/moved', 'ws-2']])
    expect(applyWorkspaceFrame({ type: 'upsert', workspace: { path: '/repo', workspaceId: 'ws-1' } }, new Set(), new Set(), ids))
      .toBe(false)
    expect(applyWorkspaceFrame({ type: 'upsert', workspace: { path: '/new', workspaceId: 'ws-2' } }, new Set(), new Set(), ids))
      .toBe(true)
    expect([...ids]).toEqual([['/repo', 'ws-1'], ['/new', 'ws-2']])
  })

  it('removes by id and ignores frames that carry neither field', () => {
    const ids = new Map([['/repo', 'ws-1'], ['/other', 'ws-2']])
    expect(applyWorkspaceFrame({ type: 'remove', workspaceId: 'ws-1' }, new Set(), new Set(), ids)).toBe(true)
    expect([...ids]).toEqual([['/other', 'ws-2']])
    expect(applyWorkspaceFrame({ type: 'remove' }, new Set(), new Set(), ids)).toBe(false)
    expect(applyWorkspaceFrame({ type: 'upsert' }, new Set(), new Set(), ids)).toBe(false)
    expect([...ids]).toEqual([['/other', 'ws-2']])
  })

  it('keeps the map when an older Host replacement carries no items', () => {
    const ids = new Map([['/repo', 'ws-1']])
    expect(applyWorkspaceFrame({ type: 'replace', value: {} }, new Set(), new Set(), ids)).toBe(false)
    expect([...ids]).toEqual([['/repo', 'ws-1']])
  })

  it('maintains the pin and archive sets exactly as before', () => {
    const archived = new Set(['a'])
    const pinned = new Set(['p'])
    applyWorkspaceFrame({
      type: 'baseline',
      value: { items: [], archivedSessionIds: ['b'], pinnedSessionIds: ['q'] },
    }, archived, pinned, new Map())
    expect([...archived]).toEqual(['b'])
    expect([...pinned]).toEqual(['q'])
  })
})

// ---------------------------------------------------------------------------
// ControlPlane: the opening tree and a late baseline
// ---------------------------------------------------------------------------

interface FakeState {
  rows: readonly SessionRow[]
  reachability: UpstreamState
}

/**
 * A fake upstream that learns Workspace ids through a listener, the way the
 * real one learns them from `workspace/follow`.
 * @param state - rows and reachability the probe reports.
 * @param ids - the shared path → id map (mutated by the test).
 * @param listeners - change listeners registered through the connection.
 * @param beforeCompose - optional hook run by `awaitWorkspaceIds`.
 * @returns the structural connection face.
 */
function workspaceUpstream(
  state: FakeState,
  ids: Map<string, string>,
  listeners: Set<() => void>,
  beforeCompose: () => void = () => {},
): InstanceConnection {
  return {
    get reachability(): UpstreamState { return state.reachability },
    error: undefined,
    async listSessions(): Promise<SessionRow[]> { return [...state.rows] },
    createSession: async (): Promise<string> => 'session-new',
    onSessionStatus: (): (() => void) => () => {},
    async awaitWorkspaceIds(): Promise<void> { beforeCompose() },
    get workspaceIdMap(): ReadonlyMap<string, string> { return ids },
    onWorkspaceIdsChange: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async dispose(): Promise<void> {},
  }
}

/** Read one Context member without leaking its `any` into the proxy handler. */
function readMember(target: Context, property: PropertyKey, receiver: unknown): unknown {
  return Reflect.get(target, property, receiver)
}

/**
 * A ControlPlane whose dial-out effect is stubbed and whose registry carries
 * an injected fake connection.
 * @param upstream - the fake connection `connect()` returns.
 * @returns the control plane and its registry.
 */
function bench(upstream: InstanceConnection): { control: ControlPlane; connections: InstanceConnections } {
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
  const open: OpenUpstream = async () => upstream
  const connections = new InstanceConnections(INSTANCES, { open })
  Object.assign(control, { connections })
  return { control, connections }
}

/** The private attach seam, so the listener wiring is the production one. */
function attachOf(control: ControlPlane): (instance: ResolvedInstance, upstream: InstanceConnection) => void {
  const observe = Reflect.get(control, 'observeUpstream') as (
    instance: ResolvedInstance, upstream: InstanceConnection,
  ) => void
  return observe.bind(control)
}

/** Pull one frame, failing loudly when the stream ended early. */
async function nextFrame(iterator: AsyncIterator<ControlPlaneEvent>): Promise<ControlPlaneEvent> {
  const result = await iterator.next()
  if (result.done === true) throw new Error('fixture: event stream ended early')
  return result.value
}

/** The workspace node the assertions read. */
function workspaceNode(tree: readonly InstanceNode[], path: string): InstanceNode['workspaces'][number] | undefined {
  return tree[0]?.workspaces.find(workspace => workspace.path === path)
}

describe('ControlPlane workspace ids', () => {
  it('names the id in the opening tree when the baseline is ready in time', async () => {
    vi.useFakeTimers()
    const ids = new Map<string, string>()
    const listeners = new Set<() => void>()
    const upstream = workspaceUpstream(
      { rows: [row('s-1', '/repo')], reachability: 'connected' },
      ids,
      listeners,
      () => { ids.set('/repo', 'ws-1') },
    )
    const { control, connections } = bench(upstream)
    await connections.connect()
    attachOf(control)(INSTANCES[0]!, upstream)

    const controller = new AbortController()
    const iterator = control.events(controller.signal)[Symbol.asyncIterator]()
    const first = await nextFrame(iterator)
    if (first.kind !== 'tree') throw new Error('the first frame must be a tree')
    expect(workspaceNode(first.tree, '/repo')?.workspaceId).toBe('ws-1')

    controller.abort()
    await control.dispose()
  })

  it('republishes the tree when the baseline arrives after the opening frame', async () => {
    vi.useFakeTimers()
    const ids = new Map<string, string>()
    const listeners = new Set<() => void>()
    const upstream = workspaceUpstream(
      { rows: [row('s-1', '/repo')], reachability: 'connected' },
      ids,
      listeners,
    )
    const { control, connections } = bench(upstream)
    await connections.connect()
    attachOf(control)(INSTANCES[0]!, upstream)

    const controller = new AbortController()
    const iterator = control.events(controller.signal)[Symbol.asyncIterator]()
    const first = await nextFrame(iterator)
    if (first.kind !== 'tree') throw new Error('the first frame must be a tree')
    // The stream opened before the owner answered: no create control yet.
    expect(workspaceNode(first.tree, '/repo')).not.toHaveProperty('workspaceId')

    // The generation's baseline lands on the connection.
    ids.set('/repo', 'ws-1')
    for (const listener of [...listeners]) listener()

    // No snapshot call, no poll: the change itself forces one tree frame.
    const pushed = await nextFrame(iterator)
    if (pushed.kind !== 'tree') throw new Error(`expected a tree, got ${pushed.kind}`)
    expect(workspaceNode(pushed.tree, '/repo')?.workspaceId).toBe('ws-1')
    expect(pushed.tree[0]?.sessionCount).toBe(1)

    controller.abort()
    await control.dispose()
  })
})
