// @vitest-environment jsdom
/**
 * t100640 — the workspace row's "new session" entry.
 *
 * Covers the sibling-button row structure, the complete federated Workspace
 * key handed to `sessions.create`, the bare id it answers with (qualified here
 * before `openSession`), the immediate tree refresh, inline failure recovery,
 * pending deduplication, keyboard activation, the hover/focus reveal, the
 * connected-only gate, the `apply()` wiring of both readers, the control-plane
 * top-entry regression, and the three new dictionary keys in all eight
 * languages.
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
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import type { SidebarRootComponentProps } from '../src/client/contract/slots.ts'
import {
  InstanceGroups, type InstanceGroupView, type InstanceSessionView, type InstanceWorkspaceView,
} from '../src/client/InstanceGroups.tsx'
import { apply, inject } from '../src/client/index.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'
import { SidebarRoot } from '../src/client/SidebarRoot.tsx'

const t = makeTranslate({ ...commonEn, ...en })
const owners = new Set<Fiber>()

afterEach(async () => {
  cleanup()
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

/** Flush the create → refresh → open chain (three awaits). */
async function settleChain(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await settle()
}

function session(sessionId: string, title?: string): InstanceSessionView {
  return {
    key: `alpha:${sessionId}`,
    sessionId,
    ...(title === undefined ? {} : { title }),
    running: false,
    updatedAt: Date.now(),
  }
}

const ROWS: readonly InstanceSessionView[] = [session('s-1', 'Fix the login flow'), session('s-2')]

function workspaceView(sessions: readonly InstanceSessionView[] = ROWS): InstanceWorkspaceView {
  return { key: 'alpha:/repo', path: '/repo', runningCount: 0, sessions }
}

function groupView(overrides: {
  readonly state?: InstanceGroupView['state']
  readonly sessions?: readonly InstanceSessionView[]
  readonly workspaces?: readonly InstanceWorkspaceView[]
} = {}): InstanceGroupView {
  const sessions = overrides.sessions ?? ROWS
  return {
    instanceId: 'alpha',
    label: 'ALPHA(alpha)',
    state: overrides.state ?? 'connected',
    ...(overrides.state === 'unreachable' ? { error: 'connect ECONNREFUSED' } : {}),
    runningCount: 0,
    sessionCount: sessions.length,
    workspaces: overrides.workspaces ?? (sessions.length === 0 ? [] : [workspaceView(sessions)]),
  }
}

function renderTree(options: {
  readonly groups?: readonly InstanceGroupView[]
  readonly createSession?: (workspaceId: string) => Promise<string>
  readonly refreshTree?: () => Promise<readonly InstanceGroupView[]>
  readonly openSession?: (key: string) => void
  readonly currentSession?: { getSnapshot(): string | undefined; subscribe(listener: () => void): () => void }
} = {}) {
  const groups = options.groups ?? [groupView()]
  return render(
    <InstanceGroups
      fetchTree={async () => groups}
      retry={vi.fn(async () => {})}
      {...(options.createSession === undefined ? {} : { createSession: options.createSession })}
      {...(options.refreshTree === undefined ? {} : { refreshTree: options.refreshTree })}
      {...(options.openSession === undefined ? {} : { openSession: options.openSession })}
      {...(options.currentSession === undefined ? {} : { currentSession: options.currentSession })}
      t={t}
    />,
  )
}

/** The create control of the single fixture workspace. */
function createButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('[data-workspace-create="alpha:/repo"]')
  if (button === null) throw new Error('the workspace create button was not rendered')
  return button as HTMLButtonElement
}

describe('workspace create entry', () => {
  it('creates in the federated workspace key, refreshes the tree, then opens the qualified id', async () => {
    const order: string[] = []
    const createSession = vi.fn(async (workspaceId: string) => {
      order.push(`create:${workspaceId}`)
      // The control plane forwards without a prefix and answers with the
      // owning instance's bare id.
      return 'new-1'
    })
    const refreshTree = vi.fn(async () => {
      order.push('refresh')
      return [groupView({ sessions: [session('new-1', 'New session'), ...ROWS] })]
    })
    const openSession = vi.fn((key: string) => { order.push(`open:${key}`) })
    const { container } = renderTree({ createSession, refreshTree, openSession })
    await settle()

    const button = createButton(container)
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('type')).toBe('button')
    expect(button.getAttribute('aria-label')).toBe('Create a session in /repo')
    fireEvent.click(button)
    await settleChain()

    expect(createSession).toHaveBeenCalledExactlyOnceWith('alpha:/repo')
    expect(refreshTree).toHaveBeenCalledOnce()
    // The id is qualified with the same instance the workspace key named.
    expect(openSession).toHaveBeenCalledExactlyOnceWith('alpha:new-1')
    expect(order).toEqual(['create:alpha:/repo', 'refresh', 'open:alpha:new-1'])
    // The refreshed frame landed, so the new row is already in the tree.
    expect(container.querySelector('[data-session-key="alpha:new-1"]')).not.toBeNull()
    // A settled attempt restores the button.
    expect(createButton(container).disabled).toBe(false)
  })

  it('shows a localized inline alert, restores the button, and does not open on failure', async () => {
    const createSession = vi.fn()
      .mockRejectedValueOnce(new Error('instance alpha went offline'))
      .mockResolvedValueOnce('new-1')
    const refreshTree = vi.fn(async () => [groupView()])
    const openSession = vi.fn()
    const { container } = renderTree({ createSession, refreshTree, openSession })
    await settle()

    fireEvent.click(createButton(container))
    await settleChain()

    const alert = container.querySelector('[data-create-failure="alpha:/repo"]') as HTMLElement
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toBe('Could not create a session in /repo: instance alpha went offline')
    expect(createButton(container).disabled).toBe(false)
    expect(openSession).not.toHaveBeenCalled()
    expect(refreshTree).not.toHaveBeenCalled()

    // Recovery: the next accepted attempt clears the line and opens.
    fireEvent.click(createButton(container))
    await settleChain()
    expect(container.querySelector('[data-create-failure]')).toBeNull()
    expect(openSession).toHaveBeenCalledExactlyOnceWith('alpha:new-1')
  })

  it('sends exactly one create while the first attempt is pending', async () => {
    const deferred = Promise.withResolvers<string>()
    const createSession = vi.fn(() => deferred.promise)
    const openSession = vi.fn()
    const { container } = renderTree({
      createSession,
      refreshTree: async () => [groupView()],
      openSession,
    })
    await settle()

    const button = createButton(container)
    fireEvent.click(button)
    fireEvent.click(button)
    await settle()
    // A later click while the button is disabled is inert as well.
    fireEvent.click(createButton(container))
    expect(createSession).toHaveBeenCalledOnce()
    expect(createButton(container).disabled).toBe(true)
    expect(createButton(container).getAttribute('aria-busy')).toBe('true')

    deferred.resolve('new-1')
    await settleChain()
    expect(createSession).toHaveBeenCalledOnce()
    expect(openSession).toHaveBeenCalledExactlyOnceWith('alpha:new-1')
    expect(createButton(container).disabled).toBe(false)
  })

  it('is reachable and activates from the keyboard', async () => {
    const createSession = vi.fn(async () => 'new-1')
    const openSession = vi.fn()
    const { container } = renderTree({
      createSession,
      refreshTree: async () => [groupView()],
      openSession,
    })
    await settle()

    const button = createButton(container)
    // A native button in the tab order; its role/name come from the label.
    expect(button.tabIndex).toBe(0)
    expect(button.closest('[role="treeitem"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Create a session in /repo' })).toBe(button)
    // Neither control nests inside the other: siblings in a plain container.
    const row = button.parentElement as HTMLElement
    expect(row.getAttribute('role')).toBeNull()
    expect(row.querySelector('[data-workspace-key="alpha:/repo"]')?.tagName).toBe('BUTTON')
    expect(row.querySelector('[data-workspace-key="alpha:/repo"]')?.getAttribute('aria-expanded')).toBe('true')

    button.focus()
    expect(document.activeElement).toBe(button)
    fireEvent.keyDown(button, { key: 'Enter' })
    await settleChain()
    fireEvent.keyDown(createButton(container), { key: ' ' })
    await settleChain()
    expect(createSession).toHaveBeenCalledTimes(2)
    // Modified chords stay inert: the press is consumed but nothing runs.
    fireEvent.keyDown(createButton(container), { key: 'Enter', ctrlKey: true })
    expect(createSession).toHaveBeenCalledTimes(2)
  })

  it('offers the entry only on connected instances', async () => {
    const connecting = renderTree({ groups: [groupView({ state: 'connecting' })] })
    await settle()
    expect(connecting.container.querySelectorAll('[data-session-key]')).toHaveLength(2)
    expect(connecting.container.querySelector('[data-workspace-create]')).toBeNull()
    cleanup()

    const reachable = renderTree({ groups: [groupView({ state: 'unreachable' })] })
    await settle()
    expect(reachable.container.querySelector('[data-workspace-create]')).toBeNull()
  })

  it('keeps folding, opening, and the current marker intact', async () => {
    const store = createSnapshotStore<string | undefined>('alpha:s-1')
    const openSession = vi.fn()
    const { container } = renderTree({
      createSession: async () => 'new-1',
      refreshTree: async () => [groupView()],
      openSession,
      currentSession: { getSnapshot: () => store.getSnapshot(), subscribe: listener => store.subscribe(listener) },
    })
    await settle()

    const first = container.querySelector('[data-session-key="alpha:s-1"]') as HTMLElement
    expect(first.getAttribute('aria-current')).toBe('true')
    fireEvent.click(first)
    expect(openSession).toHaveBeenCalledExactlyOnceWith('alpha:s-1')

    const toggle = container.querySelector('[data-workspace-key="alpha:/repo"]') as HTMLElement
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(0)
    fireEvent.click(toggle)
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(2)
  })
})

describe('workspace row reveal', () => {
  // jsdom's import.meta.url is an http URL, so anchor on the repo root instead.
  const css = readFileSync(
    resolve(process.cwd(), 'packages/client/ui-sidebar/src/client/InstanceGroups.module.css'), 'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, ' ')
  const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/

  it('hides the control at rest and reveals it on hover or keyboard focus', () => {
    expect(css).toMatch(/\.workspaceCreate\s*\{[^}]*display:\s*none/)
    expect(css).toMatch(/@media \(hover: hover\)\s*\{\s*\.workspaceRow:hover \.workspaceCreate\s*\{[^}]*display:\s*inline-flex/)
    expect(css).toMatch(/\.workspaceRow:focus-within \.workspaceCreate,?\s*\.workspaceCreate:focus-visible/)
    // Touch platforms must not hide it forever.
    expect(css).toMatch(/@media \(hover: none\)\s*\{\s*\.workspaceCreate\s*\{[^}]*display:\s*inline-flex/)
  })

  it('uses only design tokens, no colour literals, and no 11px/12px sizes', () => {
    const createBlock = /\.workspaceCreate\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(createBlock).toContain('var(--dsw-alias-label-tertiary)')
    expect(css.match(COLOR_LITERAL)).toBeNull()
    expect(css).not.toMatch(/font-size:\s*1[12]px/)
  })
})

// ---------------------------------------------------------------------------
// apply() wiring: both readers are built from the composed services
// ---------------------------------------------------------------------------

function SidebarFrame({ renderSlot }: PropsRenderSlots<'sidebar'>) {
  return renderSlot('sidebar', { collapsed: false, width: 300, drawer: false })
}

type ListState = {
  ids: string[]
  byId: Record<string, { id: string; retainedBy?: { mainView?: number | undefined } }>
}

async function bench(sessions: { list: unknown; create?: unknown }) {
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

describe('sidebar.instances wiring', () => {
  it('routes create through sessions.create with the federated key, refreshes, and opens', async () => {
    const list = createSnapshotStore<ListState>({ ids: [], byId: {} })
    const create = vi.fn(async (_opts: { workspaceId?: string }) => 's-new')
    const b = await bench({ list, create })
    const openSession = vi.fn()
    b.ctx.provide('uiWorkspace', { startSession: vi.fn(), openSession } as never)
    const tree = vi.fn(async () => ({ ok: true as const, value: [groupView()] }))
    b.ctx.provide('remote.controlPlane', { tree, reconnect: vi.fn() } as never)
    const sidebar = b.ctx.plugin({ inject: [...inject], apply })
    await sidebar.await()
    try {
      const view = mountSection(b.slots)
      await settleChain()
      expect(tree).toHaveBeenCalledOnce()

      fireEvent.click(createButton(view.container))
      await settleChain()

      expect(create).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'alpha:/repo' })
      // The same reader serves the post-create refresh and did not wait for a poll.
      expect(tree).toHaveBeenCalledTimes(2)
      expect(openSession).toHaveBeenCalledExactlyOnceWith('alpha:s-new')
    } finally {
      await sidebar.dispose()
    }
  })

  it('boots without a create face and reports the absence instead of crashing', async () => {
    const list = createSnapshotStore<ListState>({ ids: [], byId: {} })
    // A Session service without `create` (an isolated fixture).
    const b = await bench({ list })
    b.ctx.provide('uiWorkspace', { startSession: vi.fn(), openSession: vi.fn() } as never)
    const tree = vi.fn(async () => ({ ok: true as const, value: [groupView()] }))
    b.ctx.provide('remote.controlPlane', { tree, reconnect: vi.fn() } as never)
    const sidebar = b.ctx.plugin({ inject: [...inject], apply })
    await sidebar.await()
    try {
      const view = mountSection(b.slots)
      await settleChain()
      fireEvent.click(createButton(view.container))
      await settleChain()
      const alert = view.container.querySelector('[data-create-failure="alpha:/repo"]') as HTMLElement
      expect(alert.getAttribute('role')).toBe('alert')
      expect(alert.textContent).toContain('sessions service is unavailable')
      // The tree survives the refusal.
      expect(view.container.querySelectorAll('[data-session-key]')).toHaveLength(2)
    } finally {
      await sidebar.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Regression: the control-plane composition keeps the top entry hidden
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

describe('control-plane top entry', () => {
  it('still hides the shell New Session control in control-plane mode', () => {
    mountRoot(false)
    expect(screen.queryAllByRole('button', { name: 'New session' })).toHaveLength(1)
    cleanup()
    mountRoot(true)
    expect(screen.queryByRole('button', { name: 'New session' })).toBeNull()
  })
})

describe('dictionaries', () => {
  const dictionaries: Readonly<Record<string, Record<string, string>>> = {
    zh, en, ja, es, fr, de, ru, pt,
  }

  it('carries the three new keys in all eight languages with their placeholders', () => {
    expect(Object.keys(dictionaries)).toHaveLength(8)
    for (const [language, dictionary] of Object.entries(dictionaries)) {
      expect(dictionary['instances.workspace.newSession'], `${language} is missing instances.workspace.newSession`)
        .toContain('{workspace}')
      expect(dictionary['instances.createFailed'], `${language} is missing instances.createFailed`)
        .toContain('{name}')
      expect(dictionary['instances.createFailed']).toContain('{message}')
      expect(dictionary['instances.createFailedUnknown'], `${language} is missing instances.createFailedUnknown`)
        .not.toBe('')
    }
  })
})
