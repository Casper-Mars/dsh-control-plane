// @vitest-environment jsdom
/**
 * Independent t100635 verification (tester-authored).
 *
 * Runtime checks of the sidebar half of the reachability change:
 *
 * 1. An unreachable group reads "Offline" with its error and a Retry control,
 *    never "0 sessions"; a connected empty group reads "0" + "No sessions"
 *    with no error block and no Retry.
 * 2. Clicking Retry calls `retry(instanceId)`, re-reads the tree, disables the
 *    button and shows "Retrying" while in flight, and renders the *new* reason
 *    when the retry fails.
 * 3. Regressions: title priority, the 8→16→20→collapse ladder, folding across
 *    a 6000 ms poll, no polling while `wide=false`, and a plain dsh Client
 *    (no `remote.controlPlane`) neither rendering nor calling anything.
 *
 * Direct component renders cover presentation and retry; the Context bench
 * covers the real `apply()` wiring and the plain-Client case.
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
  InstanceGroups, instanceGroupsSlot, type InstanceGroupView, type InstanceSessionView,
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

/** Flush already-resolved reader promises inside act. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

/** One session row. */
function session(instanceId: string, index: number): InstanceSessionView {
  return {
    key: `${instanceId}:session-${index}`,
    sessionId: `session-${index}`,
    running: false,
    updatedAt: Date.now(),
  }
}

/** One instance group with `count` sessions in one workspace. */
function group(
  instanceId: string,
  count: number,
  overrides: { state?: InstanceGroupView['state']; error?: string } = {},
): InstanceGroupView {
  const state = overrides.state ?? 'connected'
  return {
    instanceId,
    label: `${instanceId.toUpperCase()}(${instanceId})`,
    state,
    ...(overrides.error === undefined ? {} : { error: overrides.error }),
    runningCount: 0,
    sessionCount: count,
    workspaces: count === 0 || state !== 'connected'
      ? []
      : [{
        key: `${instanceId}:/workspace`,
        path: '/workspace',
        runningCount: 0,
        sessions: Array.from({ length: count }, (_, index) => session(instanceId, index)),
      }],
  }
}

/** A `retry` reader that resolves immediately and records its calls. */
function retrySpy(): ReturnType<typeof vi.fn<(instanceId: string) => Promise<void>>> {
  return vi.fn<(instanceId: string) => Promise<void>>(async () => {})
}

// ---------------------------------------------------------------------------
// 1 — offline ≠ empty in the rendered group
// ---------------------------------------------------------------------------
describe('t100635 / offline vs empty rendering', () => {
  it('renders Offline + reason + Retry instead of a 0 session count', async () => {
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group('ver-off', 0, { state: 'unreachable', error: 'connect ECONNREFUSED' })]}
        retry={retrySpy()}
        t={t}
      />,
    )
    await settle()

    const header = screen.getByRole('button', { name: 'VER-OFF(ver-off), Unreachable' })
    expect(header.getAttribute('data-instance-state')).toBe('unreachable')
    // The trailing cell says Offline, never "0".
    expect(header.textContent).toBe('VER-OFF(ver-off)Offline')
    expect(container.querySelector('[data-state="error"]')).not.toBeNull()

    const notice = container.querySelector('[data-instance-offline="ver-off"]') as HTMLElement
    expect(notice.textContent).toContain('connect ECONNREFUSED')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()

    // Nothing that belongs to the connected-empty case.
    expect(screen.queryByText('No sessions')).toBeNull()
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(0)
  })

  it('renders 0 + No sessions and no retry for a connected empty instance', async () => {
    const { container } = render(
      <InstanceGroups fetchTree={async () => [group('ver-empty', 0)]} retry={retrySpy()} t={t} />,
    )
    await settle()

    const header = screen.getByRole('button', { name: 'VER-EMPTY(ver-empty), Connected, 0 sessions' })
    expect(header.getAttribute('data-instance-state')).toBe('connected')
    expect(header.textContent).toBe('VER-EMPTY(ver-empty)0')
    expect(screen.getByText('No sessions')).toBeTruthy()

    expect(container.querySelector('[data-instance-offline]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('reads the count cell from the frame state even when sessionCount disagrees', async () => {
    // A stale/inconsistent frame: the state field is authoritative for the
    // header cell, so this can never render as "3 sessions" while offline.
    const inconsistent: InstanceGroupView = {
      instanceId: 'ver-mixed',
      label: 'VER-MIXED(ver-mixed)',
      state: 'unreachable',
      error: 'gone',
      runningCount: 0,
      sessionCount: 3,
      workspaces: [],
    }
    render(<InstanceGroups fetchTree={async () => [inconsistent]} retry={retrySpy()} t={t} />)
    await settle()
    const header = screen.getByRole('button', { name: /VER-MIXED\(ver-mixed\)/ })
    expect(header.textContent).toBe('VER-MIXED(ver-mixed)Offline')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 2 — the retry chain
// ---------------------------------------------------------------------------
describe('t100635 / retry chain', () => {
  it('calls retry(instanceId), then re-reads the tree and renders the outcome', async () => {
    const order: string[] = []
    let tree = group('ver-retry', 0, { state: 'unreachable', error: 'down' })
    const fetchTree = vi.fn(async () => { order.push('tree'); return [tree] })
    const retry = vi.fn(async (instanceId: string) => {
      order.push(`retry:${instanceId}`)
      tree = group('ver-retry', 2)
    })
    const { container } = render(<InstanceGroups fetchTree={fetchTree} retry={retry} t={t} />)
    await settle()
    expect(container.querySelector('[data-instance-offline="ver-retry"]')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()

    expect(retry).toHaveBeenCalledExactlyOnceWith('ver-retry')
    expect(fetchTree).toHaveBeenCalledTimes(2)
    // The re-read follows the retry, so the group shows this attempt's outcome.
    expect(order).toEqual(['tree', 'retry:ver-retry', 'tree'])
    expect(container.querySelector('[data-instance-offline="ver-retry"]')).toBeNull()
    expect(screen.getByRole('button', { name: /VER-RETRY\(ver-retry\), Connected, 2 sessions/ })).toBeTruthy()
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(2)
  })

  it('disables the button and shows Retrying while in flight, without an early re-read', async () => {
    let release: () => void = () => {}
    const retry = vi.fn(async () => { await new Promise<void>((resolve) => { release = resolve }) })
    const fetchTree = vi.fn(async () => [
      group('ver-slow', 0, { state: 'unreachable' as const, error: 'down' }),
    ])
    render(<InstanceGroups fetchTree={fetchTree} retry={retry} t={t} />)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    const busy = screen.getByRole('button', { name: 'Retrying' }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    expect(fetchTree).toHaveBeenCalledTimes(1)

    fireEvent.click(busy)
    expect(retry).toHaveBeenCalledTimes(1)

    await act(async () => {
      release()
      await Promise.resolve()
    })
    await settle()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(fetchTree).toHaveBeenCalledTimes(2)
  })

  it('renders the new failure reason after a failed retry', async () => {
    let tree = group('ver-flaky', 0, { state: 'unreachable', error: 'first: refused' })
    const fetchTree = vi.fn(async () => [tree])
    const retry = vi.fn(async () => {
      tree = group('ver-flaky', 0, { state: 'unreachable', error: 'second: timeout' })
    })
    const { container } = render(<InstanceGroups fetchTree={fetchTree} retry={retry} t={t} />)
    await settle()
    expect(container.querySelector('[data-instance-offline="ver-flaky"]')?.textContent).toContain('first: refused')

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()
    const notice = container.querySelector('[data-instance-offline="ver-flaky"]')?.textContent ?? ''
    expect(notice).toContain('second: timeout')
    expect(notice).not.toContain('first: refused')
  })
})

// ---------------------------------------------------------------------------
// 3 — regressions
// ---------------------------------------------------------------------------
describe('t100635 / regression: session titles', () => {
  it('prefers title, then sessionId, then the key suffix', async () => {
    const makeRow = (overrides: Partial<InstanceSessionView>): InstanceSessionView => ({
      key: 'ver-title:session-x', running: false, updatedAt: Date.now(), ...overrides,
    })
    render(
      <InstanceGroups
        fetchTree={async () => [{
          instanceId: 'ver-title',
          label: 'VER-TITLE(ver-title)',
          state: 'connected',
          runningCount: 0,
          sessionCount: 3,
          workspaces: [{
            key: 'ver-title:/w',
            path: '/w',
            runningCount: 0,
            sessions: [
              makeRow({ key: 'ver-title:s1', sessionId: 's1', title: '  Fix the login flow  ' }),
              makeRow({ key: 'ver-title:s2', sessionId: 's2', title: '   ' }),
              makeRow({ key: 'ver-title:s3' }),
            ],
          }],
        }]}
        retry={retrySpy()}
        t={t}
      />,
    )
    await settle()
    expect(screen.getByText('Fix the login flow')).toBeTruthy()
    expect(screen.getByText('s2')).toBeTruthy()
    expect(screen.getByText('s3')).toBeTruthy()
    expect(screen.queryByText('   ')).toBeNull()
  })
})

describe('t100635 / regression: session ladder and folding', () => {
  it('reveals 8 → 16 → 20 rows, then collapses back to 8', async () => {
    const { container } = render(
      <InstanceGroups fetchTree={async () => [group('ver-ladder', 20)]} retry={retrySpy()} t={t} />,
    )
    await settle()
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(8)

    fireEvent.click(screen.getByRole('button', { name: 'Show 12 more sessions' }))
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(16)

    fireEvent.click(screen.getByRole('button', { name: 'Show 4 more sessions' }))
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(20)

    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(8)
  })

  it('keeps a folded group folded across a 6000 ms poll', async () => {
    vi.useFakeTimers()
    const fetchTree = vi.fn(async () => [group('ver-fold', 2)])
    render(<InstanceGroups fetchTree={fetchTree} retry={retrySpy()} t={t} intervalMs={6000} />)
    await settle()
    const header = screen.getByRole('button', { name: /VER-FOLD\(ver-fold\)/ })
    expect(header.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(header)
    expect(screen.getByRole('button', { name: /VER-FOLD\(ver-fold\)/ }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('session-0')).toBeNull()

    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(fetchTree).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('session-0')).toBeNull()
    expect(screen.getByRole('button', { name: /VER-FOLD\(ver-fold\)/ }).getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: /VER-FOLD\(ver-fold\)/ }))
    expect(screen.getByText('session-0')).toBeTruthy()
  })
})

describe('t100635 / regression: rail and plain dsh', () => {
  it('renders nothing and never polls while wide=false', async () => {
    vi.useFakeTimers()
    const fetchTree = vi.fn(async () => [group('ver-rail', 2)])
    const retry = retrySpy()
    const Slot = instanceGroupsSlot({ fetchTree, retry })
    const { container } = render(<Slot t={t} wide={false} />)
    await settle()
    await act(async () => { await vi.advanceTimersByTimeAsync(18_000) })

    expect(container.querySelector('[data-dsh-instance-groups]')).toBeNull()
    expect(fetchTree).not.toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
  })

  it('renders nothing on a plain dsh Client and makes no control-plane read', async () => {
    vi.useFakeTimers()
    const root = new Context()
    let ctx: Context | undefined
    const owner = root.plugin((owned: Context) => { ctx = owned })
    owners.add(owner)
    await owner.await()
    if (ctx === undefined) throw new Error('the sidebar fixture owner did not activate')
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('shortcuts', { catalog: createSnapshotStore([]) } as never)
    ctx.provide('layout', { toggleSidebar: vi.fn(), selectPanel: vi.fn() } as never)
    ctx.provide('uiWorkspace', { startSession: vi.fn() } as never)
    ctx.provide('locale', new LocaleRuntime(ctx))
    const slots = ctx.get('slots') as SlotRegistry
    slots.register(
      { name: 'root', children: { sidebar: { kind: 'single', scope: 'root' } } },
      ({ renderSlot }: PropsRenderSlots<'sidebar'>) => renderSlot('sidebar', { collapsed: false, width: 300, drawer: false }),
    )
    const sidebar = ctx.plugin({ inject: [...inject], apply })
    await sidebar.await()
    try {
      // A plain Client has no such namespace at all; there is nothing to call.
      expect(ctx.get('remote.controlPlane')).toBeUndefined()
      // The section still registers (the reader, not the registration, decides).
      expect(slots.entries('sidebar.instances')).toHaveLength(1)

      const entry = slots.entries('sidebar.instances')[0]!
      const Section = entry.component as ComponentType<{ t: typeof t; wide: boolean }>
      const view = render(<Section t={t} wide />)
      await settle()
      await act(async () => { await vi.advanceTimersByTimeAsync(18_000) })

      expect(view.container.querySelector('[data-dsh-instance-groups]')).toBeNull()
      expect(screen.queryByText(/sessions/)).toBeNull()
    } finally {
      await sidebar.dispose()
    }
  })

  it('reads the tree through the control-plane envelope once composed', async () => {
    const root = new Context()
    let ctx: Context | undefined
    const owner = root.plugin((owned: Context) => { ctx = owned })
    owners.add(owner)
    await owner.await()
    if (ctx === undefined) throw new Error('the sidebar fixture owner did not activate')
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('shortcuts', { catalog: createSnapshotStore([]) } as never)
    ctx.provide('layout', { toggleSidebar: vi.fn(), selectPanel: vi.fn() } as never)
    ctx.provide('uiWorkspace', { startSession: vi.fn() } as never)
    ctx.provide('locale', new LocaleRuntime(ctx))
    const slots = ctx.get('slots') as SlotRegistry
    slots.register(
      { name: 'root', children: { sidebar: { kind: 'single', scope: 'root' } } },
      ({ renderSlot }: PropsRenderSlots<'sidebar'>) => renderSlot('sidebar', { collapsed: false, width: 300, drawer: false }),
    )
    const tree = vi.fn(async () => ({ ok: true as const, value: [group('ver-wire', 1)] }))
    const reconnect = vi.fn(async () => ({ ok: true as const, value: { state: 'connected' as const } }))
    ctx.provide('remote.controlPlane', { tree, reconnect } as never)
    const sidebar = ctx.plugin({ inject: [...inject], apply })
    await sidebar.await()
    try {
      const entry = slots.entries('sidebar.instances')[0]!
      const Section = entry.component as ComponentType<{ t: typeof t; wide: boolean }>
      const view = render(<Section t={t} wide />)
      await settle()
      expect(tree).toHaveBeenCalledOnce()
      expect(view.getByText('session-0')).toBeTruthy()
    } finally {
      await sidebar.dispose()
    }
  })
})
