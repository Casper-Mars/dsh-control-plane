// @vitest-environment jsdom
/**
 * t100640 independent tester suite — the workspace row's "new session" entry.
 *
 * The developer's `t100640-workspace-new-session.client.spec.tsx` pins the
 * happy paths. This is a separate, adversarial pass over the same deliverable:
 *
 *   1. the complete create chain at the component seam and through `apply()`
 *      (create → refresh → open, failure short-circuits, refresh failure still
 *      navigates);
 *   2. the real wire arguments of `sessions.create` handed to the real
 *      `resolveFederationTarget`, including the `{ request }` wrapper and the
 *      two negative shapes;
 *   3. the Client catalog invariants for federated success / attach failure,
 *      with the local create behaviour pinned unchanged;
 *   4. same-tick duplication, clicks on a disabled control, and two workspaces
 *      creating concurrently without blocking each other;
 *   5. the failure UX (path + reason, persistence across a poll, recovery);
 *   6. keyboard/ARIA semantics and the reveal CSS;
 *   7. the control-plane shell and the state gate;
 *   8. regressions: the 8→16→20 ladder, folding across the 6s poll, row
 *      navigation and the current marker;
 *   9. an independent re-run of the four review fixes (failure timing, pruning,
 *      frame ordering, reader gate) written against the behaviour, not the
 *      developer's `t100640-fixes` spec.
 *
 * Nothing here changes production code or the developer's spec.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { allowAllAccess, contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { GlobalStandardProps, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Profiler, type ComponentType } from 'react'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  createClientTest, webApp, type TestClient,
} from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { resolveFederationTarget } from '@deepseek-ai/dsh-api-gateway'
import type { SidebarRootComponentProps } from '../src/client/contract/slots.ts'
import {
  InstanceGroups, type InstanceGroupView, type InstanceSessionView, type InstanceWorkspaceView,
} from '../src/client/InstanceGroups.tsx'
import { apply, inject } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'
import { SidebarRoot } from '../src/client/SidebarRoot.tsx'
import { ClientSessions } from '../../../api/session-controller/src/client/sessions/service.ts'
import { err, sessionWorld } from '../../../api/session-controller/tests/remote/session.client.ts'

const t = makeTranslate({ ...commonEn, ...en })
const owners = new Set<Fiber>()

afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  try {
    for (const owner of owners) await owner.dispose()
  } finally {
    owners.clear()
  }
})

/** Flush one frame promise and the store notifications it triggers. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

/** Flush the create → refresh → open chain. */
async function settleChain(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await settle()
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sessionOf(instanceId: string, sessionId: string, title?: string): InstanceSessionView {
  return {
    key: `${instanceId}:${sessionId}`,
    sessionId,
    ...(title === undefined ? {} : { title }),
    running: false,
    updatedAt: Date.now(),
  }
}

function workspaceOf(
  instanceId: string,
  path: string,
  sessions: readonly InstanceSessionView[],
): InstanceWorkspaceView {
  return { key: `${instanceId}:${path}`, path, runningCount: 0, sessions }
}

function groupOf(
  instanceId: string,
  workspaces: readonly InstanceWorkspaceView[],
  state: InstanceGroupView['state'] = 'connected',
): InstanceGroupView {
  const sessionCount = workspaces.reduce((total, workspace) => total + workspace.sessions.length, 0)
  return {
    instanceId,
    label: `${instanceId.toUpperCase()}(${instanceId})`,
    state,
    ...(state === 'unreachable' ? { error: 'connect ECONNREFUSED' } : {}),
    runningCount: 0,
    sessionCount,
    workspaces,
  }
}

function renderSection(options: {
  readonly groups: readonly InstanceGroupView[]
  readonly createSession?: (workspaceId: string) => Promise<string>
  readonly refreshTree?: () => Promise<readonly InstanceGroupView[]>
  readonly openSession?: (key: string) => void
  readonly currentSession?: { getSnapshot(): string | undefined; subscribe(listener: () => void): () => void }
  readonly intervalMs?: number
}) {
  return render(
    <InstanceGroups
      fetchTree={async () => options.groups}
      retry={vi.fn(async () => {})}
      {...(options.createSession === undefined ? {} : { createSession: options.createSession })}
      {...(options.refreshTree === undefined ? {} : { refreshTree: options.refreshTree })}
      {...(options.openSession === undefined ? {} : { openSession: options.openSession })}
      {...(options.currentSession === undefined ? {} : { currentSession: options.currentSession })}
      {...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs })}
      t={t}
    />,
  )
}

/** The create control of one workspace row. */
function createButtonOf(container: HTMLElement, workspaceKey: string): HTMLButtonElement {
  const button = container.querySelector(`[data-workspace-create="${workspaceKey}"]`)
  if (button === null) throw new Error(`the create button for ${workspaceKey} was not rendered`)
  return button as HTMLButtonElement
}

// ---------------------------------------------------------------------------
// 1. The complete create chain
// ---------------------------------------------------------------------------

describe('1. complete create chain', () => {
  it('creates once with the workspace key, refreshes, then opens the qualified id', async () => {
    const order: string[] = []
    const rows = [sessionOf('chain1', 's-1', 'Existing')]
    const before = [groupOf('chain1', [workspaceOf('chain1', '/repo', rows)])]
    const after = [groupOf('chain1', [
      workspaceOf('chain1', '/repo', [sessionOf('chain1', 'new-1', 'New session'), ...rows]),
    ])]
    const createSession = vi.fn(async (workspaceId: string) => {
      order.push(`create:${workspaceId}`)
      return 'new-1'
    })
    const refreshTree = vi.fn(async () => {
      order.push('refresh')
      return after
    })
    const openSession = vi.fn((key: string) => { order.push(`open:${key}`) })
    const { container } = renderSection({ groups: before, createSession, refreshTree, openSession })
    await settle()

    const button = createButtonOf(container, 'chain1:/repo')
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await settleChain()

    expect(createSession).toHaveBeenCalledExactlyOnceWith('chain1:/repo')
    expect(refreshTree).toHaveBeenCalledOnce()
    expect(openSession).toHaveBeenCalledExactlyOnceWith('chain1:new-1')
    expect(order).toEqual(['create:chain1:/repo', 'refresh', 'open:chain1:new-1'])
    // The refreshed frame is committed, so the row is visible immediately.
    expect(container.querySelector('[data-session-key="chain1:new-1"]')).not.toBeNull()
    expect(createButtonOf(container, 'chain1:/repo').disabled).toBe(false)
  })

  it('does not refresh or navigate when the create itself fails', async () => {
    const rows = [sessionOf('chain2', 's-1')]
    const groups = [groupOf('chain2', [workspaceOf('chain2', '/repo', rows)])]
    const createSession = vi.fn(async () => { throw new Error('upstream refused') })
    const refreshTree = vi.fn(async () => groups)
    const openSession = vi.fn()
    const { container } = renderSection({ groups, createSession, refreshTree, openSession })
    await settle()

    fireEvent.click(createButtonOf(container, 'chain2:/repo'))
    await settleChain()

    expect(createSession).toHaveBeenCalledOnce()
    expect(refreshTree).not.toHaveBeenCalled()
    expect(openSession).not.toHaveBeenCalled()
  })

  it('still navigates when the post-create refresh fails (the create already succeeded)', async () => {
    const rows = [sessionOf('chain3', 's-1')]
    const groups = [groupOf('chain3', [workspaceOf('chain3', '/repo', rows)])]
    const createSession = vi.fn(async () => 'new-3')
    const refreshTree = vi.fn(async () => { throw new Error('tree read failed') })
    const openSession = vi.fn()
    const { container } = renderSection({ groups, createSession, refreshTree, openSession })
    await settle()

    fireEvent.click(createButtonOf(container, 'chain3:/repo'))
    await settleChain()

    expect(refreshTree).toHaveBeenCalledOnce()
    expect(openSession).toHaveBeenCalledExactlyOnceWith('chain3:new-3')
    // A failed refresh is not a failed create: no inline failure line.
    expect(container.querySelector('[data-create-failure]')).toBeNull()
    expect(createButtonOf(container, 'chain3:/repo').disabled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 1b. apply() wiring: the composed readers drive the same chain
// ---------------------------------------------------------------------------

function SidebarFrame({ renderSlot }: PropsRenderSlots<'sidebar'>) {
  return renderSlot('sidebar', { collapsed: false, width: 300, drawer: false })
}

type ListState = {
  ids: string[]
  byId: Record<string, { id: string; retainedBy?: { mainView?: number | undefined } | undefined }>
}

async function benchSidebar(sessions: { list: unknown; create?: unknown }) {
  const root = new Context()
  let ctx: Context | undefined
  const owner = root.plugin((owned: Context) => { ctx = owned })
  owners.add(owner)
  await owner.await()
  if (ctx === undefined) throw new Error('the sidebar fixture owner did not activate')
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('shortcuts', { catalog: createSnapshotStore([]) } as never)
  ctx.provide('layout', { toggleSidebar: vi.fn(), selectPanel: vi.fn() } as never)
  ctx.provide('sessions', sessions as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { sidebar: { kind: 'single', scope: 'root' } } }, SidebarFrame)
  return { ctx, slots }
}

function mountSection(slots: SlotRegistry) {
  const entry = slots.entries('sidebar.instances')[0]
  if (entry === undefined) throw new Error('the instance section did not register')
  const Section = entry.component as ComponentType<{ t: typeof t; wide: boolean }>
  return render(<Section t={t} wide />)
}

describe('1b. apply() wiring', () => {
  it('routes create, refresh, and open through the composed services in order', async () => {
    const order: string[] = []
    const list = createSnapshotStore<ListState>({ ids: [], byId: {} })
    const groups = [groupOf('wire1', [workspaceOf('wire1', '/repo', [sessionOf('wire1', 's-1')])])]
    const create = vi.fn(async (opts: { workspaceId?: string }): Promise<string> => {
      order.push(`create:${opts.workspaceId ?? ''}`)
      return 's-new'
    })
    const bench = await benchSidebar({ list, create })
    const openSession = vi.fn((key: string) => { order.push(`open:${key}`) })
    bench.ctx.provide('uiWorkspace', { startSession: vi.fn(), openSession } as never)
    const tree = vi.fn(async () => {
      order.push('tree')
      return { ok: true as const, value: groups }
    })
    bench.ctx.provide('remote.controlPlane', { tree, reconnect: vi.fn() } as never)
    const sidebar = bench.ctx.plugin({ inject: [...inject], apply })
    await sidebar.await()
    try {
      const view = mountSection(bench.slots)
      await settleChain()
      expect(tree).toHaveBeenCalledOnce()

      fireEvent.click(createButtonOf(view.container, 'wire1:/repo'))
      await settleChain()

      expect(create).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'wire1:/repo' })
      expect(openSession).toHaveBeenCalledExactlyOnceWith('wire1:s-new')
      // The create, then the post-create read, then navigation.
      expect(order.slice(-3)).toEqual(['create:wire1:/repo', 'tree', 'open:wire1:s-new'])
      expect(tree).toHaveBeenCalledTimes(2)
    } finally {
      await sidebar.dispose()
    }
  })

  it('reports a missing create face inline instead of crashing the section', async () => {
    const list = createSnapshotStore<ListState>({ ids: [], byId: {} })
    const bench = await benchSidebar({ list })
    bench.ctx.provide('uiWorkspace', { startSession: vi.fn(), openSession: vi.fn() } as never)
    const tree = vi.fn(async () => ({
      ok: true as const,
      value: [groupOf('wire2', [workspaceOf('wire2', '/repo', [sessionOf('wire2', 's-1')])])],
    }))
    bench.ctx.provide('remote.controlPlane', { tree, reconnect: vi.fn() } as never)
    const sidebar = bench.ctx.plugin({ inject: [...inject], apply })
    await sidebar.await()
    try {
      const view = mountSection(bench.slots)
      await settleChain()
      fireEvent.click(createButtonOf(view.container, 'wire2:/repo'))
      await settleChain()
      const alert = view.container.querySelector('[data-create-failure="wire2:/repo"]') as HTMLElement | null
      expect(alert?.getAttribute('role')).toBe('alert')
      expect(alert?.textContent).toContain('sessions service is unavailable')
    } finally {
      await sidebar.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Real wire shape ↔ real federation router
// ---------------------------------------------------------------------------

const fedIt = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-api-gateway']) })
const BARE = SessionId('s-new')

async function benchSessions(mock: RemoteMock, start: () => Promise<TestClient>) {
  mock.load(sessionWorld)
  const client = await start()
  const ctx = new Context()
  const sessions = new ClientSessions(ctx, client.ctx.remote)
  return { sessions, ctx }
}

describe('2. wire arguments vs the real federation router', () => {
  fedIt('resolves the recorded create request to alpha and strips the workspace prefix', async ({ mock, start, remote }) => {
    remote.session.create.mockResolvedValue(ok({ sessionId: BARE }))
    const { sessions, ctx } = await benchSessions(mock, start)
    try {
      await sessions.create({ workspaceId: 'alpha:/repo' as never })

      // One positional argument: the generated Client's `request` object.
      const call = mock.log.calls('session/create')[0]
      expect(call?.args).toHaveLength(1)
      const request = mock.log.requests('session/create')[0] as Record<string, unknown>
      expect(request).toEqual({ workspaceId: 'alpha:/repo' })

      // The Gateway receives that object under the descriptor's `request`
      // parameter. The real router strips the prefix in place.
      const target = resolveFederationTarget('session/create', { request }, id => id === 'alpha')
      expect(target).toEqual({
        instanceId: 'alpha',
        endpoint: 'session/create',
        args: { request: { workspaceId: '/repo' } },
      })

      // Shape negatives: an unwrapped request and an unknown instance both
      // stay local, so the wrapper is not cosmetic.
      expect(resolveFederationTarget('session/create', request, () => true)).toBeUndefined()
      expect(resolveFederationTarget('session/create', { request }, id => id === 'beta')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. The local catalog must not learn a federated bare id
// ---------------------------------------------------------------------------

describe('3. local catalog isolation', () => {
  fedIt('leaves ids/byId untouched for a federated success', async ({ mock, start, remote }) => {
    remote.session.create.mockResolvedValue(ok({ sessionId: BARE }))
    const { sessions, ctx } = await benchSessions(mock, start)
    try {
      expect(await sessions.create({ workspaceId: 'alpha:/repo' as never })).toBe(BARE)
      const list = sessions.list.getSnapshot()
      expect(list.ids).toEqual([])
      expect(list.byId[BARE]).toBeUndefined()
      expect(JSON.stringify(list.byId)).not.toContain('s-new')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  fedIt('does not publish the attach-failure id either', async ({ mock, start, remote }) => {
    remote.session.create.mockResolvedValue(err(new RemoteError(
      'session/workspace-attach-failed',
      'published but unattached',
      { sessionId: BARE, workspaceId: 'alpha:/repo' },
    )))
    const { sessions, ctx } = await benchSessions(mock, start)
    try {
      await expect(sessions.create({ workspaceId: 'alpha:/repo' as never }))
        .rejects.toMatchObject({ name: 'SessionCreateError' })
      const list = sessions.list.getSnapshot()
      expect(list.ids).toEqual([])
      expect(list.byId[BARE]).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  fedIt('keeps the local success placeholder and the local attach-failure row', async ({ mock, start, remote }) => {
    remote.session.create.mockResolvedValue(ok({ sessionId: BARE }))
    const { sessions, ctx } = await benchSessions(mock, start)
    try {
      await sessions.create({ workspaceId: 'w1' as never })
      expect(sessions.list.getSnapshot().ids).toEqual([BARE])

      const ghost = SessionId('s-ghost')
      remote.session.create.mockResolvedValue(err(new RemoteError(
        'session/workspace-attach-failed',
        'published but unattached',
        { sessionId: ghost, workspaceId: 'w1' },
      )))
      await expect(sessions.create({ workspaceId: 'w1' as never }))
        .rejects.toMatchObject({ name: 'SessionCreateError' })
      // Both locals are catalogued; a newer mutation may be inserted first.
      const ids = sessions.list.getSnapshot().ids
      expect([...ids].sort()).toEqual([BARE, ghost].sort())
    } finally {
      await ctx.fiber.dispose()
    }
  })

  fedIt('keeps a cwd create local and does not let the flag stick to later calls', async ({ mock, start, remote }) => {
    remote.session.create.mockResolvedValue(ok({ sessionId: BARE }))
    const { sessions, ctx } = await benchSessions(mock, start)
    try {
      // cwd is never federated: the established placeholder still lands.
      await sessions.create({ cwd: '/repo' })
      expect(sessions.list.getSnapshot().ids).toEqual([BARE])

      // A federated call in between adds nothing ...
      await sessions.create({ workspaceId: 'alpha:/repo' as never })
      expect(sessions.list.getSnapshot().ids).toEqual([BARE])

      // ... and a following local create still publishes.
      await sessions.create({ workspaceId: 'w2' as never })
      const list = sessions.list.getSnapshot()
      expect(list.ids).toEqual([BARE])
      expect(mock.log.calls('session/create')).toHaveLength(3)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Concurrency and duplication
// ---------------------------------------------------------------------------

describe('4. concurrency', () => {
  it('sends one create for two clicks in the same tick and one click on the disabled button', async () => {
    const deferred = Promise.withResolvers<string>()
    const rows = [sessionOf('conc1', 's-1')]
    const groups = [groupOf('conc1', [workspaceOf('conc1', '/repo', rows)])]
    const createSession = vi.fn(() => deferred.promise)
    const openSession = vi.fn()
    const { container } = renderSection({
      groups,
      createSession,
      refreshTree: async () => groups,
      openSession,
    })
    await settle()

    const button = createButtonOf(container, 'conc1:/repo')
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(button)
    await settle()

    expect(createSession).toHaveBeenCalledOnce()
    const pending = createButtonOf(container, 'conc1:/repo')
    expect(pending.disabled).toBe(true)
    expect(pending.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(pending)
    expect(createSession).toHaveBeenCalledOnce()

    deferred.resolve('new-1')
    await settleChain()
    expect(openSession).toHaveBeenCalledExactlyOnceWith('conc1:new-1')
    const settled = createButtonOf(container, 'conc1:/repo')
    expect(settled.disabled).toBe(false)
    expect(settled.getAttribute('aria-busy')).toBeNull()
  })

  it('runs two workspaces concurrently, each at most once, and restores them independently', async () => {
    const repo = Promise.withResolvers<string>()
    const other = Promise.withResolvers<string>()
    const groups = [groupOf('conc2', [
      workspaceOf('conc2', '/repo', [sessionOf('conc2', 's-1')]),
      workspaceOf('conc2', '/other', [sessionOf('conc2', 's-2')]),
    ])]
    const createSession = vi.fn((workspaceId: string) => (
      workspaceId === 'conc2:/repo' ? repo.promise : other.promise
    ))
    const openSession = vi.fn()
    const { container } = renderSection({
      groups,
      createSession,
      refreshTree: async () => groups,
      openSession,
    })
    await settle()

    fireEvent.click(createButtonOf(container, 'conc2:/repo'))
    fireEvent.click(createButtonOf(container, 'conc2:/other'))
    fireEvent.click(createButtonOf(container, 'conc2:/repo'))
    await settle()

    expect(createSession).toHaveBeenCalledTimes(2)
    expect(createSession).toHaveBeenCalledWith('conc2:/repo')
    expect(createSession).toHaveBeenCalledWith('conc2:/other')
    expect(createButtonOf(container, 'conc2:/repo').disabled).toBe(true)
    expect(createButtonOf(container, 'conc2:/other').disabled).toBe(true)

    other.resolve('new-other')
    await settleChain()
    expect(openSession).toHaveBeenCalledExactlyOnceWith('conc2:new-other')
    // The other workspace is still pending and still disabled.
    expect(createButtonOf(container, 'conc2:/other').disabled).toBe(false)
    expect(createButtonOf(container, 'conc2:/repo').disabled).toBe(true)
    expect(createButtonOf(container, 'conc2:/repo').getAttribute('aria-busy')).toBe('true')

    repo.resolve('new-repo')
    await settleChain()
    expect(openSession).toHaveBeenCalledTimes(2)
    expect(openSession.mock.calls[1]).toEqual(['conc2:new-repo'])
    expect(createButtonOf(container, 'conc2:/repo').disabled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. Failure UX
// ---------------------------------------------------------------------------

describe('5. failure UX', () => {
  it('names the workspace and the reason, restores the button, and never opens', async () => {
    const rows = [sessionOf('fail1', 's-1')]
    const groups = [groupOf('fail1', [workspaceOf('fail1', '/repo', rows)])]
    const createSession = vi.fn(async () => { throw new Error('instance alpha went offline') })
    const openSession = vi.fn()
    const { container } = renderSection({
      groups,
      createSession,
      refreshTree: async () => groups,
      openSession,
    })
    await settle()

    fireEvent.click(createButtonOf(container, 'fail1:/repo'))
    await settleChain()

    const alert = container.querySelector('[data-create-failure="fail1:/repo"]') as HTMLElement | null
    expect(alert?.getAttribute('role')).toBe('alert')
    expect(alert?.textContent).toBe('Could not create a session in /repo: instance alpha went offline')
    expect(openSession).not.toHaveBeenCalled()
    const button = createButtonOf(container, 'fail1:/repo')
    expect(button.disabled).toBe(false)
    expect(button.getAttribute('aria-busy')).toBeNull()
  })

  it('keeps the failure line across poll frames until a create succeeds', async () => {
    vi.useFakeTimers()
    const rows = [sessionOf('fail2', 's-1')]
    const groups = [groupOf('fail2', [workspaceOf('fail2', '/repo', rows)])]
    const createSession = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('new-2')
    const openSession = vi.fn()
    const { container } = renderSection({
      groups,
      createSession,
      refreshTree: async () => groups,
      openSession,
      intervalMs: 6000,
    })
    await settle()

    fireEvent.click(createButtonOf(container, 'fail2:/repo'))
    await settleChain()
    expect(container.querySelector('[data-create-failure="fail2:/repo"]')).not.toBeNull()

    // Two poll frames must not erase a user-facing failure.
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(container.querySelector('[data-create-failure="fail2:/repo"]')).not.toBeNull()

    fireEvent.click(createButtonOf(container, 'fail2:/repo'))
    await settleChain()
    expect(container.querySelector('[data-create-failure]')).toBeNull()
    expect(openSession).toHaveBeenCalledExactlyOnceWith('fail2:new-2')
  })

  it('keeps the previous reason visible while the retry is pending and clears it only on success', async () => {
    // Requirement: "retained until the next success". The handler now clears
    // the line in the success branch, so a retry that is still running keeps
    // explaining why the previous attempt failed instead of going blank.
    const retry = Promise.withResolvers<string>()
    const rows = [sessionOf('fail3', 's-1')]
    const groups = [groupOf('fail3', [workspaceOf('fail3', '/repo', rows)])]
    const createSession = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => retry.promise)
    const openSession = vi.fn()
    const { container } = renderSection({
      groups,
      createSession,
      refreshTree: async () => groups,
      openSession,
    })
    await settle()

    fireEvent.click(createButtonOf(container, 'fail3:/repo'))
    await settleChain()
    expect(container.querySelector('[data-create-failure="fail3:/repo"]')?.textContent)
      .toBe('Could not create a session in /repo: offline')

    // Retry in flight: busy control, previous reason still readable.
    fireEvent.click(createButtonOf(container, 'fail3:/repo'))
    await settle()
    const pending = createButtonOf(container, 'fail3:/repo')
    expect(pending.disabled).toBe(true)
    expect(pending.getAttribute('aria-busy')).toBe('true')
    expect(container.querySelector('[data-create-failure="fail3:/repo"]')?.textContent)
      .toBe('Could not create a session in /repo: offline')

    retry.resolve('new-3')
    await settleChain()
    // Success is the only thing that removes it.
    expect(container.querySelector('[data-create-failure]')).toBeNull()
    expect(openSession).toHaveBeenCalledExactlyOnceWith('fail3:new-3')
  })

  it('keeps each workspace failure separate from a sibling success', async () => {
    const groups = [groupOf('fail5', [
      workspaceOf('fail5', '/repo', [sessionOf('fail5', 's-1')]),
      workspaceOf('fail5', '/other', [sessionOf('fail5', 's-2')]),
    ])]
    const createSession = vi.fn(async (workspaceId: string) => {
      if (workspaceId === 'fail5:/repo') throw new Error('repo down')
      return 'new-other'
    })
    const { container } = renderSection({
      groups,
      createSession,
      refreshTree: async () => groups,
      openSession: vi.fn(),
    })
    await settle()

    fireEvent.click(createButtonOf(container, 'fail5:/repo'))
    await settleChain()
    fireEvent.click(createButtonOf(container, 'fail5:/other'))
    await settleChain()

    const alert = container.querySelector('[data-create-failure="fail5:/repo"]') as HTMLElement | null
    expect(alert?.textContent).toBe('Could not create a session in /repo: repo down')
    expect(container.querySelector('[data-create-failure="fail5:/other"]')).toBeNull()
  })

  it('falls back to the localized unknown-error text for a blank rejection', async () => {
    const rows = [sessionOf('fail4', 's-1')]
    const groups = [groupOf('fail4', [workspaceOf('fail4', '/repo', rows)])]
    const createSession = vi.fn(async () => { throw new Error('   ') })
    const { container } = renderSection({
      groups,
      createSession,
      refreshTree: async () => groups,
      openSession: vi.fn(),
    })
    await settle()

    fireEvent.click(createButtonOf(container, 'fail4:/repo'))
    await settleChain()
    const alert = container.querySelector('[data-create-failure="fail4:/repo"]') as HTMLElement | null
    expect(alert?.textContent).toBe('Could not create a session in /repo: Unknown error')
  })
})

// ---------------------------------------------------------------------------
// 6. Keyboard and accessibility
// ---------------------------------------------------------------------------

describe('6. keyboard and accessibility', () => {
  const css = readFileSync(
    resolve(process.cwd(), 'packages/client/ui-sidebar/src/client/InstanceGroups.module.css'), 'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, ' ')
  const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/

  it('renders two sibling native buttons in a plain container, with the path in the name', async () => {
    const groups = [groupOf('a11y1', [workspaceOf('a11y1', '/repo', [sessionOf('a11y1', 's-1')])])]
    const { container } = renderSection({
      groups,
      createSession: async () => 'new-1',
      refreshTree: async () => groups,
      openSession: vi.fn(),
    })
    await settle()

    const button = createButtonOf(container, 'a11y1:/repo')
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('type')).toBe('button')
    expect(button.tabIndex).toBe(0)
    expect(button.getAttribute('aria-label')).toBe('Create a session in /repo')
    expect(button.closest('[role="treeitem"]')).toBeNull()
    // Neither control nests in the other: two direct button children.
    const row = button.parentElement as HTMLElement
    expect(row.getAttribute('role')).toBeNull()
    expect([...row.children].filter(child => child.tagName === 'BUTTON')).toHaveLength(2)
    const toggle = row.querySelector('[data-workspace-key="a11y1:/repo"]') as HTMLElement
    expect(toggle.tagName).toBe('BUTTON')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.querySelector('button')).toBeNull()
    expect(button.querySelector('button')).toBeNull()
    expect(screen.getByRole('button', { name: 'Create a session in /repo' })).toBe(button)
  })

  it('activates once per unmodified Enter/Space and ignores chords and child targets', async () => {
    const groups = [groupOf('a11y2', [workspaceOf('a11y2', '/repo', [sessionOf('a11y2', 's-1')])])]
    const createSession = vi.fn(async () => 'new-1')
    const openSession = vi.fn()
    const { container } = renderSection({
      groups,
      createSession,
      refreshTree: async () => groups,
      openSession,
    })
    await settle()

    const button = createButtonOf(container, 'a11y2:/repo')
    button.focus()
    expect(document.activeElement).toBe(button)
    // defaultPrevented === false return means the native click cannot double-fire.
    expect(fireEvent.keyDown(button, { key: 'Enter' })).toBe(false)
    await settleChain()
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(openSession).toHaveBeenCalledTimes(1)

    expect(fireEvent.keyDown(button, { key: ' ', code: 'Space' })).toBe(false)
    await settleChain()
    expect(createSession).toHaveBeenCalledTimes(2)

    for (const chord of [
      { key: 'Enter', ctrlKey: true },
      { key: 'Enter', metaKey: true },
      { key: 'Enter', altKey: true },
      { key: 'Enter', shiftKey: true },
      { key: ' ', ctrlKey: true },
    ] as const) {
      expect(fireEvent.keyDown(button, chord)).toBe(false)
    }
    expect(createSession).toHaveBeenCalledTimes(2)

    const icon = button.querySelector('svg')
    if (icon === null) throw new Error('the create icon was not rendered')
    fireEvent.keyDown(icon, { key: 'Enter' })
    fireEvent.keyDown(icon, { key: ' ' })
    expect(createSession).toHaveBeenCalledTimes(2)

    // Unrelated keys are left alone.
    expect(fireEvent.keyDown(button, { key: 'a' })).toBe(true)
    expect(createSession).toHaveBeenCalledTimes(2)
  })

  it('announces busy state and disables the control while the create is pending', async () => {
    const pending = Promise.withResolvers<string>()
    const groups = [groupOf('a11y3', [workspaceOf('a11y3', '/repo', [sessionOf('a11y3', 's-1')])])]
    const { container } = renderSection({
      groups,
      createSession: () => pending.promise,
      refreshTree: async () => groups,
      openSession: vi.fn(),
    })
    await settle()

    fireEvent.click(createButtonOf(container, 'a11y3:/repo'))
    await settle()
    const button = createButtonOf(container, 'a11y3:/repo')
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')

    pending.resolve('new-1')
    await settleChain()
    const restored = createButtonOf(container, 'a11y3:/repo')
    expect(restored.disabled).toBe(false)
    expect(restored.getAttribute('aria-busy')).toBeNull()
  })

  it('hides the control at rest and reveals it on row hover, focus-within, and touch', () => {
    expect(css).toMatch(/\.workspaceCreate\s*\{[^}]*display:\s*none/)
    expect(css).toMatch(/@media \(hover: hover\)\s*\{\s*\.workspaceRow:hover \.workspaceCreate\s*\{[^}]*display:\s*inline-flex/)
    expect(css).toMatch(/\.workspaceRow:focus-within \.workspaceCreate,?\s*\.workspaceCreate:focus-visible/)
    expect(css).toMatch(/@media \(hover: none\)\s*\{\s*\.workspaceCreate\s*\{[^}]*display:\s*inline-flex/)
    // Both halves of the row keep a visible focus ring.
    expect(css).toMatch(/\.workspaceToggle:focus-visible,[\s\S]{0,80}\.workspaceCreate:focus-visible/)
  })

  it('styles the entry and the failure line with design tokens only', () => {
    const createBlock = /\.workspaceCreate\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    const failureBlock = /\.createFailure\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(createBlock).toContain('var(--dsw-alias-label-tertiary)')
    expect(failureBlock).toContain('var(--dsw-alias-state-error-primary)')
    expect(css.match(COLOR_LITERAL)).toBeNull()
    expect(css).not.toMatch(/font-size:\s*1[12]px/)
  })
})

// ---------------------------------------------------------------------------
// 7. Control-plane shell and the state gate
// ---------------------------------------------------------------------------

const useResource = (() => ({
  status: 'none' as const, value: undefined, failure: undefined, reload: () => {},
})) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })
const neverHook = (() => { throw new Error('shell must not read global hooks') }) as never
type AttentionSnapshot = Parameters<Parameters<SidebarRootComponentProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: SidebarRootComponentProps['useSessionStatus'] = selector => selector(noAttention)

function mountRoot(controlPlane: boolean) {
  return render(
    <SidebarRoot
      drawer={false}
      collapsed={false}
      width={300}
      useSessions={neverHook}
      useSessionStatus={useSessionStatus}
      useSessionRetainInfo={neverHook}
      usePanelInfo={usePanelInfo}
      selectPanel={vi.fn()}
      usePanels={selector => selector([])}
      useEntryPins={selector => selector([])}
      useEntryActions={selector => selector(false)}
      setPinned={vi.fn()}
      useShortcuts={selector => selector([])}
      useContextMenu={contextMenuHook()}
      useResource={useResource}
      useWorkspaces={neverHook}
      {...allowAllAccess}
      controlPlane={controlPlane}
      startSession={vi.fn()}
      toggleSidebar={vi.fn()}
      trackEntryClick={vi.fn()}
      t={t}
      renderFactorySlot={() => null}
      renderSlot={(() => null) as SidebarRootComponentProps['renderSlot']}
    />,
  )
}

describe('7. control-plane mode and the state gate', () => {
  it('still hides the shell new-session control in control-plane mode', () => {
    mountRoot(false)
    expect(screen.queryAllByRole('button', { name: 'New session' })).toHaveLength(1)
    cleanup()
    mountRoot(true)
    expect(screen.queryByRole('button', { name: 'New session' })).toBeNull()
  })

  it('offers no create entry on unreachable or connecting instances', async () => {
    const unreachable = renderSection({
      groups: [groupOf('gate1', [workspaceOf('gate1', '/repo', [sessionOf('gate1', 's-1')])], 'unreachable')],
      createSession: async () => 'new-1',
      refreshTree: async () => [],
      openSession: vi.fn(),
    })
    await settle()
    expect(unreachable.container.querySelector('[data-workspace-create]')).toBeNull()
    expect(unreachable.container.querySelectorAll('[data-session-key]')).toHaveLength(0)
    cleanup()

    const connecting = renderSection({
      groups: [groupOf('gate2', [workspaceOf('gate2', '/repo', [sessionOf('gate2', 's-1')])], 'connecting')],
      createSession: async () => 'new-1',
      refreshTree: async () => [],
      openSession: vi.fn(),
    })
    await settle()
    // Rows stay visible while connecting; only the create entry is withheld.
    expect(connecting.container.querySelectorAll('[data-session-key]')).toHaveLength(1)
    expect(connecting.container.querySelector('[data-workspace-create]')).toBeNull()
  })

  it('renders no create control without a reader, and adds a working one when a reader arrives', async () => {
    // A fixture that wires openSession but not createSession used to show a
    // control that could not act. The gate now includes reader presence, and
    // because it reads the prop (not the reader ref) a reader handed in later
    // re-renders the control immediately.
    const groups = [groupOf('gate3', [workspaceOf('gate3', '/repo', [sessionOf('gate3', 's-1')])])]
    const openSession = vi.fn()
    const view = render(
      <InstanceGroups fetchTree={async () => groups} retry={vi.fn(async () => {})}
        openSession={openSession} t={t} />,
    )
    await settle()

    // The row and its fold control stay; only the inactive create entry is gone.
    expect(view.container.querySelectorAll('[data-session-key]')).toHaveLength(1)
    expect(view.container.querySelector('[data-workspace-key="gate3:/repo"]')).not.toBeNull()
    expect(view.container.querySelector('[data-workspace-create]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create a session in /repo' })).toBeNull()

    const createSession = vi.fn(async () => 'new-reader')
    view.rerender(
      <InstanceGroups fetchTree={async () => groups} retry={vi.fn(async () => {})}
        createSession={createSession} refreshTree={async () => groups}
        openSession={openSession} t={t} />,
    )
    // Visible in the same commit as the new prop, before any further flush.
    expect(createButtonOf(view.container, 'gate3:/repo').disabled).toBe(false)

    await settle()
    fireEvent.click(createButtonOf(view.container, 'gate3:/repo'))
    await settleChain()
    expect(createSession).toHaveBeenCalledExactlyOnceWith('gate3:/repo')
    expect(openSession).toHaveBeenCalledExactlyOnceWith('gate3:new-reader')
  })
})

// ---------------------------------------------------------------------------
// 8. Regressions
// ---------------------------------------------------------------------------

describe('8. regressions', () => {
  it('walks 8 → 16 → 20 and back to 8', async () => {
    const rows = Array.from({ length: 20 }, (_, index) => sessionOf('page8', `s-${index}`, `Session ${index}`))
    const groups = [groupOf('page8', [workspaceOf('page8', '/repo', rows)])]
    const openSession = vi.fn()
    const { container } = renderSection({
      groups,
      createSession: async () => 'new-1',
      refreshTree: async () => groups,
      openSession,
      intervalMs: 60_000,
    })
    await settle()

    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(8)
    fireEvent.click(screen.getByRole('button', { name: 'Show 12 more sessions' }))
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(16)
    fireEvent.click(screen.getByRole('button', { name: 'Show 4 more sessions' }))
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(20)
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(8)

    fireEvent.click(screen.getByRole('button', { name: 'Show 12 more sessions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show 4 more sessions' }))
    fireEvent.click(container.querySelector('[data-session-key="page8:s-19"]') as HTMLElement)
    expect(openSession).toHaveBeenCalledExactlyOnceWith('page8:s-19')
  })

  it('keeps folds and the watermark stable across the 6s poll', async () => {
    vi.useFakeTimers()
    const rows = Array.from({ length: 10 }, (_, index) => sessionOf('poll8', `s-${index}`, `S${index}`))
    const fetchTree = vi.fn(async () => [groupOf('poll8', [workspaceOf('poll8', '/repo', rows)])])
    render(
      <InstanceGroups fetchTree={fetchTree} retry={vi.fn(async () => {})}
        createSession={async () => 'new-1'} refreshTree={async () => []} t={t} />,
    )
    await settle()

    const header = screen.getByRole('button', { name: /POLL8\(poll8\)/ })
    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')

    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(fetchTree).toHaveBeenCalledTimes(3)
    expect(screen.getByRole('button', { name: /POLL8\(poll8\)/ }).getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelectorAll('[data-session-key]')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: /POLL8\(poll8\)/ }))
    expect(document.querySelectorAll('[data-session-key]')).toHaveLength(8)
  })

  it('opens a session row without creating, and the current marker follows the source', async () => {
    const store = createSnapshotStore<string | undefined>('row8:s-1')
    const groups = [groupOf('row8', [workspaceOf('row8', '/repo', [
      sessionOf('row8', 's-1', 'First'),
      sessionOf('row8', 's-2', 'Second'),
    ])])]
    const createSession = vi.fn(async () => 'never')
    const openSession = vi.fn()
    const { container } = renderSection({
      groups,
      createSession,
      refreshTree: async () => groups,
      openSession,
      currentSession: {
        getSnapshot: () => store.getSnapshot(),
        subscribe: listener => store.subscribe(listener),
      },
    })
    await settle()

    expect(container.querySelector('[data-session-key="row8:s-1"]')?.getAttribute('aria-current')).toBe('true')
    fireEvent.click(container.querySelector('[data-session-key="row8:s-2"]') as HTMLElement)
    expect(openSession).toHaveBeenCalledExactlyOnceWith('row8:s-2')
    expect(createSession).not.toHaveBeenCalled()

    await act(async () => { store.set('row8:s-2') })
    expect(container.querySelector('[data-session-key="row8:s-1"]')?.getAttribute('aria-current')).toBeNull()
    expect(container.querySelector('[data-session-key="row8:s-2"]')?.getAttribute('aria-current')).toBe('true')

    // Folding the workspace is not a create, and it hides the rows.
    const toggle = container.querySelector('[data-workspace-key="row8:/repo"]') as HTMLElement
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(0)
    expect(createSession).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 9. Independent re-verification of the four review fixes
// ---------------------------------------------------------------------------

describe('9. fix re-verification', () => {
  it('overwrites the old reason when the retry fails with a different one', async () => {
    const groups = [groupOf('re1', [workspaceOf('re1', '/repo', [sessionOf('re1', 's-1')])])]
    const createSession = vi.fn()
      .mockRejectedValueOnce(new Error('first attempt refused'))
      .mockRejectedValueOnce(new Error('second attempt timed out'))
    const openSession = vi.fn()
    const { container } = renderSection({
      groups,
      createSession,
      refreshTree: async () => groups,
      openSession,
    })
    await settle()

    fireEvent.click(createButtonOf(container, 're1:/repo'))
    await settleChain()
    expect(container.querySelector('[data-create-failure="re1:/repo"]')?.textContent)
      .toContain('first attempt refused')

    fireEvent.click(createButtonOf(container, 're1:/repo'))
    await settleChain()
    const text = container.querySelector('[data-create-failure="re1:/repo"]')?.textContent ?? ''
    expect(text).toContain('second attempt timed out')
    expect(text).not.toContain('first attempt refused')
    expect(openSession).not.toHaveBeenCalled()
    expect(createButtonOf(container, 're1:/repo').disabled).toBe(false)
  })

  it('prunes only the workspace that left, keeping a sibling reason intact', async () => {
    vi.useFakeTimers()
    const withOther = () => [groupOf('re2', [
      workspaceOf('re2', '/repo', [sessionOf('re2', 's-1')]),
      workspaceOf('re2', '/other', [sessionOf('re2', 's-2')]),
    ])]
    let groups = withOther()
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => groups}
        retry={vi.fn(async () => {})}
        createSession={async () => { throw new Error('offline') }}
        refreshTree={async () => groups}
        openSession={vi.fn()}
        intervalMs={6000}
        t={t}
      />,
    )
    await settle()

    fireEvent.click(createButtonOf(container, 're2:/repo'))
    await settleChain()
    fireEvent.click(createButtonOf(container, 're2:/other'))
    await settleChain()
    expect(container.querySelectorAll('[data-create-failure]')).toHaveLength(2)

    // /other leaves the frame: only its message goes.
    groups = [groupOf('re2', [workspaceOf('re2', '/repo', [sessionOf('re2', 's-1')])])]
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(container.querySelector('[data-create-failure="re2:/other"]')).toBeNull()
    expect(container.querySelector('[data-create-failure="re2:/repo"]')).not.toBeNull()

    // /other returns: still no stale message.
    groups = withOther()
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(container.querySelector('[data-create-failure="re2:/other"]')).toBeNull()
    expect(container.querySelector('[data-create-failure="re2:/repo"]')).not.toBeNull()
  })

  it('does not turn the prune effect into a render loop on repeated frames', async () => {
    // A setState inside an effect keyed on `groups` is the classic loop: the
    // effect must return the previous map unchanged when nothing is stale.
    // Count commits on the InstanceGroups subtree; a loop would be tens of
    // commits (React aborts past 50).
    vi.useFakeTimers()
    const commits: string[] = []
    const groups = [groupOf('re3', [workspaceOf('re3', '/repo', [sessionOf('re3', 's-1')])])]
    const { container } = render(
      <Profiler id="instance-groups" onRender={() => { commits.push('commit') }}>
        <InstanceGroups
          fetchTree={async () => groups}
          retry={vi.fn(async () => {})}
          createSession={async () => { throw new Error('offline') }}
          refreshTree={async () => groups}
          openSession={vi.fn()}
          intervalMs={6000}
          t={t}
        />
      </Profiler>,
    )
    await settle()
    fireEvent.click(createButtonOf(container, 're3:/repo'))
    await settleChain()
    expect(container.querySelector('[data-create-failure="re3:/repo"]')).not.toBeNull()

    const before = commits.length
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    const delta = commits.length - before

    // The frame itself commits; the prune pass with nothing stale adds none.
    expect(delta).toBeGreaterThanOrEqual(1)
    expect(delta).toBeLessThanOrEqual(2)
    // And the live failure survived the frame, i.e. the effect did run.
    expect(container.querySelector('[data-create-failure="re3:/repo"]')).not.toBeNull()
  })

  it('drops the older refresh frame when two creates finish out of order', async () => {
    const repo = Promise.withResolvers<string>()
    const other = Promise.withResolvers<string>()
    const initial = [groupOf('re4', [
      workspaceOf('re4', '/repo', [sessionOf('re4', 's-repo')]),
      workspaceOf('re4', '/other', [sessionOf('re4', 's-other')]),
    ])]
    const newest = [groupOf('re4', [
      workspaceOf('re4', '/repo', [sessionOf('re4', 's-newrepo'), sessionOf('re4', 's-repo')]),
      workspaceOf('re4', '/other', [sessionOf('re4', 's-newother'), sessionOf('re4', 's-other')]),
    ])]
    const older = [groupOf('re4', [
      workspaceOf('re4', '/repo', [sessionOf('re4', 's-repo')]),
      workspaceOf('re4', '/other', [sessionOf('re4', 's-newother'), sessionOf('re4', 's-other')]),
    ])]
    const frames: Array<PromiseWithResolvers<readonly InstanceGroupView[]>> = []
    const refreshTree = vi.fn(() => {
      const deferred = Promise.withResolvers<readonly InstanceGroupView[]>()
      frames.push(deferred)
      return deferred.promise
    })
    const createSession = vi.fn((workspaceId: string) => (
      workspaceId === 're4:/repo' ? repo.promise : other.promise
    ))
    const { container } = renderSection({
      groups: initial,
      createSession,
      refreshTree,
      openSession: vi.fn(),
    })
    await settle()

    fireEvent.click(createButtonOf(container, 're4:/repo'))
    fireEvent.click(createButtonOf(container, 're4:/other'))
    await settle()

    // /other finishes first: its refresh is request #1 (the older ticket).
    other.resolve('s-newother')
    await settleChain()
    expect(frames).toHaveLength(1)

    // /repo finishes second: its refresh is request #2 (the newest ticket).
    repo.resolve('s-newrepo')
    await settleChain()
    expect(frames).toHaveLength(2)

    frames[1]?.resolve(newest)
    await settleChain()
    expect(container.querySelector('[data-session-key="re4:s-newrepo"]')).not.toBeNull()
    expect(container.querySelector('[data-session-key="re4:s-newother"]')).not.toBeNull()

    // The older request settles last and must not roll the tree back.
    frames[0]?.resolve(older)
    await settleChain()
    expect(container.querySelector('[data-session-key="re4:s-newrepo"]')).not.toBeNull()
    expect(container.querySelector('[data-session-key="re4:s-newother"]')).not.toBeNull()
  })

  it('drops a poll frame that was in flight when a post-create refresh committed', async () => {
    vi.useFakeTimers()
    const initial = [groupOf('re5', [workspaceOf('re5', '/repo', [sessionOf('re5', 's-1')])])]
    const refreshed = [groupOf('re5', [
      workspaceOf('re5', '/repo', [sessionOf('re5', 's-new'), sessionOf('re5', 's-1')]),
    ])]
    const poll = Promise.withResolvers<readonly InstanceGroupView[]>()
    let reads = 0
    const fetchTree = vi.fn(() => {
      reads += 1
      return reads === 1 ? Promise.resolve(initial) : poll.promise
    })
    const { container } = render(
      <InstanceGroups
        fetchTree={fetchTree}
        retry={vi.fn(async () => {})}
        createSession={async () => 's-new'}
        refreshTree={async () => refreshed}
        openSession={vi.fn()}
        intervalMs={6000}
        t={t}
      />,
    )
    await settle()

    // The poll starts before the create and is still pending when the
    // post-create refresh lands.
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(fetchTree).toHaveBeenCalledTimes(2)

    fireEvent.click(createButtonOf(container, 're5:/repo'))
    await settleChain()
    expect(container.querySelector('[data-session-key="re5:s-new"]')).not.toBeNull()

    // The older poll answers with the pre-create tree: it must be discarded.
    poll.resolve(initial)
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('[data-session-key="re5:s-new"]')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Risk probes (behaviour outside the stated acceptance criteria)
// ---------------------------------------------------------------------------

describe('risk probes', () => {
  it('prunes a failure when the workspace leaves the tree, and does not revive it on return', async () => {
    vi.useFakeTimers()
    const original = [groupOf('stale1', [workspaceOf('stale1', '/repo', [sessionOf('stale1', 's-1')])])]
    let groups = original
    const fetchTree = vi.fn(async () => groups)
    const { container } = render(
      <InstanceGroups
        fetchTree={fetchTree}
        retry={vi.fn(async () => {})}
        createSession={async () => { throw new Error('offline') }}
        refreshTree={async () => groups}
        openSession={vi.fn()}
        intervalMs={6000}
        t={t}
      />,
    )
    await settle()

    fireEvent.click(createButtonOf(container, 'stale1:/repo'))
    await settleChain()
    expect(container.querySelector('[data-create-failure="stale1:/repo"]')).not.toBeNull()

    // The workspace disappears (instance reports no workspaces for a frame):
    // its message is pruned with it.
    groups = [groupOf('stale1', [])]
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(container.querySelector('[data-create-failure]')).toBeNull()

    // It comes back with no attempt in between: the old reason must not be
    // resurrected from the map.
    groups = original
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(container.querySelector('[data-create-failure="stale1:/repo"]')).toBeNull()
    expect(container.querySelector('[data-create-failure]')).toBeNull()
  })

  // KNOWN, OUT OF SCOPE — server snapshot regression, not a client frame-order
  // bug. With two creates racing, the *newer* refresh request can be answered
  // by an upstream snapshot taken before the newer create (or a mock that
  // answers reads out of order), so the newer ticket legitimately commits a
  // stale tree. The client correctly drops the older frame; it cannot repair a
  // stale payload. Pinned so a future reader does not read this as "unfixed".
  it('server snapshot regression (out of scope): a newer frame may still carry a pre-create tree', async () => {
    const repo = Promise.withResolvers<string>()
    const other = Promise.withResolvers<string>()
    const repoRow = sessionOf('race1', 's-repo', 'Repo')
    const otherRow = sessionOf('race1', 's-other', 'Other')
    const created = sessionOf('race1', 'new-other', 'Created')
    const fresh = [groupOf('race1', [
      workspaceOf('race1', '/repo', [repoRow]),
      workspaceOf('race1', '/other', [created, otherRow]),
    ])]
    const stale = [groupOf('race1', [
      workspaceOf('race1', '/repo', [repoRow]),
      workspaceOf('race1', '/other', [otherRow]),
    ])]
    let reads = 0
    const refreshTree = vi.fn(async () => {
      reads += 1
      return reads === 1 ? fresh : stale
    })
    const createSession = vi.fn((workspaceId: string) => (
      workspaceId === 'race1:/repo' ? repo.promise : other.promise
    ))
    const { container } = renderSection({
      groups: [groupOf('race1', [
        workspaceOf('race1', '/repo', [repoRow]),
        workspaceOf('race1', '/other', [otherRow]),
      ])],
      createSession,
      refreshTree,
      openSession: vi.fn(),
    })
    await settle()

    fireEvent.click(createButtonOf(container, 'race1:/repo'))
    fireEvent.click(createButtonOf(container, 'race1:/other'))
    await settle()

    // The second create finishes first: its refresh request is answered with a
    // frame that already carries the new row.
    other.resolve('new-other')
    await settleChain()
    expect(container.querySelector('[data-session-key="race1:new-other"]')).not.toBeNull()

    // The first create finishes second: a *newer* request, answered here with a
    // pre-create snapshot (the regression above). It commits and drops the row;
    // the older, richer frame settles afterwards and is correctly discarded by
    // the ticket, so the stale payload wins. That is the upstream snapshot's
    // fault, not the client's frame ordering.
    repo.resolve('new-repo')
    await settleChain()
    expect(container.querySelector('[data-session-key="race1:new-other"]')).toBeNull()
  })

  it('does not navigate when the section unmounts before the create resolves', async () => {
    const pending = Promise.withResolvers<string>()
    const groups = [groupOf('late1', [workspaceOf('late1', '/repo', [sessionOf('late1', 's-1')])])]
    const openSession = vi.fn()
    const view = renderSection({
      groups,
      createSession: () => pending.promise,
      refreshTree: async () => groups,
      openSession,
    })
    await settle()

    fireEvent.click(createButtonOf(view.container, 'late1:/repo'))
    await settle()
    view.unmount()
    pending.resolve('new-1')
    await settleChain()

    expect(openSession).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Sanity: the section still renders the alert where the user acted
// ---------------------------------------------------------------------------

describe('failure placement', () => {
  it('renders the alert inside the affected workspace block, not for its siblings', async () => {
    const groups = [groupOf('place1', [
      workspaceOf('place1', '/repo', [sessionOf('place1', 's-1')]),
      workspaceOf('place1', '/other', [sessionOf('place1', 's-2')]),
    ])]
    const createSession = vi.fn(async (workspaceId: string) => {
      if (workspaceId === 'place1:/repo') throw new Error('repo unavailable')
      return 'new-other'
    })
    const { container } = renderSection({
      groups,
      createSession,
      refreshTree: async () => groups,
      openSession: vi.fn(),
    })
    await settle()

    fireEvent.click(createButtonOf(container, 'place1:/repo'))
    await settleChain()
    expect(container.querySelectorAll('[data-create-failure]')).toHaveLength(1)
    expect(container.querySelector('[data-create-failure="place1:/other"]')).toBeNull()
    const alert = container.querySelector('[data-create-failure="place1:/repo"]') as HTMLElement
    const row = container.querySelector('[data-workspace-row="place1:/repo"]') as HTMLElement
    expect(row.parentElement?.contains(alert)).toBe(true)
    expect(within(alert).getByText(/repo unavailable/)).toBeTruthy()
  })
})
