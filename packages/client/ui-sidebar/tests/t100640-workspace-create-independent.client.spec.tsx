// @vitest-environment jsdom
/**
 * Independent adversarial pass over the sidebar's "new session in workspace"
 * entry after the Workspace-id fix.
 *
 * Not a re-run of the developer's `t100640-*` specs:
 *  A. the request is the row's **owner-local UUID**, never the cwd path, and it
 *     is qualified with the row's own instance (two instances, same id);
 *  B. an id-less row (unregistered cwd) and the `(no workspace)` placeholder
 *     render no control at all and issue no call;
 *  C. a failure is still attributed to the **path-keyed row**, even though the
 *     request carried the id, and the button is restored;
 *  D. regressions: unreachable/connecting gates, folding across republishes,
 *     and the missing-reader gate.
 */
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InstanceGroups, type InstanceGroupView, type InstanceGroupsReaders,
  type InstanceSessionView, type InstanceWorkspaceView,
} from '../src/client/InstanceGroups.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate({ ...commonEn, ...en })

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** Flush the create → refresh → open promise chain. */
async function settleChain(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
  })
}

const REPO_UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const OTHER_UUID = '9b2c4d6e-8f10-4a2b-8c4d-6e8f10a2b4c6'

function session(instanceId: string, sessionId: string): InstanceSessionView {
  return { key: `${instanceId}:${sessionId}`, sessionId, running: false, updatedAt: 1_000 }
}

function workspace(
  instanceId: string,
  path: string,
  workspaceId: string | undefined,
  sessions: readonly InstanceSessionView[],
): InstanceWorkspaceView {
  return {
    key: `${instanceId}:${path}`,
    path,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    runningCount: 0,
    sessions,
  }
}

function group(
  instanceId: string,
  workspaces: readonly InstanceWorkspaceView[],
  state: InstanceGroupView['state'] = 'connected',
): InstanceGroupView {
  const sessionCount = workspaces.reduce((total, entry) => total + entry.sessions.length, 0)
  return {
    instanceId,
    label: `${instanceId}(${instanceId})`,
    state,
    ...(state === 'unreachable' ? { error: 'connect ECONNREFUSED' } : {}),
    runningCount: 0,
    sessionCount,
    workspaces,
  }
}

interface RenderOptions {
  readonly groups: readonly InstanceGroupView[]
  readonly createSession?: InstanceGroupsReaders['createSession']
  readonly refreshTree?: InstanceGroupsReaders['refreshTree']
  readonly openSession?: InstanceGroupsReaders['openSession']
}

function renderSection(options: RenderOptions): ReturnType<typeof render> {
  const fetchTree = async (): Promise<readonly InstanceGroupView[]> => options.groups
  return render(
    <InstanceGroups
      fetchTree={fetchTree}
      retry={async () => {}}
      {...(options.createSession === undefined ? {} : { createSession: options.createSession })}
      {...(options.refreshTree === undefined ? {} : { refreshTree: options.refreshTree })}
      {...(options.openSession === undefined ? {} : { openSession: options.openSession })}
      intervalMs={60_000}
      t={t}
    />,
  )
}

function createButton(container: HTMLElement, key: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-workspace-create="${key}"]`)
}

describe('A. the create request names the real Workspace id', () => {
  it('sends <instanceId>:<uuid>, never the cwd path, and opens the returned Session', async () => {
    const createSession = vi.fn(async () => 's-new')
    const openSession = vi.fn()
    const groups = [group('alpha', [workspace('alpha', '/repo', REPO_UUID, [session('alpha', 's-1')])])]
    const { container } = renderSection({
      groups,
      createSession,
      refreshTree: async () => groups,
      openSession,
    })
    await settleChain()

    const button = createButton(container, 'alpha:/repo')
    expect(button).not.toBeNull()
    fireEvent.click(button!)
    await settleChain()

    expect(createSession).toHaveBeenCalledExactlyOnceWith(`alpha:${REPO_UUID}`)
    expect(createSession).not.toHaveBeenCalledWith('alpha:/repo')
    expect(openSession).toHaveBeenCalledExactlyOnceWith('alpha:s-new', '/repo')
  })

  it('qualifies the id with the row’s own instance when two instances share an id', async () => {
    const createSession = vi.fn(async () => 's-new')
    const groups = [
      group('alpha', [workspace('alpha', '/repo', REPO_UUID, [session('alpha', 's-1')])]),
      group('beta', [workspace('beta', '/repo', REPO_UUID, [session('beta', 's-9')])]),
    ]
    const { container } = renderSection({ groups, createSession, openSession: vi.fn() })
    await settleChain()

    fireEvent.click(createButton(container, 'beta:/repo')!)
    await settleChain()

    expect(createSession).toHaveBeenCalledExactlyOnceWith(`beta:${REPO_UUID}`)
  })
})

describe('B. no id means no control', () => {
  it('renders no create button for an unregistered cwd and never calls createSession', async () => {
    const createSession = vi.fn(async () => 's-new')
    const groups = [group('alpha', [workspace('alpha', '/unregistered', undefined, [session('alpha', 's-1')])])]
    const { container } = renderSection({ groups, createSession, openSession: vi.fn() })
    await settleChain()

    // The row itself survives: only the create control is withheld.
    expect(container.querySelector('[data-workspace-key="alpha:/unregistered"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(1)
    expect(createButton(container, 'alpha:/unregistered')).toBeNull()
    expect(container.querySelectorAll('[data-workspace-create]')).toHaveLength(0)
    expect(createSession).not.toHaveBeenCalled()
  })

  it('renders no create button on the (no workspace) placeholder', async () => {
    const createSession = vi.fn(async () => 's-new')
    const groups = [group('alpha', [workspace('alpha', '(no workspace)', undefined, [session('alpha', 's-1')])])]
    const { container } = renderSection({ groups, createSession, openSession: vi.fn() })
    await settleChain()

    expect(container.querySelector('[data-workspace-key="alpha:(no workspace)"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-workspace-create]')).toHaveLength(0)
    expect(createSession).not.toHaveBeenCalled()
  })

  it('offers only the id-bearing row a control when the tree mixes both', async () => {
    const createSession = vi.fn(async () => 's-new')
    const groups = [group('alpha', [
      workspace('alpha', '/known', REPO_UUID, [session('alpha', 's-1')]),
      workspace('alpha', '/unknown', undefined, [session('alpha', 's-2')]),
    ])]
    const { container } = renderSection({ groups, createSession, openSession: vi.fn() })
    await settleChain()

    expect(container.querySelectorAll('[data-workspace-create]')).toHaveLength(1)
    expect(createButton(container, 'alpha:/known')).not.toBeNull()
    expect(createButton(container, 'alpha:/unknown')).toBeNull()
  })
})

describe('C. failure stays attributed to the path-keyed row', () => {
  it('shows the reason under <instanceId>:<cwd> even though the call used the id', async () => {
    const createSession = vi.fn(async () => {
      throw new Error('workspace attach refused')
    })
    const groups = [group('alpha', [
      workspace('alpha', '/repo', REPO_UUID, [session('alpha', 's-1')]),
      workspace('alpha', '/other', OTHER_UUID, [session('alpha', 's-2')]),
    ])]
    const { container, queryByText } = renderSection({
      groups,
      createSession,
      openSession: vi.fn(),
      refreshTree: async () => groups,
    })
    await settleChain()

    fireEvent.click(createButton(container, 'alpha:/repo')!)
    await settleChain()

    const failure = container.querySelector('[data-create-failure="alpha:/repo"]')
    expect(failure).not.toBeNull()
    expect(failure?.textContent).toContain('workspace attach refused')
    // No failure leaked onto the sibling row.
    expect(container.querySelector('[data-create-failure="alpha:/other"]')).toBeNull()
    // The request still used the id, not the failure key.
    expect(createSession).toHaveBeenCalledExactlyOnceWith(`alpha:${REPO_UUID}`)
    // The control is usable again after the attempt settled.
    expect(createButton(container, 'alpha:/repo')?.disabled).toBe(false)
    expect(queryByText('/repo')).not.toBeNull()
  })
})

describe('D. regression gates', () => {
  it('hides the control under an unreachable instance even when the row carries an id', async () => {
    const groups = [group('alpha', [workspace('alpha', '/repo', REPO_UUID, [session('alpha', 's-1')])], 'unreachable')]
    const { container } = renderSection({ groups, createSession: vi.fn(async () => 's-new'), openSession: vi.fn() })
    await settleChain()

    expect(container.querySelector('[data-instance-offline="alpha"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-workspace-create]')).toHaveLength(0)
  })

  it('keeps rows but hides the control while the instance is still connecting', async () => {
    const groups = [group('alpha', [workspace('alpha', '/repo', REPO_UUID, [session('alpha', 's-1')])], 'connecting')]
    const { container } = renderSection({ groups, createSession: vi.fn(async () => 's-new'), openSession: vi.fn() })
    await settleChain()

    expect(container.querySelector('[data-workspace-key="alpha:/repo"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-workspace-create]')).toHaveLength(0)
  })

  it('offers no control when no create reader is wired', async () => {
    const groups = [group('alpha', [workspace('alpha', '/repo', REPO_UUID, [session('alpha', 's-1')])])]
    const { container } = renderSection({ groups, openSession: vi.fn() })
    await settleChain()

    expect(container.querySelectorAll('[data-workspace-create]')).toHaveLength(0)
  })

  it('keeps the id-bearing control through a fold toggle and a republished tree', async () => {
    const createSession = vi.fn(async () => 's-new')
    const before = [group('alpha', [workspace('alpha', '/repo', REPO_UUID, [session('alpha', 's-1')])])]
    const { container, rerender } = renderSection({ groups: before, createSession, openSession: vi.fn() })
    await settleChain()

    const fold = container.querySelector<HTMLButtonElement>('[data-workspace-key="alpha:/repo"]')
    expect(fold?.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(fold!)
    expect(fold?.getAttribute('aria-expanded')).toBe('false')
    // Folding hides the session rows, not the workspace row or its control.
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(0)
    expect(createButton(container, 'alpha:/repo')).not.toBeNull()

    const after = [group('alpha', [workspace('alpha', '/repo', REPO_UUID, [session('alpha', 's-1'), session('alpha', 's-2')])])]
    rerender(
      <InstanceGroups
        fetchTree={async () => after}
        retry={async () => {}}
        createSession={createSession}
        openSession={vi.fn()}
        intervalMs={60_000}
        t={t}
      />,
    )
    await settleChain()

    expect(createButton(container, 'alpha:/repo')?.disabled).toBe(false)
    fireEvent.click(createButton(container, 'alpha:/repo')!)
    await settleChain()
    expect(createSession).toHaveBeenCalledExactlyOnceWith(`alpha:${REPO_UUID}`)
  })
})
