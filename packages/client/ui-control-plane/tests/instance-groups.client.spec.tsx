// @vitest-environment jsdom
/**
 * Control-plane instance groups: header contents, the offline/empty split, the
 * retry control, folding that survives the poll, the "show more" ladder that
 * replaces silent truncation, and the keep-the-previous-frame rule for failed
 * reads.
 *
 * Reachability comes from the tree frame itself since S3-03, so every fixture
 * carries `state` and the section no longer takes a second `instances` reader.
 * The section's first frame arrives from a promise, so every test settles the
 * microtask queue (inside `act`) before asserting.
 */
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InstanceGroups, instanceGroupsSlot, type InstanceGroupView, type InstanceSessionView,
} from '../src/client/InstanceGroups.tsx'
import { en } from '@deepseek-ai/dsh-client-ui-sidebar/src/client/locales.ts'

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

/** Reachability overrides a group fixture may carry. */
interface GroupOverrides {
  readonly state?: InstanceGroupView['state']
  readonly error?: string | undefined
}

/** One instance group with `count` sessions in one workspace. */
function group(instanceId: string, count: number, path = '/workspace', overrides: GroupOverrides = {}): InstanceGroupView {
  return {
    instanceId,
    label: `${instanceId.toUpperCase()}(${instanceId})`,
    state: overrides.state ?? 'connected',
    ...(overrides.error === undefined ? {} : { error: overrides.error }),
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

/** A `retry` reader that succeeds and records its calls. */
function retrySpy(): ReturnType<typeof vi.fn<(instanceId: string) => Promise<void>>> {
  return vi.fn<(instanceId: string) => Promise<void>>(async () => {})
}

describe('InstanceGroups header', () => {
  it('renders the instance name, a reachability dot and the session count', async () => {
    const { container } = render(
      <InstanceGroups fetchTree={async () => [group('cto', 3)]} retry={retrySpy()} t={t} />,
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
    // A connected group never shows the offline notice or the empty line.
    expect(container.querySelector('[data-instance-offline]')).toBeNull()
    expect(screen.queryByText('No sessions')).toBeNull()
  })

  it('renders the connecting state from the tree with a dash instead of a count', async () => {
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group('ops', 0, '/workspace', { state: 'connecting' })]}
        retry={retrySpy()}
        t={t}
      />,
    )
    await settle()
    const header = screen.getByRole('button', { name: 'OPS(ops), Connecting, 0 sessions' })
    expect(header.getAttribute('data-instance-state')).toBe('connecting')
    expect(container.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(header.textContent).toBe('OPS(ops)—')
    expect(container.querySelector('[data-instance-offline]')).toBeNull()
  })
})

describe('InstanceGroups offline vs empty', () => {
  it('shows the offline marker, the reason and a retry control instead of "0"', async () => {
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group('down', 0, '/workspace', { state: 'unreachable', error: 'connect ECONNREFUSED' })]}
        retry={retrySpy()}
        t={t}
      />,
    )
    await settle()
    const header = screen.getByRole('button', { name: 'DOWN(down), Unreachable' })
    expect(header.getAttribute('data-instance-state')).toBe('unreachable')
    expect(container.querySelector('[data-state="error"]')).not.toBeNull()
    // Never the connected-empty "0": the count cell says Offline.
    expect(header.textContent).toBe('DOWN(down)Offline')
    const notice = container.querySelector('[data-instance-offline="down"]') as HTMLElement
    expect(notice.textContent).toContain('connect ECONNREFUSED')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    // The empty-instance copy belongs to the online case only.
    expect(screen.queryByText('No sessions')).toBeNull()
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(0)
  })

  it('falls back to the unreachable label when the control plane sent no reason', async () => {
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group('mute', 0, '/workspace', { state: 'unreachable' })]}
        retry={retrySpy()}
        t={t}
      />,
    )
    await settle()
    const notice = container.querySelector('[data-instance-offline="mute"]') as HTMLElement
    expect(notice.textContent).toContain('Unreachable')
    expect(notice.textContent).toContain('Retry')
  })

  it('elides a long reason but keeps the full text on the title attribute', async () => {
    const long = `boom ${'x'.repeat(300)}`
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group('long', 0, '/workspace', { state: 'unreachable', error: long })]}
        retry={retrySpy()}
        t={t}
      />,
    )
    await settle()
    const error = container.querySelector('[data-instance-offline="long"] span') as HTMLElement
    expect(error.textContent?.endsWith('…')).toBe(true)
    expect(error.textContent?.length).toBe(160)
    expect(error.getAttribute('title')).toBe(long)
  })

  it('shows "0" plus a quiet empty line for a connected instance with no sessions', async () => {
    const { container } = render(
      <InstanceGroups fetchTree={async () => [group('idle', 0)]} retry={retrySpy()} t={t} />,
    )
    await settle()
    const header = screen.getByRole('button', { name: 'IDLE(idle), Connected, 0 sessions' })
    expect(header.textContent).toBe('IDLE(idle)0')
    expect(screen.getByText('No sessions')).toBeTruthy()
    // No error, no retry: an empty instance is not a broken one.
    expect(container.querySelector('[data-instance-offline]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('keeps the offline notice inside the disclosure, so folding hides it', async () => {
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group('folded', 0, '/workspace', { state: 'unreachable', error: 'down' })]}
        retry={retrySpy()}
        t={t}
      />,
    )
    await settle()
    expect(container.querySelector('[data-instance-offline="folded"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /FOLDED\(folded\)/ }))
    expect(container.querySelector('[data-instance-offline="folded"]')).toBeNull()
  })
})

describe('InstanceGroups retry', () => {
  it('calls the retry reader and re-reads the tree for the outcome', async () => {
    const retry = retrySpy()
    const fetchTree = vi.fn(async () => [
      group('again', 0, '/workspace', { state: 'unreachable' as const, error: 'down' }),
    ])
    render(<InstanceGroups fetchTree={fetchTree} retry={retry} t={t} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()
    expect(retry).toHaveBeenCalledWith('again')
    expect(fetchTree).toHaveBeenCalledTimes(2)
  })

  it('shows progress and refuses a second click while the retry runs', async () => {
    let resolveRetry: () => void = () => {}
    const retry = vi.fn<(instanceId: string) => Promise<void>>(
      async () => { await new Promise<void>((resolve) => { resolveRetry = resolve }) },
    )
    const fetchTree = vi.fn(async () => [
      group('slow', 0, '/workspace', { state: 'unreachable' as const, error: 'down' }),
    ])
    render(<InstanceGroups fetchTree={fetchTree} retry={retry} t={t} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    const busy = screen.getByRole('button', { name: 'Retrying' }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    fireEvent.click(busy)
    expect(retry).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveRetry()
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(fetchTree).toHaveBeenCalledTimes(2)
  })

  it('renders the new reason when the retry fails', async () => {
    let tree = group('flaky', 0, '/workspace', { state: 'unreachable' as const, error: 'first: refused' })
    const fetchTree = vi.fn(async () => [tree])
    const retry = vi.fn(async () => {
      tree = group('flaky', 0, '/workspace', { state: 'unreachable' as const, error: 'second: timeout' })
    })
    const { container } = render(<InstanceGroups fetchTree={fetchTree} retry={retry} t={t} />)
    await settle()
    expect(container.querySelector('[data-instance-offline="flaky"]')?.textContent).toContain('first: refused')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()
    expect(container.querySelector('[data-instance-offline="flaky"]')?.textContent).toContain('second: timeout')
    expect(container.querySelector('[data-instance-offline="flaky"]')?.textContent).not.toContain('first: refused')
  })

  it('recovers to the connected rendering after a successful retry', async () => {
    let tree = group('heal', 0, '/workspace', { state: 'unreachable' as const, error: 'down' })
    const fetchTree = vi.fn(async () => [tree])
    const retry = vi.fn(async () => { tree = group('heal', 2) })
    const { container } = render(<InstanceGroups fetchTree={fetchTree} retry={retry} t={t} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()
    expect(container.querySelector('[data-instance-offline="heal"]')).toBeNull()
    expect(screen.getByRole('button', { name: /HEAL\(heal\), Connected, 2 sessions/ })).toBeTruthy()
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(2)
  })

  it('keeps the previous frame when the post-retry read fails', async () => {
    let fail = false
    const fetchTree = vi.fn(async () => {
      if (fail) throw new Error('tree down')
      return [group('stay', 0, '/workspace', { state: 'unreachable' as const, error: 'down' })]
    })
    const retry = vi.fn(async () => { fail = true })
    const { container } = render(<InstanceGroups fetchTree={fetchTree} retry={retry} t={t} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()
    expect(fetchTree).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[data-instance-offline="stay"]')?.textContent).toContain('down')
    // The button is usable again even though the read failed.
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
})

describe('InstanceGroups rows', () => {
  it('renders the reported session title instead of the id', async () => {
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [{
          instanceId: 'titled',
          label: 'TITLED(titled)',
          state: 'connected',
          runningCount: 0,
          sessionCount: 1,
          workspaces: [{
            key: 'titled:/workspace',
            path: '/workspace',
            runningCount: 0,
            sessions: [{
              key: 'titled:session-9',
              sessionId: 'session-9',
              title: 'Fix the login flow',
              running: false,
              updatedAt: Date.now(),
            }],
          }],
        }]}
        retry={retrySpy()}
        t={t}
      />,
    )
    await settle()
    expect(screen.getByText('Fix the login flow')).toBeTruthy()
    expect(screen.queryByText('session-9')).toBeNull()
    // The hover tooltip keeps the full federated key, title or not.
    const row = container.querySelector('[data-session-key="titled:session-9"]') as HTMLElement
    expect(row.getAttribute('title')).toBe('titled:session-9')
  })

  it('falls back to the session id when the title is blank or absent', async () => {
    render(
      <InstanceGroups
        fetchTree={async () => [{
          instanceId: 'untitled',
          label: 'UNTITLED(untitled)',
          state: 'connected',
          runningCount: 0,
          sessionCount: 2,
          workspaces: [{
            key: 'untitled:/workspace',
            path: '/workspace',
            runningCount: 0,
            sessions: [
              { key: 'untitled:blank', sessionId: 'blank', title: '   ', running: false, updatedAt: Date.now() },
              { key: 'untitled:plain', sessionId: 'plain', running: false, updatedAt: Date.now() },
            ],
          }],
        }]}
        retry={retrySpy()}
        t={t}
      />,
    )
    await settle()
    expect(screen.getByText('blank')).toBeTruthy()
    expect(screen.getByText('plain')).toBeTruthy()
  })

  it('folds a group without the poll resetting it', async () => {
    vi.useFakeTimers()
    const fetchTree = vi.fn(async () => [group('lab', 2)])
    render(<InstanceGroups fetchTree={fetchTree} retry={retrySpy()} t={t} intervalMs={6000} />)
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
      <InstanceGroups fetchTree={async () => [group('wide', 20)]} retry={retrySpy()} t={t} />,
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
      <InstanceGroups fetchTree={async () => [group('edge', 10)]} retry={retrySpy()} t={t} />,
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
})

describe('InstanceGroups frames', () => {
  it('keeps the previous tree when a frame fails', async () => {
    vi.useFakeTimers()
    let fail = false
    const fetchTree = vi.fn(async () => {
      if (fail) throw new Error('boom')
      return [group('core', 1)]
    })
    render(<InstanceGroups fetchTree={fetchTree} retry={retrySpy()} t={t} intervalMs={6000} />)
    await settle()
    expect(screen.getByText('session-0')).toBeTruthy()

    fail = true
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(fetchTree).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: /CORE\(core\)/ })).toBeTruthy()
    expect(screen.getByText('session-0')).toBeTruthy()
  })

  it('switches to the offline rendering when a later frame reports unreachable', async () => {
    vi.useFakeTimers()
    let down = false
    const fetchTree = vi.fn(async () => [down
      ? group('shift', 0, '/workspace', { state: 'unreachable' as const, error: 'gone' })
      : group('shift', 1)])
    const { container } = render(<InstanceGroups fetchTree={fetchTree} retry={retrySpy()} t={t} intervalMs={6000} />)
    await settle()
    expect(container.querySelector('[data-instance-state="connected"]')).not.toBeNull()

    down = true
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    const header = container.querySelector('[data-instance-id="shift"]') as HTMLElement
    expect(header.getAttribute('data-instance-state')).toBe('unreachable')
    expect(header.textContent).toBe('SHIFT(shift)Offline')
    expect(container.querySelector('[data-instance-offline="shift"]')?.textContent).toContain('gone')
  })

  it('falls back to the key without the instance prefix when the protocol has no session id', async () => {
    render(
      <InstanceGroups
        fetchTree={async () => [{
          instanceId: 'raw',
          label: 'RAW(raw)',
          state: 'connected',
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
        retry={retrySpy()}
        t={t}
      />,
    )
    await settle()
    expect(screen.getByText('opaque')).toBeTruthy()
    expect(screen.getByText('unqualified')).toBeTruthy()
  })

  it('drops frames that arrive after unmount', async () => {
    let resolveTree: (value: readonly InstanceGroupView[]) => void = () => {}
    const { unmount } = render(
      <InstanceGroups
        fetchTree={() => new Promise((resolve) => { resolveTree = resolve })}
        retry={retrySpy()}
        t={t}
      />,
    )
    unmount()
    await act(async () => {
      resolveTree([group('late', 1)])
      await Promise.resolve()
    })
    expect(document.querySelector('[data-dsh-instance-groups]')).toBeNull()
  })

  it('drops a retry outcome that arrives after unmount', async () => {
    let resolveRetry: () => void = () => {}
    const retry = vi.fn(async () => { await new Promise<void>((resolve) => { resolveRetry = resolve }) })
    const fetchTree = vi.fn(async () => [
      group('gone', 0, '/workspace', { state: 'unreachable' as const, error: 'down' }),
    ])
    const { unmount } = render(<InstanceGroups fetchTree={fetchTree} retry={retry} t={t} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    unmount()
    await act(async () => {
      resolveRetry()
      await Promise.resolve()
    })
    // The post-retry read never runs on an unmounted section.
    expect(fetchTree).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-dsh-instance-groups]')).toBeNull()
  })

  it('folds a workspace subtree from its own row', async () => {
    const { container } = render(
      <InstanceGroups fetchTree={async () => [group('fold', 3)]} retry={retrySpy()} t={t} />,
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
    const Slot = instanceGroupsSlot({ fetchTree: async () => [group('slot', 1)], retry: retrySpy() })
    const rail = render(<Slot t={t} wide={false} />)
    expect(rail.container.querySelector('[data-dsh-instance-groups]')).toBeNull()
    cleanup()

    const wide = render(<Slot t={t} wide />)
    await settle()
    expect(wide.container.querySelector('[data-dsh-instance-groups]')).not.toBeNull()
  })

  it('renders nothing when the control plane is absent or has no instances', async () => {
    const { container } = render(
      <InstanceGroups fetchTree={async () => []} retry={retrySpy()} t={t} />,
    )
    await settle()
    expect(container.querySelector('[data-dsh-instance-groups]')).toBeNull()
  })
})
