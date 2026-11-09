// @vitest-environment jsdom
/**
 * t100640 review fixes — the four defects found in the workspace create entry.
 *
 *   1. the inline failure line is cleared only by a success in the same
 *      workspace, so a retry keeps showing the previous reason while it runs
 *      (a new failure replaces it);
 *   2. a failure cannot outlive the workspace it belongs to: pruning against
 *      the current frame stops a removed workspace's old message from being
 *      resurrected when the same path reappears;
 *   3. frames commit in request order, not arrival order: a poll or refresh
 *      that started earlier can never land over a newer one, in either
 *      direction (older refresh vs newer refresh, poll vs post-create refresh);
 *   4. without a create reader the row renders no create control at all.
 */
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InstanceGroups, type InstanceGroupView, type InstanceSessionView, type InstanceWorkspaceView,
} from '../src/client/InstanceGroups.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate({ ...commonEn, ...en })

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** Flush one frame promise and the store notifications it triggers. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

/** Flush the create → refresh → open chain. */
async function settleChain(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await settle()
}

function sessionOf(instanceId: string, sessionId: string): InstanceSessionView {
  return { key: `${instanceId}:${sessionId}`, sessionId, running: false, updatedAt: Date.now() }
}

/**
 * Owner-local Workspace id for one path: a stable stand-in for the registry's
 * `randomUUID`. The path is what the row is grouped by, never the id the owner
 * accepts, so the two must stay distinguishable in these fixtures.
 */
function workspaceIdOf(path: string): string {
  return `ws-${path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
}

function workspaceOf(
  instanceId: string,
  path: string,
  sessions: readonly InstanceSessionView[],
): InstanceWorkspaceView {
  return { key: `${instanceId}:${path}`, path, workspaceId: workspaceIdOf(path), runningCount: 0, sessions }
}

function groupOf(
  instanceId: string,
  workspaces: readonly InstanceWorkspaceView[],
): InstanceGroupView {
  return {
    instanceId,
    label: `${instanceId.toUpperCase()}(${instanceId})`,
    state: 'connected',
    runningCount: 0,
    sessionCount: workspaces.reduce((total, workspace) => total + workspace.sessions.length, 0),
    workspaces,
  }
}

/** The create control of one workspace row. */
function createButtonOf(container: HTMLElement, workspaceKey: string): HTMLButtonElement {
  const button = container.querySelector(`[data-workspace-create="${workspaceKey}"]`)
  if (button === null) throw new Error(`the create button for ${workspaceKey} was not rendered`)
  return button as HTMLButtonElement
}

/** The inline failure line of one workspace row. */
function failureOf(container: HTMLElement, workspaceKey: string): HTMLElement | null {
  return container.querySelector(`[data-create-failure="${workspaceKey}"]`)
}

describe('fix 1: the failure line clears on success, not when a retry starts', () => {
  it('keeps the previous reason visible while the retry is pending', async () => {
    const retry = Promise.withResolvers<string>()
    const groups = [groupOf('keep1', [workspaceOf('keep1', '/repo', [sessionOf('keep1', 's-1')])])]
    const createSession = vi.fn()
      .mockRejectedValueOnce(new Error('instance offline'))
      .mockImplementationOnce(() => retry.promise)
    const openSession = vi.fn()
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => groups}
        retry={vi.fn(async () => {})}
        createSession={createSession}
        refreshTree={async () => groups}
        openSession={openSession}
        t={t}
      />,
    )
    await settle()

    fireEvent.click(createButtonOf(container, 'keep1:/repo'))
    await settleChain()
    expect(failureOf(container, 'keep1:/repo')?.textContent).toBe(
      'Could not create a session in /repo: instance offline',
    )

    // The retry is in flight: the button is busy and the old reason is still
    // there, so the user can read it while waiting for the outcome.
    fireEvent.click(createButtonOf(container, 'keep1:/repo'))
    await settle()
    const pending = createButtonOf(container, 'keep1:/repo')
    expect(pending.disabled).toBe(true)
    expect(pending.getAttribute('aria-busy')).toBe('true')
    expect(failureOf(container, 'keep1:/repo')?.textContent).toBe(
      'Could not create a session in /repo: instance offline',
    )

    retry.resolve('new-1')
    await settleChain()
    // Success is what removes it.
    expect(failureOf(container, 'keep1:/repo')).toBeNull()
    expect(openSession).toHaveBeenCalledExactlyOnceWith('keep1:new-1', '/repo')
  })

  it('replaces the reason when the retry fails too', async () => {
    const groups = [groupOf('keep2', [workspaceOf('keep2', '/repo', [sessionOf('keep2', 's-1')])])]
    const createSession = vi.fn()
      .mockRejectedValueOnce(new Error('first: refused'))
      .mockRejectedValueOnce(new Error('second: timeout'))
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => groups}
        retry={vi.fn(async () => {})}
        createSession={createSession}
        refreshTree={async () => groups}
        openSession={vi.fn()}
        t={t}
      />,
    )
    await settle()

    fireEvent.click(createButtonOf(container, 'keep2:/repo'))
    await settleChain()
    fireEvent.click(createButtonOf(container, 'keep2:/repo'))
    await settleChain()

    const text = failureOf(container, 'keep2:/repo')?.textContent ?? ''
    expect(text).toContain('second: timeout')
    expect(text).not.toContain('first: refused')
  })
})

describe('fix 2: a failure cannot outlive its workspace', () => {
  it('drops the old reason when the workspace leaves the tree and does not revive it', async () => {
    vi.useFakeTimers()
    const withRepo = [groupOf('stale1', [workspaceOf('stale1', '/repo', [sessionOf('stale1', 's-1')])])]
    let groups = withRepo
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

    fireEvent.click(createButtonOf(container, 'stale1:/repo'))
    await settleChain()
    expect(failureOf(container, 'stale1:/repo')).not.toBeNull()

    // The workspace disappears from the frame: the message is pruned with it.
    groups = [groupOf('stale1', [])]
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(failureOf(container, 'stale1:/repo')).toBeNull()

    // It comes back with no attempt in between: nothing stale is shown.
    groups = withRepo
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(failureOf(container, 'stale1:/repo')).toBeNull()
  })
})

describe('fix 3: only the newest requested frame lands', () => {
  it('drops an older refresh frame that settles after a newer one', async () => {
    const repo = Promise.withResolvers<string>()
    const other = Promise.withResolvers<string>()
    const initial = [groupOf('race1', [
      workspaceOf('race1', '/repo', [sessionOf('race1', 's-repo')]),
      workspaceOf('race1', '/other', [sessionOf('race1', 's-other')]),
    ])]
    const fresh = [groupOf('race1', [
      workspaceOf('race1', '/repo', [sessionOf('race1', 'new-repo'), sessionOf('race1', 's-repo')]),
      workspaceOf('race1', '/other', [sessionOf('race1', 'new-other'), sessionOf('race1', 's-other')]),
    ])]
    // The frame the *first* refresh will eventually answer with: it predates
    // the second create and must not overwrite the newer one.
    const older = [groupOf('race1', [
      workspaceOf('race1', '/repo', [sessionOf('race1', 's-repo')]),
      workspaceOf('race1', '/other', [sessionOf('race1', 'new-other'), sessionOf('race1', 's-other')]),
    ])]
    const frames: Array<PromiseWithResolvers<readonly InstanceGroupView[]>> = []
    const refreshTree = vi.fn(() => {
      const deferred = Promise.withResolvers<readonly InstanceGroupView[]>()
      frames.push(deferred)
      return deferred.promise
    })
    const createSession = vi.fn((workspaceId: string) => (
      workspaceId === 'race1:ws-repo' ? repo.promise : other.promise
    ))
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => initial}
        retry={vi.fn(async () => {})}
        createSession={createSession}
        refreshTree={refreshTree}
        openSession={vi.fn()}
        t={t}
      />,
    )
    await settle()

    fireEvent.click(createButtonOf(container, 'race1:/repo'))
    fireEvent.click(createButtonOf(container, 'race1:/other'))
    await settle()

    // The other workspace finishes first: its refresh is the older request.
    other.resolve('new-other')
    await settleChain()
    expect(frames).toHaveLength(1)

    // The repo create finishes second: a newer refresh request.
    repo.resolve('new-repo')
    await settleChain()
    expect(frames).toHaveLength(2)

    // Newest lands first, the older one settles afterwards and is dropped.
    frames[1]?.resolve(fresh)
    await settleChain()
    expect(container.querySelector('[data-session-key="race1:new-repo"]')).not.toBeNull()
    frames[0]?.resolve(older)
    await settleChain()
    expect(container.querySelector('[data-session-key="race1:new-repo"]')).not.toBeNull()
    expect(container.querySelector('[data-session-key="race1:new-other"]')).not.toBeNull()
  })

  it('lets a post-create refresh win over a poll frame that started earlier', async () => {
    vi.useFakeTimers()
    const initial = [groupOf('race2', [workspaceOf('race2', '/repo', [sessionOf('race2', 's-1')])])]
    const refreshed = [groupOf('race2', [
      workspaceOf('race2', '/repo', [sessionOf('race2', 'new-2'), sessionOf('race2', 's-1')]),
    ])]
    let reads = 0
    const poll = Promise.withResolvers<readonly InstanceGroupView[]>()
    const fetchTree = vi.fn(() => {
      reads += 1
      return reads === 1 ? Promise.resolve(initial) : poll.promise
    })
    const { container } = render(
      <InstanceGroups
        fetchTree={fetchTree}
        retry={vi.fn(async () => {})}
        createSession={async () => 'new-2'}
        refreshTree={async () => refreshed}
        openSession={vi.fn()}
        intervalMs={6000}
        t={t}
      />,
    )
    await settle()

    // The poll starts before the create and is still in flight when the
    // post-create refresh commits.
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(fetchTree).toHaveBeenCalledTimes(2)

    fireEvent.click(createButtonOf(container, 'race2:/repo'))
    await settleChain()
    expect(container.querySelector('[data-session-key="race2:new-2"]')).not.toBeNull()

    // The older poll answers with the pre-create tree: dropped.
    poll.resolve(initial)
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('[data-session-key="race2:new-2"]')).not.toBeNull()
  })
})

describe('fix 4: no create reader, no create control', () => {
  it('renders no button at all when createSession is absent', async () => {
    const groups = [groupOf('gate4', [workspaceOf('gate4', '/repo', [sessionOf('gate4', 's-1')])])]
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => groups}
        retry={vi.fn(async () => {})}
        openSession={vi.fn()}
        t={t}
      />,
    )
    await settle()

    // The row is still there, its fold button still works, and the only
    // missing thing is a control that could not act.
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(1)
    expect(container.querySelector('[data-workspace-key="gate4:/repo"]')).not.toBeNull()
    expect(container.querySelector('[data-workspace-create]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create a session in /repo' })).toBeNull()
  })

  it('renders it again as soon as a create reader is supplied', async () => {
    const groups = [groupOf('gate5', [workspaceOf('gate5', '/repo', [sessionOf('gate5', 's-1')])])]
    const { container, rerender } = render(
      <InstanceGroups fetchTree={async () => groups} retry={vi.fn(async () => {})} t={t} />,
    )
    await settle()
    expect(container.querySelector('[data-workspace-create]')).toBeNull()

    rerender(
      <InstanceGroups
        fetchTree={async () => groups}
        retry={vi.fn(async () => {})}
        createSession={async () => 'new-1'}
        t={t}
      />,
    )
    expect(createButtonOf(container, 'gate5:/repo')).toBeTruthy()
  })
})
