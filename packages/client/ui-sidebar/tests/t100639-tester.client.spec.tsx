// @vitest-environment jsdom
/**
 * t100639 independent tester suite — the control-plane Session row.
 *
 * The developer's `t100639-session-row.client.spec.tsx` covers the happy paths
 * and the `apply()` wiring. This suite is a separate, adversarial pass over the
 * same deliverable:
 *
 *   1. activation from a child element, unmodified Enter/Space, modified
 *      chords inert, and `target !== currentTarget` keyboard events ignored;
 *   2. exactly one `openSession` per Space press (default prevented, so the
 *      browser's synthesized click never lands as a second activation);
 *   3. the current marker follows the mock source and is absent when the source
 *      reports nothing;
 *   4. no rows under an unreachable instance, an empty instance, or a folded
 *      instance/workspace;
 *   5. a plain dsh Client (no `remote.controlPlane`) renders nothing and never
 *      navigates;
 *   6. keyboard-focusable button semantics, an action-shaped accessible name,
 *      and a non-colour selected state;
 *   7. regressions: the 8→16→20 pagination ladder, folding across a 6s poll,
 *      and the retry control.
 *
 * Nothing here changes production code or the developer's spec.
 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import {
  InstanceGroups, type InstanceGroupView, type InstanceSessionView,
} from '../src/client/InstanceGroups.tsx'
import { apply, inject } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

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
function session(key: string, title?: string, minutesAgo = 0): InstanceSessionView {
  const separator = key.indexOf(':')
  return {
    key,
    sessionId: key.slice(separator + 1),
    ...(title === undefined ? {} : { title }),
    running: false,
    updatedAt: Date.now() - minutesAgo * 60_000,
  }
}

/** One instance with one workspace holding the given rows. */
function groupOf(
  instanceId: string,
  sessions: readonly InstanceSessionView[],
  state: InstanceGroupView['state'] = 'connected',
): InstanceGroupView {
  return {
    instanceId,
    label: `${instanceId.toUpperCase()}(${instanceId})`,
    state,
    ...(state === 'unreachable' ? { error: 'connect ECONNREFUSED' } : {}),
    runningCount: 0,
    sessionCount: sessions.length,
    workspaces: sessions.length === 0
      ? []
      : [{ key: `${instanceId}:/repo`, path: '/repo', runningCount: 0, sessions }],
  }
}

/** Render the section and flush its first frame. */
async function renderSection(
  groups: readonly InstanceGroupView[],
  extra: {
    readonly fetchTree?: () => Promise<readonly InstanceGroupView[]>
    readonly openSession?: (key: string) => void
    readonly currentSession?: { getSnapshot(): string | undefined; subscribe(listener: () => void): () => void }
    readonly intervalMs?: number
    readonly retry?: (instanceId: string) => Promise<void>
  } = {},
) {
  const view = render(
    <InstanceGroups
      fetchTree={extra.fetchTree ?? (async () => groups)}
      retry={extra.retry ?? vi.fn(async () => {})}
      {...(extra.openSession === undefined ? {} : { openSession: extra.openSession })}
      {...(extra.currentSession === undefined ? {} : { currentSession: extra.currentSession })}
      {...(extra.intervalMs === undefined ? {} : { intervalMs: extra.intervalMs })}
      t={t}
    />,
  )
  await settle()
  return view
}

/** Resolve one rendered row or fail with the key that was missing. */
function rowOf(container: HTMLElement, key: string): HTMLElement {
  const row = container.querySelector(`[data-session-key="${key}"]`)
  if (row === null) throw new Error(`row ${key} was not rendered`)
  return row as HTMLElement
}

/** A current-Session source over a mutable store, shaped like index.ts builds one. */
function currentSource(initial: string | undefined) {
  const store = createSnapshotStore<string | undefined>(initial)
  return {
    store,
    source: {
      getSnapshot: () => store.getSnapshot(),
      subscribe: (listener: () => void) => store.subscribe(listener),
    },
  }
}

// ---------------------------------------------------------------------------
// 1 + 2. Activation: click, keyboard, modifiers, child targets, single fire
// ---------------------------------------------------------------------------

describe('1/2. session row activation', () => {
  it('opens the complete federated key exactly once per click, on the row and on a child', async () => {
    const openSession = vi.fn<(key: string) => void>()
    const { container } = await renderSection([groupOf('act1', [session('act1:s-1', 'Fix the login flow')])], { openSession })
    const row = rowOf(container, 'act1:s-1')

    fireEvent.click(row)
    expect(openSession).toHaveBeenCalledTimes(1)
    expect(openSession.mock.calls[0]).toEqual(['act1:s-1'])

    openSession.mockClear()
    fireEvent.click(within(container).getByText('Fix the login flow'))
    expect(openSession).toHaveBeenCalledTimes(1)
    expect(openSession.mock.calls[0]).toEqual(['act1:s-1'])
  })

  it('opens once when the timestamp child is clicked (bubbles to the row)', async () => {
    const openSession = vi.fn<(key: string) => void>()
    const { container } = await renderSection([groupOf('act2', [session('act2:s-1', 'Title')])], { openSession })
    fireEvent.click(within(container).getByText('now'))
    expect(openSession).toHaveBeenCalledTimes(1)
    expect(openSession.mock.calls[0]).toEqual(['act2:s-1'])
  })

  it('opens on an unmodified Enter, exactly once', async () => {
    const openSession = vi.fn<(key: string) => void>()
    const { container } = await renderSection([groupOf('act3', [session('act3:s-1', 'Title')])], { openSession })
    const row = rowOf(container, 'act3:s-1')
    // fireEvent returns !defaultPrevented. Enter must be consumed by the row so
    // the browser cannot also synthesize a click.
    expect(fireEvent.keyDown(row, { key: 'Enter' })).toBe(false)
    expect(openSession).toHaveBeenCalledTimes(1)
    expect(openSession.mock.calls[0]).toEqual(['act3:s-1'])
  })

  it('opens on an unmodified Space exactly once and suppresses the native click', async () => {
    const openSession = vi.fn<(key: string) => void>()
    const { container } = await renderSection([groupOf('act4', [session('act4:s-1', 'Title')])], { openSession })
    const row = rowOf(container, 'act4:s-1')

    const notPrevented = fireEvent.keyDown(row, { key: ' ', code: 'Space' })
    // defaultPrevented is the runtime evidence that the browser's synthesized
    // click after keyup will not fire; jsdom itself never synthesizes it.
    expect(notPrevented).toBe(false)
    expect(openSession).toHaveBeenCalledTimes(1)

    // A keyup adds nothing (no keyup handler, no second open).
    fireEvent.keyUp(row, { key: ' ', code: 'Space' })
    expect(openSession).toHaveBeenCalledTimes(1)
  })

  it('ignores modified Enter/Space chords and still consumes the press', async () => {
    const openSession = vi.fn<(key: string) => void>()
    const { container } = await renderSection([groupOf('act5', [session('act5:s-1', 'Title')])], { openSession })
    const row = rowOf(container, 'act5:s-1')

    const chords = [
      { key: 'Enter', ctrlKey: true },
      { key: 'Enter', metaKey: true },
      { key: 'Enter', altKey: true },
      { key: 'Enter', shiftKey: true },
      { key: ' ', ctrlKey: true },
      { key: ' ', metaKey: true },
      { key: ' ', altKey: true },
      { key: ' ', shiftKey: true },
    ] as const
    for (const chord of chords) {
      expect(fireEvent.keyDown(row, chord)).toBe(false)
    }
    expect(openSession).not.toHaveBeenCalled()

    // Unrelated keys are neither handled nor consumed.
    expect(fireEvent.keyDown(row, { key: 'a' })).toBe(true)
    expect(openSession).not.toHaveBeenCalled()
  })

  it('ignores Enter/Space that originate on a child (target !== currentTarget)', async () => {
    const openSession = vi.fn<(key: string) => void>()
    const { container } = await renderSection([groupOf('act6', [session('act6:s-1', 'Fix the login flow')])], { openSession })
    const title = within(container).getByText('Fix the login flow')

    fireEvent.keyDown(title, { key: 'Enter' })
    fireEvent.keyDown(title, { key: ' ' })
    expect(openSession).not.toHaveBeenCalled()

    // The same child's click still bubbles to the row: one open.
    fireEvent.click(title)
    expect(openSession).toHaveBeenCalledTimes(1)
    expect(openSession.mock.calls[0]).toEqual(['act6:s-1'])
  })
})

// ---------------------------------------------------------------------------
// 3. Current-row marker
// ---------------------------------------------------------------------------

describe('3. current-row marker', () => {
  it('marks only the current Session and follows every source change', async () => {
    const { store, source } = currentSource('hl:s-1')
    const openSession = vi.fn<(key: string) => void>()
    const { container } = await renderSection(
      [groupOf('hl', [session('hl:s-1', 'First'), session('hl:s-2', 'Second')])],
      { openSession, currentSession: source },
    )
    const first = rowOf(container, 'hl:s-1')
    const second = rowOf(container, 'hl:s-2')
    expect(first.getAttribute('aria-current')).toBe('true')
    expect(second.getAttribute('aria-current')).toBeNull()

    await act(async () => { store.set('hl:s-2') })
    expect(first.getAttribute('aria-current')).toBeNull()
    expect(second.getAttribute('aria-current')).toBe('true')
    expect(container.querySelectorAll('[aria-current="true"]')).toHaveLength(1)

    await act(async () => { store.set('hl:s-1') })
    expect(first.getAttribute('aria-current')).toBe('true')
    expect(second.getAttribute('aria-current')).toBeNull()

    await act(async () => { store.set(undefined) })
    expect(container.querySelector('[aria-current="true"]')).toBeNull()
    // Navigation never fired from highlighting.
    expect(openSession).not.toHaveBeenCalled()
  })

  it('renders no marker at all when the source starts empty', async () => {
    const { source } = currentSource(undefined)
    const { container } = await renderSection(
      [groupOf('hl2', [session('hl2:s-1', 'Only')])],
      { currentSession: source },
    )
    expect(container.querySelector('[aria-current]')).toBeNull()
  })

  it('moves the marker with the source but keeps the visible text unchanged', async () => {
    const { store, source } = currentSource('hl3:s-1')
    const { container } = await renderSection(
      [groupOf('hl3', [session('hl3:s-1', 'Alpha title'), session('hl3:s-2', 'Beta title')])],
      { currentSession: source },
    )
    const before = rowOf(container, 'hl3:s-1').textContent
    await act(async () => { store.set('hl3:s-2') })
    expect(rowOf(container, 'hl3:s-1').textContent).toBe(before)
    expect(within(container).getByText('Alpha title')).toBeTruthy()
    expect(within(container).getByText('Beta title')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 4. Offline, empty, folded
// ---------------------------------------------------------------------------

describe('4. no clickable rows where there is nothing to open', () => {
  it('renders no rows for a stale unreachable frame that still carries workspaces', async () => {
    const openSession = vi.fn<(key: string) => void>()
    const stale = groupOf('off4', [session('off4:s-1', 'Stale row')], 'unreachable')
    const { container } = await renderSection([stale], { openSession })
    expect(container.querySelector('[data-dsh-instance-groups]')).not.toBeNull()
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: /^Open session/ })).toHaveLength(0)
    // The offline notice is still there, so the frame was not silently dropped.
    expect(container.querySelector('[data-instance-offline="off4"]')).not.toBeNull()
    expect(openSession).not.toHaveBeenCalled()
  })

  it('renders no rows for a connected instance without workspaces', async () => {
    const openSession = vi.fn<(key: string) => void>()
    const { container } = await renderSection([groupOf('empty4', [])], { openSession })
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(0)
    expect(within(container).getByText('No sessions')).toBeTruthy()
    expect(container.querySelector('[data-instance-offline]')).toBeNull()
    expect(openSession).not.toHaveBeenCalled()
  })

  it('removes the rows when the instance is folded and restores them when unfolded', async () => {
    const openSession = vi.fn<(key: string) => void>()
    const { container } = await renderSection(
      [groupOf('fold4', [session('fold4:s-1', 'A'), session('fold4:s-2', 'B')])],
      { openSession },
    )
    const header = container.querySelector('[data-instance-id="fold4"]') as HTMLElement
    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(0)
    fireEvent.click(header)
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(2)
    expect(openSession).not.toHaveBeenCalled()
  })

  it('removes the rows when the workspace is folded and restores them when unfolded', async () => {
    const { container } = await renderSection(
      [groupOf('foldw4', [session('foldw4:s-1', 'A')])],
    )
    const workspace = container.querySelector('[data-workspace-key="foldw4:/repo"]') as HTMLElement
    fireEvent.click(workspace)
    expect(workspace.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(0)
    fireEvent.click(workspace)
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 5. Plain dsh: no control plane
// ---------------------------------------------------------------------------

/** The shell frame the sidebar registers into: one `sidebar` hole. */
function SidebarFrame({ renderSlot }: PropsRenderSlots<'sidebar'>) {
  return renderSlot('sidebar', { collapsed: false, width: 300, drawer: false })
}

/** A test Client with the services ui-sidebar needs, and the `sidebar` hole declared. */
async function benchWithoutControlPlane() {
  const root = new Context()
  let ctx: Context | undefined
  const owner = root.plugin((owned: Context) => { ctx = owned })
  owners.add(owner)
  await owner.await()
  if (ctx === undefined) throw new Error('the sidebar fixture owner did not activate')
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('shortcuts', { catalog: createSnapshotStore([]) } as never)
  ctx.provide('layout', { toggleSidebar: vi.fn(), selectPanel: vi.fn() } as never)
  const openSession = vi.fn<(key: string) => void>()
  ctx.provide('uiWorkspace', { startSession: vi.fn(), openSession } as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const slots = ctx.get('slots') as SlotRegistry
  slots.register(
    { name: 'root', children: { sidebar: { kind: 'single', scope: 'root' } } },
    SidebarFrame,
  )
  return { ctx, slots, openSession }
}

/** Render the registered instance section the way the renderer does. */
function mountSection(slots: SlotRegistry) {
  const entry = slots.entries('sidebar.instances')[0]
  if (entry === undefined) throw new Error('the instance section did not register')
  const Section = entry.component as ComponentType<{ t: typeof t; wide: boolean }>
  return render(<Section t={t} wide />)
}

describe('5. plain dsh without a control plane', () => {
  it('renders nothing, resolves no Remote namespace, and never opens a Session', async () => {
    const { ctx, slots, openSession } = await benchWithoutControlPlane()
    expect(ctx.get('remote.controlPlane')).toBeUndefined()

    const sidebar = ctx.plugin({ inject: [...inject], apply })
    await sidebar.await()
    try {
      // Observed contract: the slot entry exists, but contributes no output.
      // (The task statement says "不注册"; the S2 contract registers an inert
      // section instead — recorded in the tester report.)
      expect(slots.entries('sidebar.instances')).toHaveLength(1)
      const view = mountSection(slots)
      await settle()
      expect(view.container.querySelector('[data-dsh-instance-groups]')).toBeNull()
      expect(view.container.innerHTML).toBe('')
      expect(openSession).not.toHaveBeenCalled()
      // No namespace appeared just because the section mounted and polled.
      expect(ctx.get('remote.controlPlane')).toBeUndefined()
    } finally {
      await sidebar.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// 6. Accessibility
// ---------------------------------------------------------------------------

describe('6. accessibility of the session row', () => {
  it('is a focusable button whose accessible name is the action, not the raw row text', async () => {
    const { container } = await renderSection(
      [groupOf('a11y', [session('a11y:s-1', 'Fix the login flow', 5)])],
    )
    const row = rowOf(container, 'a11y:s-1')
    expect(row.tagName).toBe('BUTTON')
    expect(row.getAttribute('type')).toBe('button')
    expect(row.tabIndex).toBe(0)
    // Name is the action; the visible title and time stay in the row's text.
    expect(row.getAttribute('aria-label')).toBe('Open session Fix the login flow')
    expect(row.textContent).toContain('Fix the login flow')
    expect(row.textContent).toContain('5min')
    // No nested focusable/interactive elements inside the row.
    expect(row.querySelectorAll('button, a, input, select, textarea, [tabindex]')).toHaveLength(0)
  })

  it('exposes the selected state through aria-current, not colour alone', async () => {
    const { source } = currentSource('a11yb:s-1')
    const { container } = await renderSection(
      [groupOf('a11yb', [session('a11yb:s-1', 'Selected'), session('a11yb:s-2', 'Other')])],
      { currentSession: source },
    )
    const selected = rowOf(container, 'a11yb:s-1')
    const other = rowOf(container, 'a11yb:s-2')
    expect(selected.getAttribute('aria-current')).toBe('true')
    expect(other.hasAttribute('aria-current')).toBe(false)
    // The visual class also differs, but the ARIA state is the contract.
    expect(selected.className).not.toBe(other.className)
  })
})

// ---------------------------------------------------------------------------
// 7. Regressions: pagination, polling, retry
// ---------------------------------------------------------------------------

describe('7. regressions around the row change', () => {
  it('walks the 8 → 16 → 20 pagination ladder and still opens a revealed row', async () => {
    const openSession = vi.fn<(key: string) => void>()
    const sessions = Array.from({ length: 20 }, (_, index) => session(`pager:s-${index}`, `Session ${index}`))
    const { container } = await renderSection([groupOf('pager', sessions)], { openSession, intervalMs: 60_000 })

    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(8)
    fireEvent.click(screen.getByRole('button', { name: 'Show 12 more sessions' }))
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(16)
    fireEvent.click(screen.getByRole('button', { name: 'Show 4 more sessions' }))
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(20)
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(8)

    // Reveal again and activate a row that only exists past the watermark.
    fireEvent.click(screen.getByRole('button', { name: 'Show 12 more sessions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show 4 more sessions' }))
    fireEvent.click(rowOf(container, 'pager:s-19'))
    expect(openSession).toHaveBeenCalledTimes(1)
    expect(openSession.mock.calls[0]).toEqual(['pager:s-19'])
  })

  it('keeps a folded instance folded across a 6s poll', async () => {
    vi.useFakeTimers()
    const fetchTree = vi.fn(async () => [groupOf('poll7', [session('poll7:s-1', 'A')])])
    render(<InstanceGroups fetchTree={fetchTree} retry={vi.fn(async () => {})} t={t} intervalMs={6000} />)
    await settle()
    const header = screen.getByRole('button', { name: /POLL7\(poll7\)/ })
    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryAllByText('A')).toHaveLength(0)

    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(fetchTree).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: /POLL7\(poll7\)/ }).getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelectorAll('[data-session-key]')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: /POLL7\(poll7\)/ }))
    expect(document.querySelectorAll('[data-session-key]')).toHaveLength(1)
  })

  it('still routes the retry control and recovers the rows after a successful retry', async () => {
    let tree = groupOf('retry7', [session('retry7:s-1', 'Back')], 'unreachable')
    const fetchTree = vi.fn(async () => [tree])
    const retry = vi.fn(async () => { tree = groupOf('retry7', [session('retry7:s-1', 'Back')]) })
    const { container } = await renderSection([tree], { fetchTree, retry, intervalMs: 60_000 })

    expect(container.querySelector('[data-instance-offline="retry7"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()
    expect(retry).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledWith('retry7')
    expect(container.querySelector('[data-instance-offline="retry7"]')).toBeNull()
    expect(rowOf(container, 'retry7:s-1')).toBeTruthy()
  })
})
