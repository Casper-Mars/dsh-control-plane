// @vitest-environment jsdom
/**
 * t100639 — the session row is the tree's one interactive row.
 *
 * Covers activation (click, Enter, Space; modified chords stay inert), the
 * complete federated key that reaches `openSession`, the current-row marker
 * derived from `sessions.list` (`retainedBy.mainView`, the same rule the
 * Workspace browser uses), the guard that keeps rows out of an unreachable
 * group, the refused-open path that must not take the sidebar down, the
 * `apply()` wiring for both readers, and the two new dictionary keys in all
 * eight languages.
 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import {
  InstanceGroups, type InstanceGroupView, type InstanceSessionView,
} from '../src/client/InstanceGroups.tsx'
import { apply, inject } from '../src/client/index.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'

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

/** Flush the frame promise and the store notifications it triggers. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

/** One session row; `title` absent means the row falls back to the local id. */
function session(key: string, sessionId: string, title?: string): InstanceSessionView {
  return {
    key,
    sessionId,
    ...(title === undefined ? {} : { title }),
    running: false,
    updatedAt: Date.now(),
  }
}

/** One connected instance with one workspace and the given session rows. */
function connected(sessions: readonly InstanceSessionView[]): InstanceGroupView {
  return {
    instanceId: 'alpha',
    label: 'ALPHA(alpha)',
    state: 'connected',
    runningCount: 0,
    sessionCount: sessions.length,
    workspaces: [{
      key: 'alpha:/repo',
      path: '/repo',
      runningCount: 0,
      sessions,
    }],
  }
}

const ROWS = [session('alpha:s-1', 's-1', 'Fix the login flow'), session('alpha:s-2', 's-2')]

/** The two Session-list fields the current-row derivation reads. */
type ListState = {
  byId: Record<string, { id: string; retainedBy: { mainView?: number | undefined } }>
}

/** A current-Session source over a mutable store, as index.ts builds one. */
function currentSource(initial: string | undefined) {
  const store = createSnapshotStore<string | undefined>(initial)
  return {
    store,
    source: { getSnapshot: () => store.getSnapshot(), subscribe: (listener: () => void) => store.subscribe(listener) },
  }
}

describe('session row activation', () => {
  it('opens the complete federated key on click', async () => {
    const openSession = vi.fn()
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [connected(ROWS)]}
        retry={vi.fn(async () => {})}
        openSession={openSession}
        t={t}
      />,
    )
    await settle()
    const row = container.querySelector('[data-session-key="alpha:s-1"]') as HTMLElement
    expect(row.tagName).toBe('BUTTON')
    expect(row.getAttribute('type')).toBe('button')
    expect(row.tabIndex).toBe(0)
    fireEvent.click(row)
    expect(openSession).toHaveBeenCalledExactlyOnceWith('alpha:s-1', '/repo')
    // The prefix is routing information, never stripped here.
    expect(openSession.mock.calls[0]?.[0]).toBe('alpha:s-1')
  })

  it('opens on Enter and on Space', async () => {
    const openSession = vi.fn()
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [connected(ROWS)]}
        retry={vi.fn(async () => {})}
        openSession={openSession}
        t={t}
      />,
    )
    await settle()
    const row = container.querySelector('[data-session-key="alpha:s-2"]') as HTMLElement
    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.keyDown(row, { key: ' ' })
    expect(openSession.mock.calls).toEqual([['alpha:s-2', '/repo'], ['alpha:s-2', '/repo']])
  })

  it('ignores modified chords', async () => {
    const openSession = vi.fn()
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [connected(ROWS)]}
        retry={vi.fn(async () => {})}
        openSession={openSession}
        t={t}
      />,
    )
    await settle()
    const row = container.querySelector('[data-session-key="alpha:s-1"]') as HTMLElement
    fireEvent.keyDown(row, { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(row, { key: 'Enter', metaKey: true })
    fireEvent.keyDown(row, { key: ' ', shiftKey: true })
    fireEvent.keyDown(row, { key: ' ', altKey: true })
    // Unrelated keys never navigate either.
    fireEvent.keyDown(row, { key: 'a' })
    expect(openSession).not.toHaveBeenCalled()
  })

  it('does not treat a fold row as an open', async () => {
    const openSession = vi.fn()
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [connected(ROWS)]}
        retry={vi.fn(async () => {})}
        openSession={openSession}
        t={t}
      />,
    )
    await settle()
    const workspace = container.querySelector('[data-workspace-key="alpha:/repo"]') as HTMLElement
    const header = container.querySelector('[data-instance-id="alpha"]') as HTMLElement
    // Fold and unfold both ways: the disclosure store is module-level, so
    // leaving a row folded would hide the rows of every later case.
    fireEvent.click(workspace)
    fireEvent.click(workspace)
    fireEvent.click(header)
    fireEvent.click(header)
    expect(openSession).not.toHaveBeenCalled()
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(2)
  })

  it('names each row by the action it performs', async () => {
    render(
      <InstanceGroups
        fetchTree={async () => [connected(ROWS)]}
        retry={vi.fn(async () => {})}
        openSession={vi.fn()}
        t={t}
      />,
    )
    await settle()
    expect(screen.getByRole('button', { name: 'Open session Fix the login flow' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open session s-2' })).toBeTruthy()
  })
})

describe('current row marker', () => {
  it('marks the Session whose mainView retention is set, and follows list changes', async () => {
    const { store, source } = currentSource('alpha:s-1')
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [connected(ROWS)]}
        retry={vi.fn(async () => {})}
        openSession={vi.fn()}
        currentSession={source}
        t={t}
      />,
    )
    await settle()
    const first = container.querySelector('[data-session-key="alpha:s-1"]') as HTMLElement
    const second = container.querySelector('[data-session-key="alpha:s-2"]') as HTMLElement
    expect(first.getAttribute('aria-current')).toBe('true')
    expect(second.getAttribute('aria-current')).toBeNull()

    await act(async () => { store.set('alpha:s-2') })
    expect(first.getAttribute('aria-current')).toBeNull()
    expect(second.getAttribute('aria-current')).toBe('true')

    await act(async () => { store.set(undefined) })
    expect(container.querySelector('[aria-current="true"]')).toBeNull()
  })

  it('derives the current id from retainedBy.mainView like the workspace browser', async () => {
    const { mainSessionId } = await import('../src/client/InstanceGroups.tsx')
    const list = {
      byId: {
        'alpha:s-1': { id: 'alpha:s-1', retainedBy: { mainView: 0, sidebar: 1 } },
        'alpha:s-2': { id: 'alpha:s-2', retainedBy: { mainView: 2 } },
      },
    }
    expect(mainSessionId(list)).toBe('alpha:s-2')
    expect(mainSessionId({ byId: {} })).toBeUndefined()
  })
})

describe('unreachable groups', () => {
  it('renders no clickable row even when a stale frame still carried workspaces', async () => {
    const stale: InstanceGroupView = {
      ...connected(ROWS),
      state: 'unreachable',
      error: 'connect ECONNREFUSED',
    }
    const openSession = vi.fn()
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [stale]}
        retry={vi.fn(async () => {})}
        openSession={openSession}
        t={t}
      />,
    )
    await settle()
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: /^Open session/ })).toHaveLength(0)
    const header = container.querySelector('[data-instance-id="alpha"]') as HTMLElement
    // Fold back: the disclosure store is module-level, and the later cases use
    // the same instance id.
    fireEvent.click(header)
    fireEvent.click(header)
    expect(openSession).not.toHaveBeenCalled()
  })
})

describe('refused open', () => {
  it('reports the failure under the tree and keeps the rows', async () => {
    const openSession = vi.fn<() => void>(() => { throw new Error('instance alpha went offline') })
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [connected(ROWS)]}
        retry={vi.fn(async () => {})}
        openSession={openSession}
        t={t}
      />,
    )
    await settle()
    fireEvent.click(container.querySelector('[data-session-key="alpha:s-1"]') as HTMLElement)
    const alert = container.querySelector('[data-open-failure]') as HTMLElement
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toBe('Could not open the session: instance alpha went offline')
    // The section still renders both rows, so the sidebar survived the refusal.
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(2)

    // The next accepted open clears the line (recovery state).
    openSession.mockImplementation(() => {})
    fireEvent.click(container.querySelector('[data-session-key="alpha:s-2"]') as HTMLElement)
    expect(container.querySelector('[data-open-failure]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// apply() wiring: both readers are constructed from the composed services
// ---------------------------------------------------------------------------

/** The shell frame the sidebar registers into: one `sidebar` hole. */
function SidebarFrame({ renderSlot }: PropsRenderSlots<'sidebar'>) {
  return renderSlot('sidebar', { collapsed: false, width: 300, drawer: false })
}

/** A test Client with the services ui-sidebar needs, plus an optional Session list. */
async function bench(sessions?: { list: unknown }) {
  const root = new Context()
  let ctx: Context | undefined
  const owner = root.plugin((owned: Context) => { ctx = owned })
  owners.add(owner)
  await owner.await()
  if (ctx === undefined) throw new Error('the sidebar fixture owner did not activate')
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('shortcuts', { catalog: createSnapshotStore([]) } as never)
  ctx.provide('layout', { toggleSidebar: vi.fn(), selectPanel: vi.fn() } as never)
  if (sessions !== undefined) ctx.provide('sessions', sessions as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const slots = ctx.get('slots') as SlotRegistry
  slots.register(
    { name: 'root', children: { sidebar: { kind: 'single', scope: 'root' } } },
    SidebarFrame,
  )
  return { ctx, slots }
}

/** Render the registered instance section the way the renderer does. */
function mountSection(slots: SlotRegistry) {
  const entry = slots.entries('sidebar.instances')[0]
  if (entry === undefined) throw new Error('the instance section did not register')
  const Section = entry.component as ComponentType<{ t: typeof t; wide: boolean }>
  return render(<Section t={t} wide />)
}

describe('sidebar.instances wiring', () => {
  it('routes a row click through uiWorkspace.openSession and highlights the retained id', async () => {
    const list = createSnapshotStore<ListState>({
      byId: { 'alpha:s-1': { id: 'alpha:s-1', retainedBy: { mainView: 1 } } },
    })
    const b = await bench({ list })
    const openSession = vi.fn((key: string) => {
      // What the Workspace UI does to the Session list on a successful open.
      list.set({ byId: { [key]: { id: key, retainedBy: { mainView: 1 } } } })
    })
    b.ctx.provide('uiWorkspace', { startSession: vi.fn(), openSession } as never)
    b.ctx.provide('remote.controlPlane', {
      tree: async () => ({ ok: true as const, value: [connected(ROWS)] }),
      reconnect: vi.fn(),
    } as never)
    const sidebar = b.ctx.plugin({ inject: [...inject], apply })
    await sidebar.await()
    try {
      const view = mountSection(b.slots)
      await settle()
      const first = view.container.querySelector('[data-session-key="alpha:s-1"]') as HTMLElement
      const second = view.container.querySelector('[data-session-key="alpha:s-2"]') as HTMLElement
      expect(first.getAttribute('aria-current')).toBe('true')
      expect(second.getAttribute('aria-current')).toBeNull()

      await act(async () => { fireEvent.click(second) })
      expect(openSession).toHaveBeenCalledExactlyOnceWith('alpha:s-2', { cwd: '/repo' })
      await settle()
      expect(first.getAttribute('aria-current')).toBeNull()
      expect(second.getAttribute('aria-current')).toBe('true')
    } finally {
      await sidebar.dispose()
    }
  })

  it('boots without a sessions service and renders rows without a current marker', async () => {
    const b = await bench()
    b.ctx.provide('uiWorkspace', { startSession: vi.fn(), openSession: vi.fn() } as never)
    b.ctx.provide('remote.controlPlane', {
      tree: async () => ({ ok: true as const, value: [connected(ROWS)] }),
      reconnect: vi.fn(),
    } as never)
    const sidebar = b.ctx.plugin({ inject: [...inject], apply })
    await sidebar.await()
    try {
      const view = mountSection(b.slots)
      await settle()
      expect(view.container.querySelectorAll('[data-session-key]')).toHaveLength(2)
      expect(view.container.querySelector('[aria-current="true"]')).toBeNull()
    } finally {
      await sidebar.dispose()
    }
  })
})

describe('dictionaries', () => {
  const dictionaries: Readonly<Record<string, Record<string, string>>> = {
    zh, en, ja, es, fr, de, ru, pt,
  }

  it('carries both new keys in all eight languages with their placeholders', () => {
    expect(Object.keys(dictionaries)).toHaveLength(8)
    for (const [language, dictionary] of Object.entries(dictionaries)) {
      expect(dictionary['instances.session.open'], `${language} is missing instances.session.open`)
        .toContain('{name}')
      expect(dictionary['instances.openFailed'], `${language} is missing instances.openFailed`)
        .toContain('{message}')
    }
  })
})
