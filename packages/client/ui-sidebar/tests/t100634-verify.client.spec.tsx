// @vitest-environment jsdom
/**
 * Independent t100634 verification (tester-authored): the sidebar side of the
 * session-title priority.
 *
 * Covers the three-level display fallback (reported title → instance-local id →
 * federated key suffix), the hover tooltip that must keep the full federated
 * key whether or not a title is shown, and the paging/fold regression that a
 * title-bearing tree must not disturb (8 → 16 → 20 → collapse → 8, with the 6s
 * poll neither re-expanding the ladder nor unfolding the instance).
 *
 * Every case uses its own instance id: the disclosure store is module-level
 * and intentionally survives frames and remounts, so ids must not be shared.
 */
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InstanceGroups,
  type InstanceGroupView, type InstanceInfoView, type InstanceSessionView,
} from '../src/client/InstanceGroups.tsx'
import { en, zh } from '../src/client/locales.ts'

const t = makeTranslate({ ...commonEn, ...en })

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** Flush the readers' already-resolved promises inside act. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

/** Advance fake time and flush the poll's promises. */
async function tick(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

/** One session row with explicit title control. */
function session(instanceId: string, index: number, title?: string): InstanceSessionView {
  return {
    key: `${instanceId}:session-${index}`,
    sessionId: `session-${index}`,
    ...(title === undefined ? {} : { title }),
    running: false,
    updatedAt: Date.now() - index * 60_000,
  }
}

/** One instance group over a single workspace. */
function group(instanceId: string, sessions: readonly InstanceSessionView[]): InstanceGroupView {
  return {
    instanceId,
    label: `${instanceId}(id)`,
    runningCount: 0,
    sessionCount: sessions.length,
    workspaces: [{
      key: `${instanceId}:/workspace`,
      path: '/workspace',
      runningCount: 0,
      sessions,
    }],
  }
}

/** Reachability frame for the given instances. */
function reach(ids: readonly string[]): readonly InstanceInfoView[] {
  return ids.map(id => ({ id, label: `${id}(id)`, state: 'connected' }))
}

/** Count rendered session rows. */
function rows(container: HTMLElement): number {
  return container.querySelectorAll('[data-session-key]').length
}

/** One session row element by federated key. */
function rowOf(container: HTMLElement, key: string): HTMLElement {
  const row = container.querySelector(`[data-session-key="${key}"]`)
  if (row === null) throw new Error(`no session row for ${key}`)
  return row as HTMLElement
}

// ---------------------------------------------------------------------------
// 1 — title wins, trimmed, and the tooltip keeps the federated key
// ---------------------------------------------------------------------------
describe('session title priority: title first', () => {
  it('shows the trimmed title, hides the id, and keeps the full federated key on hover', async () => {
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group('t100a', [session('t100a', 1, '  Fix the login flow  ')])]}
        fetchInstances={async () => reach(['t100a'])}
        t={t}
      />,
    )
    await settle()
    const row = rowOf(container, 't100a:session-1')
    const label = row.querySelector('[class*="title"]') as HTMLElement
    expect(label.textContent).toBe('Fix the login flow')
    expect(row.textContent).not.toContain('session-1')
    // Hover text is the routing key, never the display title.
    expect(row.getAttribute('title')).toBe('t100a:session-1')
  })

  it('shows titles on every visible row, including rows revealed by "show more"', async () => {
    vi.useFakeTimers()
    const sessions = Array.from({ length: 10 }, (_, i) => session('t100b', i, `Task ${i}`))
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group('t100b', sessions)]}
        fetchInstances={async () => reach(['t100b'])}
        t={t}
      />,
    )
    await settle()
    expect(rows(container)).toBe(8)
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more sessions' }))
    expect(rows(container)).toBe(10)
    expect(rowOf(container, 't100b:session-9').textContent).toContain('Task 9')
    await tick(6000)
    // The poll re-renders the same frame; titles stay put.
    expect(rows(container)).toBe(10)
    expect(rowOf(container, 't100b:session-9').textContent).toContain('Task 9')
  })
})

// ---------------------------------------------------------------------------
// 2 — blank title falls back to the instance-local id
// ---------------------------------------------------------------------------
describe('session title fallback: id, then key suffix', () => {
  it('falls back to the session id for empty, whitespace-only, and absent titles', async () => {
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group('t100c', [
          session('t100c', 1, ''),
          session('t100c', 2, '   '),
          session('t100c', 3, '\t\n'),
          session('t100c', 4),
        ])]}
        fetchInstances={async () => reach(['t100c'])}
        t={t}
      />,
    )
    await settle()
    for (const index of [1, 2, 3, 4]) {
      const row = rowOf(container, `t100c:session-${index}`)
      expect(row.querySelector('[class*="title"]')?.textContent).toBe(`session-${index}`)
    }
    // The tooltip stays the federated key on fallback rows too.
    expect(rowOf(container, 't100c:session-2').getAttribute('title')).toBe('t100c:session-2')
  })

  it('falls back to the key suffix when sessionId is missing as well', async () => {
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group('t100d', [
          { key: 't100d:bare-id', running: false, updatedAt: Date.now() },
          { key: 't100d:blank-title', title: '  ', running: false, updatedAt: Date.now() },
          { key: 'no-separator', running: false, updatedAt: Date.now() },
        ])]}
        fetchInstances={async () => reach(['t100d'])}
        t={t}
      />,
    )
    await settle()
    expect(rowOf(container, 't100d:bare-id').querySelector('[class*="title"]')?.textContent).toBe('bare-id')
    expect(rowOf(container, 't100d:blank-title').querySelector('[class*="title"]')?.textContent).toBe('blank-title')
    // No `:` at all: the key itself is the last resort rather than an empty label.
    expect(rowOf(container, 'no-separator').querySelector('[class*="title"]')?.textContent).toBe('no-separator')
    expect(rowOf(container, 't100d:bare-id').getAttribute('title')).toBe('t100d:bare-id')
  })
})

// ---------------------------------------------------------------------------
// 3 — paging and folds still behave with titles in the tree
// ---------------------------------------------------------------------------
describe('paging and fold regression with titled rows', () => {
  it('walks 8 / 16 / 20, collapses to 8, and the 6s poll changes nothing', async () => {
    vi.useFakeTimers()
    const sessions = Array.from({ length: 20 }, (_, i) => session('t100e', i, `Task ${i}`))
    const fetchTree = vi.fn(async () => [group('t100e', sessions)])
    const fetchInstances = vi.fn(async () => reach(['t100e']))
    const { container } = render(
      <InstanceGroups fetchTree={fetchTree} fetchInstances={fetchInstances} t={t} />,
    )
    await settle()
    expect(rows(container)).toBe(8)
    expect(screen.getByRole('button', { name: 'Show 12 more sessions' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Show 12 more sessions' }))
    expect(rows(container)).toBe(16)
    expect(rowOf(container, 't100e:session-15').textContent).toContain('Task 15')

    fireEvent.click(screen.getByRole('button', { name: 'Show 4 more sessions' }))
    expect(rows(container)).toBe(20)
    expect(rowOf(container, 't100e:session-19').textContent).toContain('Task 19')

    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(rows(container)).toBe(8)
    expect(rowOf(container, 't100e:session-7').textContent).toContain('Task 7')

    // Two poll frames at the default 6s cadence: the ladder must stay folded.
    await tick(6000)
    await tick(6000)
    expect(fetchTree).toHaveBeenCalledTimes(3)
    expect(rows(container)).toBe(8)
    expect(screen.getByRole('button', { name: 'Show 12 more sessions' })).toBeTruthy()
    expect(container.querySelector('[data-session-key="t100e:session-8"]')).toBeNull()
  })

  it('a folded instance stays folded across the poll and reopens at 8 rows', async () => {
    vi.useFakeTimers()
    const sessions = Array.from({ length: 20 }, (_, i) => session('t100f', i, `Task ${i}`))
    const fetchTree = vi.fn(async () => [group('t100f', sessions)])
    const fetchInstances = vi.fn(async () => reach(['t100f']))
    const { container } = render(
      <InstanceGroups fetchTree={fetchTree} fetchInstances={fetchInstances} t={t} />,
    )
    await settle()
    expect(rows(container)).toBe(8)

    const header = screen.getByRole('button', { name: /t100f\(id\)/ })
    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(rows(container)).toBe(0)

    await tick(6000)
    expect(fetchTree).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: /t100f\(id\)/ }).getAttribute('aria-expanded')).toBe('false')
    expect(rows(container)).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: /t100f\(id\)/ }))
    expect(rows(container)).toBe(8)
    expect(rowOf(container, 't100f:session-0').textContent).toContain('Task 0')
  })

  it('renders the zh paging labels with titled rows (locale path unchanged)', async () => {
    const zhT = makeTranslate({ ...commonZh, ...zh })
    const sessions = Array.from({ length: 20 }, (_, i) => session('t100g', i, `任务 ${i}`))
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group('t100g', sessions)]}
        fetchInstances={async () => reach(['t100g'])}
        t={zhT}
      />,
    )
    await settle()
    expect(rows(container)).toBe(8)
    fireEvent.click(screen.getByRole('button', { name: '展开其余 12 个会话' }))
    expect(rows(container)).toBe(16)
    expect(rowOf(container, 't100g:session-15').textContent).toContain('任务 15')
    fireEvent.click(screen.getByRole('button', { name: '展开其余 4 个会话' }))
    expect(rows(container)).toBe(20)
    expect(rowOf(container, 't100g:session-19').textContent).toContain('任务 19')
    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(rows(container)).toBe(8)
  })
})
