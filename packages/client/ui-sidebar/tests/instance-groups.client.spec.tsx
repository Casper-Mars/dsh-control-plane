// @vitest-environment jsdom
/**
 * Control-plane instance groups: header contents, folding that survives the
 * poll, the "show more" control that replaces silent truncation, and the
 * keep-the-previous-frame rule for failed reads.
 *
 * The section's first frame arrives from a promise, so every test settles the
 * microtask queue (inside `act`) before asserting.
 */
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InstanceGroups, instanceGroupsSlot, type InstanceGroupView, type InstanceInfoView, type InstanceSessionView,
} from '../src/client/InstanceGroups.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate({ ...commonEn, ...en })

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** Flush the readers' already-resolved promises inside act. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

/** One session row, dated `minutesAgo` in the past. */
function session(instanceId: string, index: number, minutesAgo = index): InstanceSessionView {
  return {
    key: `${instanceId}:session-${index}`,
    sessionId: `session-${index}`,
    running: index === 0,
    updatedAt: Date.now() - minutesAgo * 60_000,
  }
}

/** One instance group with `count` sessions in one workspace. */
function group(instanceId: string, count: number, path = '/workspace'): InstanceGroupView {
  return {
    instanceId,
    label: `${instanceId.toUpperCase()}(${instanceId})`,
    runningCount: count === 0 ? 0 : 1,
    sessionCount: count,
    workspaces: count === 0
      ? []
      : [{
        key: `${instanceId}:${path}`,
        path,
        sessions: Array.from({ length: count }, (_, index) => session(instanceId, index)),
        runningCount: 1,
      }],
  }
}

/** Reachability frame for the same ids, all connected unless stated. */
function reachability(ids: readonly string[], state: InstanceInfoView['state'] = 'connected'): readonly InstanceInfoView[] {
  return ids.map(id => ({ id, label: `${id.toUpperCase()}(${id})`, state }))
}

describe('InstanceGroups', () => {
  it('renders the instance name, a reachability dot and the session count', async () => {
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group('cto', 3)]}
        fetchInstances={async () => reachability(['cto'])}
        t={t}
      />,
    )
    await settle()
    const header = screen.getByRole('button', { name: 'CTO(cto), Connected, 3 sessions' })
    expect(header.getAttribute('data-instance-state')).toBe('connected')
    expect(container.querySelector('[data-state="done"]')).not.toBeNull()
    // The count rides the row's trailing edge; the label is the header's own text.
    expect(header.textContent).toBe('CTO(cto)3')
    expect(screen.getByText('/workspace')).toBeTruthy()
    expect(screen.getAllByText(/^session-/)).toHaveLength(3)
    expect(screen.getByText('now')).toBeTruthy()
  })

  it('reports the two other reachability states through the same dot vocabulary', async () => {
    const connecting = render(
      <InstanceGroups
        fetchTree={async () => [group('ops', 0)]}
        fetchInstances={async () => reachability(['ops'], 'connecting')}
        t={t}
      />,
    )
    await settle()
    expect(connecting.container.querySelector('[data-state="ongoing"]')).not.toBeNull()
    cleanup()

    const unreachable = render(
      <InstanceGroups
        fetchTree={async () => [group('ops', 0)]}
        fetchInstances={async () => reachability(['ops'], 'unreachable')}
        t={t}
      />,
    )
    await settle()
    expect(unreachable.container.querySelector('[data-state="error"]')).not.toBeNull()
  })

  it('folds a group without the poll resetting it', async () => {
    vi.useFakeTimers()
    const fetchTree = vi.fn(async () => [group('lab', 2)])
    render(<InstanceGroups fetchTree={fetchTree} fetchInstances={async () => reachability(['lab'])} t={t} />)
    await settle()
    const header = screen.getByRole('button', { name: /LAB\(lab\)/ })
    expect(header.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('session-0')).toBeNull()

    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(fetchTree).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: /LAB\(lab\)/ }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('session-0')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /LAB\(lab\)/ }))
    expect(screen.getByRole('button', { name: /LAB\(lab\)/ }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('session-0')).toBeTruthy()
  })

  it('reveals eight more sessions per click, then folds the list back', async () => {
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group('wide', 20)]}
        fetchInstances={async () => reachability(['wide'])}
        t={t}
      />,
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

  it('shows the first eight sessions and reveals the rest instead of dropping them', async () => {
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group('edge', 10)]}
        fetchInstances={async () => reachability(['edge'])}
        t={t}
      />,
    )
    await settle()
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(8)
    const more = screen.getByRole('button', { name: 'Show 2 more sessions' })
    expect(more.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(more)
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(10)
    const less = screen.getByRole('button', { name: 'Show less' })
    expect(less.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(less)
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(8)
  })

  it('keeps the previous tree when a frame fails', async () => {
    vi.useFakeTimers()
    let fail = false
    const fetchTree = vi.fn(async () => {
      if (fail) throw new Error('boom')
      return [group('core', 1)]
    })
    render(<InstanceGroups fetchTree={fetchTree} fetchInstances={async () => reachability(['core'])} t={t} />)
    await settle()
    expect(screen.getByText('session-0')).toBeTruthy()

    fail = true
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(fetchTree).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: /CORE\(core\)/ })).toBeTruthy()
    expect(screen.getByText('session-0')).toBeTruthy()
  })

  it('keeps the previous reachability when the instances read fails', async () => {
    vi.useFakeTimers()
    let fail = false
    const fetchInstances = vi.fn(async () => {
      if (fail) throw new Error('boom')
      return reachability(['stay'])
    })
    const { container } = render(
      <InstanceGroups fetchTree={async () => [group('stay', 1)]} fetchInstances={fetchInstances} t={t} />,
    )
    await settle()
    expect(container.querySelector('[data-state="done"]')).not.toBeNull()

    fail = true
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(fetchInstances).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: /STAY\(stay\), Connected/ })).toBeTruthy()
  })

  it('falls back to the key without the instance prefix when the protocol has no session id', async () => {
    render(
      <InstanceGroups
        fetchTree={async () => [{
          instanceId: 'raw',
          label: 'RAW(raw)',
          runningCount: 0,
          sessionCount: 2,
          workspaces: [{
            key: 'raw:/w',
            path: '/w',
            runningCount: 0,
            sessions: [
              { key: 'raw:opaque', running: false, updatedAt: Date.now() },
              { key: 'unqualified', running: false, updatedAt: Date.now() },
            ],
          }],
        }]}
        fetchInstances={async () => reachability(['raw'])}
        t={t}
      />,
    )
    await settle()
    expect(screen.getByText('opaque')).toBeTruthy()
    expect(screen.getByText('unqualified')).toBeTruthy()
  })

  it('shows the connecting dot until a reachability frame names the instance', async () => {
    // The instances read fails: the tree still renders and no state is known yet.
    const failed = render(
      <InstanceGroups
        fetchTree={async () => [group('pending', 0)]}
        fetchInstances={async () => { throw new Error('boom') }}
        t={t}
      />,
    )
    await settle()
    expect(failed.getByRole('button', { name: /PENDING\(pending\), Connecting/ })).toBeTruthy()
    cleanup()

    // The instances read succeeds but omits the id the tree reports.
    const missing = render(
      <InstanceGroups
        fetchTree={async () => [group('pending', 0)]}
        fetchInstances={async () => []}
        t={t}
      />,
    )
    await settle()
    expect(missing.getByRole('button', { name: /PENDING\(pending\), Connecting/ })).toBeTruthy()
  })

  it('drops frames that arrive after unmount', async () => {
    let resolveTree: (value: readonly InstanceGroupView[]) => void = () => {}
    let resolveInstances: (value: readonly InstanceInfoView[]) => void = () => {}
    const { unmount } = render(
      <InstanceGroups
        fetchTree={() => new Promise((resolve) => { resolveTree = resolve })}
        fetchInstances={() => new Promise((resolve) => { resolveInstances = resolve })}
        t={t}
      />,
    )
    unmount()
    await act(async () => {
      resolveTree([group('late', 1)])
      resolveInstances(reachability(['late']))
      await Promise.resolve()
    })
    expect(document.querySelector('[data-dsh-instance-groups]')).toBeNull()
  })

  it('folds a workspace subtree from its own row', async () => {
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group('fold', 3)]}
        fetchInstances={async () => reachability(['fold'])}
        t={t}
      />,
    )
    await settle()
    const row = container.querySelector('[data-workspace-key="fold:/workspace"]') as HTMLElement
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(3)

    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(0)

    fireEvent.click(row)
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(3)
  })

  it('mounts the slot body only while the column is wide', async () => {
    const Slot = instanceGroupsSlot({
      fetchTree: async () => [group('slot', 1)],
      fetchInstances: async () => reachability(['slot']),
    })
    const rail = render(<Slot t={t} wide={false} />)
    expect(rail.container.querySelector('[data-dsh-instance-groups]')).toBeNull()
    cleanup()

    const wide = render(<Slot t={t} wide />)
    await settle()
    expect(wide.container.querySelector('[data-dsh-instance-groups]')).not.toBeNull()
  })

  it('renders nothing when the control plane is absent or has no instances', async () => {
    const { container } = render(
      <InstanceGroups fetchTree={async () => []} fetchInstances={async () => []} t={t} />,
    )
    await settle()
    expect(container.querySelector('[data-dsh-instance-groups]')).toBeNull()
  })
})
