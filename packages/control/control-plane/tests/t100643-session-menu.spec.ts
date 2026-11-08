/**
 * t100643 — pin/archive facts for federated session rows.
 *
 * The sidebar can run the official Session menu on a row only if the control
 * plane tells it (a) that the Session is pinned/archived on its owning
 * instance, and (b) that the two flags changed even though `updatedAt` did not.
 * A title rename has the same "no timestamp moves" shape. This file covers the
 * three seams that carry those facts: the `workspace/follow` fold, the row
 * projection, and the tree/diff pass the sidebar reads.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedInstance } from '../src/config.ts'
import { InstanceConnections, type InstanceConnection, type OpenUpstream } from '../src/connections.ts'
import { ControlPlane } from '../src/index.ts'
import { buildTree } from '../src/tree.ts'
import type { SessionRow, UpstreamState } from '../src/types.ts'
import { applyWorkspaceFrame, drainWorkspaceSets, toSessionRow, type RawSummary, type WorkspaceFollowFrame } from '../src/upstream.ts'

const INSTANCES: readonly ResolvedInstance[] = [
  { id: 'alpha', name: 'Alpha', host: '127.0.0.1', port: 1, baseUrl: 'http://127.0.0.1:1' },
]

/** One upstream summary with the fields the instance always reports. */
function summary(overrides: Partial<RawSummary> = {}): RawSummary {
  return { sessionId: 's-1', cwd: '/repo', updatedAt: 1, running: false, agentAvailable: true, ...overrides }
}

/** One session row the sidebar would render. */
function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return { sessionId: 's-1', cwd: '/repo', updatedAt: 1, running: false, ...overrides }
}

describe('t100643 / toSessionRow owner facts', () => {
  it('marks the row from the owner sets and omits a false fact', () => {
    expect(toSessionRow(summary(), new Set(['s-1']), new Set(['s-1']))).toEqual({
      sessionId: 's-1',
      cwd: '/repo',
      updatedAt: 1,
      running: false,
      agentAvailable: true,
      pinned: true,
      archived: true,
    })
    expect(toSessionRow(summary(), new Set(), new Set())).not.toHaveProperty('pinned')
    expect(toSessionRow(summary(), new Set(), new Set())).not.toHaveProperty('archived')
  })

  it("matches the owner's id shape, not a neighbouring session", () => {
    const pinnedRow = toSessionRow(summary({ sessionId: 's-1' }), new Set(['s-10']), new Set())
    expect(pinnedRow).not.toHaveProperty('pinned')
  })
})

describe('t100643 / applyWorkspaceFrame', () => {
  it('replaces both sets from a baseline and from a replace', () => {
    const archived = new Set(['old'])
    const pinned = new Set(['old'])
    applyWorkspaceFrame({
      type: 'baseline',
      value: { archivedSessionIds: ['a'], pinnedSessionIds: ['p'] },
    }, archived, pinned)
    expect([...archived]).toEqual(['a'])
    expect([...pinned]).toEqual(['p'])

    applyWorkspaceFrame({
      type: 'replace',
      value: { archivedSessionIds: ['b'], pinnedSessionIds: [] },
    }, archived, pinned)
    expect([...archived]).toEqual(['b'])
    expect([...pinned]).toEqual([])
  })

  it('replaces only the set the increment names', () => {
    const archived = new Set(['a'])
    const pinned = new Set(['p'])
    applyWorkspaceFrame({ type: 'archived', archivedSessionIds: ['b'] }, archived, pinned)
    expect([...archived]).toEqual(['b'])
    expect([...pinned]).toEqual(['p'])

    applyWorkspaceFrame({ type: 'pinned', pinnedSessionIds: ['q', 'r'] }, archived, pinned)
    expect([...archived]).toEqual(['b'])
    expect([...pinned]).toEqual(['q', 'r'])
  })

  it('ignores a frame that carries neither set', () => {
    const archived = new Set(['a'])
    const pinned = new Set(['p'])
    applyWorkspaceFrame({ type: 'upsert' }, archived, pinned)
    applyWorkspaceFrame({ type: 'remove' }, archived, pinned)
    applyWorkspaceFrame({ type: 'order' }, archived, pinned)
    expect([...archived]).toEqual(['a'])
    expect([...pinned]).toEqual(['p'])
  })

  it('treats a missing id list as an empty set', () => {
    const archived = new Set(['a'])
    const pinned = new Set(['p'])
    applyWorkspaceFrame({ type: 'baseline', value: {} }, archived, pinned)
    expect(archived.size).toBe(0)
    expect(pinned.size).toBe(0)
  })
})

describe('t100643 / drainWorkspaceSets', () => {
  it('folds a whole generation in order and ends with the last frame', async () => {
    async function* frames(): AsyncGenerator<WorkspaceFollowFrame> {
      yield { type: 'baseline', value: { archivedSessionIds: ['a'], pinnedSessionIds: ['p'] } }
      yield { type: 'pinned', pinnedSessionIds: ['q'] }
      yield { type: 'archived', archivedSessionIds: [] }
      yield { type: 'upsert' }
    }
    const archived = new Set<string>()
    const pinned = new Set<string>()

    await drainWorkspaceSets(frames(), archived, pinned)

    expect([...archived]).toEqual([])
    expect([...pinned]).toEqual(['q'])
  })
})

describe('t100643 / tree drops archived rows', () => {
  it('keeps a pinned row and removes an archived one, counts included', () => {
    const tree = buildTree(INSTANCES, new Map([['alpha', [
      row({ sessionId: 's-1', pinned: true }),
      row({ sessionId: 's-2', archived: true }),
    ]]]), { alpha: { state: 'connected' } })

    expect(tree[0]?.sessionCount).toBe(1)
    expect(tree[0]?.workspaces[0]?.sessions.map(node => node.key)).toEqual(['alpha:s-1'])
    expect(tree[0]?.workspaces[0]?.sessions[0]?.pinned).toBe(true)
  })

  it('floats a pinned Session above newer unpinned ones', () => {
    const tree = buildTree(INSTANCES, new Map([['alpha', [
      row({ sessionId: 'new', updatedAt: 30 }),
      row({ sessionId: 'old-pinned', updatedAt: 10, pinned: true }),
      row({ sessionId: 'middle', updatedAt: 20 }),
    ]]]), { alpha: { state: 'connected' } })

    expect(tree[0]?.workspaces[0]?.sessions.map(node => node.sessionId))
      .toEqual(['old-pinned', 'new', 'middle'])
  })
})

// ---------------------------------------------------------------------------
// diff pass: a title/pin/archive flip reaches the sidebar without `updatedAt`
// ---------------------------------------------------------------------------

interface FakeState {
  rows: readonly SessionRow[]
  reachability: UpstreamState
  error: string | undefined
  failWith: string | undefined
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
    async dispose(): Promise<void> {},
  }
}

/** Read one Context member without leaking `any` into the proxy handler. */
function readMember(target: Context, property: PropertyKey, receiver: unknown): unknown {
  return Reflect.get(target, property, receiver)
}

/**
 * A ControlPlane whose dial-out effect is stubbed and whose registry uses
 * injected connections.
 * @param open - the connection seam.
 * @returns the control plane plus its registry.
 */
function bench(open: OpenUpstream): { control: ControlPlane; connections: InstanceConnections } {
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
  Object.assign(control, { connections })
  return { control, connections }
}

describe('t100643 / visible-state diffs', () => {
  it('announces rename, pin, and archive flips and drops the archived row from the tree', async () => {
    const state: FakeState = { rows: [row({ title: 'Old' })], reachability: 'connected', error: undefined, failWith: undefined }
    const { control, connections } = bench(async () => fakeUpstream(state))
    await connections.connect()

    const changes: [string, string][] = []
    control.onSessionChange((key, kind) => { changes.push([key, kind]) })

    await control.snapshot()
    changes.length = 0

    state.rows = [row({ title: 'New' })]
    expect(await control.snapshot()).not.toBeUndefined()
    expect(changes).toEqual([['alpha:s-1', 'updated']])
    changes.length = 0

    state.rows = [row({ title: 'New', pinned: true })]
    await control.snapshot()
    expect(changes).toEqual([['alpha:s-1', 'updated']])
    changes.length = 0

    state.rows = [row({ title: 'New', archived: true })]
    const archivedTree = await control.snapshot()
    expect(changes).toEqual([['alpha:s-1', 'updated']])
    expect(archivedTree[0]?.sessionCount).toBe(0)
    expect(archivedTree[0]?.workspaces).toEqual([])
    changes.length = 0

    state.rows = [row({ title: 'New' })]
    const restored = await control.snapshot()
    expect(changes).toEqual([['alpha:s-1', 'updated']])
    expect(restored[0]?.sessionCount).toBe(1)

    await control.dispose()
  })

  it('does not wake the sidebar when every visible fact is unchanged', async () => {
    const state: FakeState = { rows: [row({ title: 'Same', pinned: true })], reachability: 'connected', error: undefined, failWith: undefined }
    const { control, connections } = bench(async () => fakeUpstream(state))
    await connections.connect()
    await control.snapshot()

    const listener = vi.fn()
    control.onSessionChange(listener)
    await control.snapshot()

    expect(listener).not.toHaveBeenCalled()
    await control.dispose()
  })
})
