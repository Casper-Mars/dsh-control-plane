/**
 * t100638 tester — federated Session selection through the real navigation service.
 *
 * The Developer cases use a FakeSessions double. These run the real
 * `UiWorkspaceService` on top of a real `ClientSessions` fed by the Remote
 * mock, so the chain under test is exactly the production one:
 * `openSession` → `retain` → `Session.open` → first Session RPC → Gateway
 * federation router. Persistence and blank-reuse cases assert that the local
 * paths keep their old behaviour.
 */

import { Context } from '@deepseek-ai/cordis'
import { setImmediate } from 'node:timers/promises'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, describe, expect, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/client'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import type { ClientRemote, DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  IWorkspaces, WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { SessionId, type SessionId as SessionIdType } from '@deepseek-ai/dsh-session/types'
import { resolveFederationTarget } from '@deepseek-ai/dsh-api-gateway'
import { ClientSessions } from '@deepseek-ai/dsh-api-session-controller/src/client/sessions/service.ts'
import type { SessionFollowRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import type { TestClient } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { UiWorkspaceService } from '../src/client/navigation.ts'
import { en, zh } from '../src/client/locales.ts'
import { createWorkspaceViewStore } from '../src/client/stores.ts'
import { FOLLOW, sessionWorld } from '../../../api/session-controller/tests/remote/session.client.ts'

const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-api-gateway']) })

const sid = (id: string): SessionIdType => SessionId(id)
const wid = (id: string): WorkspaceId => id as WorkspaceId

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function persistSelection(selection: { readonly sessionId?: SessionIdType }): Map<string, string> {
  const backing = new Map([['dsh.sessions.current', JSON.stringify(selection)]])
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value) },
    removeItem: (key: string) => { backing.delete(key) },
  })
  return backing
}

function workspace(id: string, sessionIds: readonly SessionIdType[] = []): WorkspaceView {
  return {
    workspaceId: wid(id),
    path: `/w/${id}`,
    title: id,
    sessionIds,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/** One wire-shaped `session/list` row. */
function summary(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentAvailable: false,
    formatStatus: 'current',
    sessionId: id,
    updatedAt: 1,
    running: false,
    blank: false,
    cwd: '/w/one',
    title: id,
    ...overrides,
  }
}

function workspaceState(items: WorkspaceView[] = [], phase: WorkspaceSnapshot['phase'] = 'ready'): WorkspaceSnapshot {
  return {
    items,
    archivedSessionIds: [],
    pinnedSessionIds: [],
    phase,
    state: phase === 'ready' ? 'idle' : 'loading',
    error: null,
  }
}

class MutableSource<T> {
  private readonly listeners = new Set<() => void>()

  constructor(private value: T) {}

  getSnapshot(): T {
    return this.value
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

/** The Workspace side of navigation; every member is inert unless a case scripts it. */
class FakeWorkspaces implements IWorkspaces {
  readonly list: MutableSource<WorkspaceSnapshot>
  readonly initializeDefault = vi.fn(async (_signal?: AbortSignal): Promise<WorkspaceView | undefined> => undefined)

  constructor(initial: WorkspaceSnapshot) {
    this.list = new MutableSource(initial)
  }

  async create(): Promise<WorkspaceView> { throw new Error('FakeWorkspaces.create is unused') }
  async rename(): Promise<WorkspaceView> { throw new Error('FakeWorkspaces.rename is unused') }
  async delete(): Promise<void> { throw new Error('FakeWorkspaces.delete is unused') }
  async insertBefore(): Promise<void> { throw new Error('FakeWorkspaces.insertBefore is unused') }
  async insertSessionBefore(): Promise<WorkspaceView> { throw new Error('FakeWorkspaces.insertSessionBefore is unused') }
  async archiveSession(): Promise<void> { throw new Error('FakeWorkspaces.archiveSession is unused') }
  async unarchiveSession(): Promise<void> { throw new Error('FakeWorkspaces.unarchiveSession is unused') }
  async pinSession(): Promise<void> { throw new Error('FakeWorkspaces.pinSession is unused') }
  async unpinSession(): Promise<void> { throw new Error('FakeWorkspaces.unpinSession is unused') }
}

interface BenchOptions {
  readonly saved?: { readonly sessionId?: SessionIdType }
  readonly list?: readonly Record<string, unknown>[]
  readonly workspaces?: WorkspaceSnapshot
  readonly phase?: 'pending' | 'ready'
  /** Load the list and settle it before navigation observes the stores. */
  readonly preloadList?: boolean
}

async function bench(
  mock: RemoteMock,
  start: () => Promise<TestClient>,
  options: BenchOptions = {},
) {
  mock.load(sessionWorld)
  mock.load({ unary: { 'session/list': ok({ items: [...options.list ?? []] }) } })
  // The selection store persists through localStorage; a case that checks the
  // saved value gets the same backing map the service read.
  const backing = persistSelection(options.saved ?? {})
  const client = await start()
  // Diagnostic: the booted client must not have replaced the saved selection.
  expect(globalThis.localStorage.getItem('dsh.sessions.current'))
    .toBe(JSON.stringify(options.saved ?? {}))
  const ctx = new Context()
  contexts.push(ctx)
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.effect(() => locale.register('workspace', { en, zh }))
  ctx.provide('locale', locale)
  const requestDraftInitialization = vi.fn(() => 'applied')
  ctx.provide('conversation', { input: { requestDraftInitialization } })
  const layout = new LayoutController({
    selectPanel: vi.fn(), retainMainPanels: vi.fn(),
    setSidebar: vi.fn(), toggleSidebar: vi.fn(), setViewportWidth: vi.fn(),
    setRightbar: vi.fn(), openRightbar: vi.fn(), closeRightbar: vi.fn(),
  }, () => true, createSnapshotStore({ activePanelId: null }))
  const selectPanel = vi.spyOn(layout, 'selectPanel')
  ctx.provide('layout', layout)
  ctx.effect(() => () => { layout.dispose() })

  const sessions = new ClientSessions(ctx, client.ctx.remote)
  if (options.phase === 'ready') await sessions.refresh()

  const picker: ClientRemote['directoryPicker'] = {
    pick: async () => ({ ok: true, value: null }),
    list: async () => ({ ok: true, value: listing }),
    createDirectory: async () => ({ ok: true, value: '/w/one/new' }),
  }
  const workspaces = new FakeWorkspaces(options.workspaces ?? workspaceState([], options.phase === 'ready' ? 'ready' : 'pending'))
  const notify = vi.fn()
  const uiWorkspace = new UiWorkspaceService(
    ctx,
    picker,
    workspaces,
    sessions,
    createWorkspaceViewStore().create().actions,
    notify,
  )
  return {
    ctx, client, mock, sessions, workspaces, uiWorkspace, notify, layout, selectPanel,
    requestDraftInitialization, backing,
  }
}

const listing: DirectoryListing = {
  path: '/w',
  home: '/w',
  crumbs: [{ name: '/', path: '/', hidden: false }],
  entries: [],
  truncated: false,
}

function firstFollow(mock: RemoteMock): SessionFollowRequest {
  const request = mock.log.requests(FOLLOW)[0]
  if (request === undefined) throw new Error('no session/follow request was recorded')
  return request as SessionFollowRequest
}

describe('federated selection: complete chain', () => {
  it('openSession sends the whole key as the first Session RPC and the Gateway resolves it', async ({ mock, start }) => {
    const b = await bench(mock, start)

    expect(() => { b.uiWorkspace.openSession(sid('alpha:s-1')) }).not.toThrow()
    await vi.waitFor(() => { expect(mock.log.requests(FOLLOW)).toHaveLength(1) })

    const sent = firstFollow(mock)
    expect(sent.address).toEqual({ kind: 'session', sessionId: sid('alpha:s-1') })
    // Persisted selection keeps the whole key too.
    expect(JSON.parse(b.backing.get('dsh.sessions.current')!))
      .toEqual({ sessionId: 'alpha:s-1' })

    const target = resolveFederationTarget(
      FOLLOW,
      { request: sent },
      id => id === 'alpha',
    )
    expect(target?.instanceId).toBe('alpha')
    expect((target?.args.request as SessionFollowRequest).address)
      .toEqual({ kind: 'session', sessionId: sid('s-1') })
    // The client never dropped the prefix: the forwarded body is a rewrite of
    // exactly what the client sent, not of an already-local id.
    expect(sent.address).toEqual({ kind: 'session', sessionId: sid('alpha:s-1') })
  })

  it('openSession still throws synchronously for an unknown local id and creates nothing', async ({ mock, start }) => {
    const b = await bench(mock, start)

    expect(() => { b.uiWorkspace.openSession(sid('ghost')) }).toThrow('unknown session')
    expect(mock.log.requests(FOLLOW)).toHaveLength(0)
    expect(JSON.parse(b.backing.get('dsh.sessions.current') ?? '{}')).toEqual({})
  })
})

describe('federated selection: restore and persistence', () => {
  it('restores a saved federated key as-is without creating or connecting a Workspace', async ({ mock, start }) => {
    const b = await bench(mock, start, {
      saved: { sessionId: sid('alpha:s-1') },
      phase: 'ready',
      workspaces: workspaceState([workspace('one')]),
    })

    await vi.waitFor(() => { expect(mock.log.requests(FOLLOW)).toHaveLength(1) })
    expect(firstFollow(mock).address).toEqual({ kind: 'session', sessionId: sid('alpha:s-1') })
    expect(b.workspaces.initializeDefault).not.toHaveBeenCalled()
    expect(b.notify).not.toHaveBeenCalled()
    expect(mock.log.requests('session/create')).toHaveLength(0)
    expect(mock.log.requests('workspace/create')).toHaveLength(0)
    expect(JSON.parse(b.backing.get('dsh.sessions.current')!)).toEqual({ sessionId: 'alpha:s-1' })
    expect(b.sessions.list.getSnapshot().ids).toEqual([])
    expect(Object.keys(b.sessions.list.getSnapshot().byId)).toEqual(['alpha:s-1'])
  })

  it('restores a listed local Session exactly as before', async ({ mock, start }) => {
    const b = await bench(mock, start, {
      saved: { sessionId: sid('local-s1') },
      phase: 'ready',
      list: [summary('local-s1')],
      workspaces: workspaceState([workspace('one', [sid('local-s1')])]),
    })

    await vi.waitFor(() => { expect(mock.log.requests(FOLLOW)).toHaveLength(1) })
    expect(firstFollow(mock).address).toEqual({ kind: 'session', sessionId: sid('local-s1') })
    expect(mock.log.requests('session/create')).toHaveLength(0)
    expect(b.workspaces.initializeDefault).not.toHaveBeenCalled()
    expect(JSON.parse(b.backing.get('dsh.sessions.current')!)).toEqual({ sessionId: 'local-s1' })
  })

  it('still reclaims a saved local blank through session/create (reuse unaffected)', async ({ mock, start }) => {
    mock.load({
      unary: {
        'session/create': ok({ sessionId: 'local-blank' }),
      },
    })
    const b = await bench(mock, start, {
      saved: { sessionId: sid('local-blank') },
      phase: 'ready',
      list: [summary('local-blank', { blank: true })],
      workspaces: workspaceState([workspace('one', [sid('local-blank')])]),
    })

    await vi.waitFor(() => { expect(mock.log.requests('session/create')).toHaveLength(1) })
    expect(mock.log.requests('session/create')).toEqual([{ workspaceId: 'one', sessionId: 'local-blank' }])
    await vi.waitFor(() => { expect(mock.log.requests(FOLLOW)).toHaveLength(1) })
    expect(firstFollow(mock).address).toEqual({ kind: 'session', sessionId: sid('local-blank') })
    expect(JSON.parse(b.backing.get('dsh.sessions.current')!)).toEqual({ sessionId: 'local-blank' })
  })
})

describe('federated row vs local blank reuse', () => {
  it('a retained federated row never becomes the blank connectWorkspace reuses', async ({ mock, start }) => {
    mock.load({ unary: { 'session/create': ok({ sessionId: 'local-blank' }) } })
    const b = await bench(mock, start, {
      phase: 'ready',
      list: [summary('local-blank', { blank: true })],
      workspaces: workspaceState([workspace('one', [sid('local-blank')])]),
    })
    const federated = b.sessions.retain(sid('alpha:s-1'), { source: 'mainView' })
    onTestFinished(() => { federated.release() })
    await federated.ready

    // The federated identity lives in `byId` only; the reuse scan reads `ids`.
    expect(b.sessions.list.getSnapshot().ids).toEqual([sid('local-blank')])
    expect(b.sessions.list.getSnapshot().byId[sid('alpha:s-1')]).toBeDefined()

    const before = mock.log.requests('session/create').length
    const created = await b.uiWorkspace.connectWorkspace(wid('one'))

    expect(created).toBe(sid('local-blank'))
    // Every reuse decision names the local blank; the federated identity is
    // not a candidate (`ids` never carries it).
    expect(mock.log.requests('session/create').slice(before))
      .toEqual([{ workspaceId: 'one', sessionId: 'local-blank' }])
    expect(mock.log.requests('session/create').some(
      request => (request as { sessionId?: string }).sessionId === 'alpha:s-1',
    )).toBe(false)
  })

  it('a federated row reports blank=false even while its Session snapshot is still blank', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const federated = b.sessions.retain(sid('alpha:s-1'), { source: 'mainView' })
    onTestFinished(() => { federated.release() })
    await federated.ready

    // The row's `blank` is what ConversationMainPanel reads as `summaryBlank`.
    expect(b.sessions.list.getSnapshot().byId[sid('alpha:s-1')]?.blank).toBe(false)
    // The Session snapshot itself still says blank: the value is remote-owned,
    // and the row deliberately does not claim local reuse eligibility.
    expect(federated.binding.session.getSnapshot().blank).toBe(true)
    await setImmediate()
    expect(b.sessions.list.getSnapshot().ids).toEqual([])
  })
})
