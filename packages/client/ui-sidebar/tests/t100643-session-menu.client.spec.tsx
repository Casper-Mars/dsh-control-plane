// @vitest-environment jsdom
/**
 * t100643 — the instance tree's session rows carry the official Session
 * context menu.
 *
 * The row hands the shell a `session` target whose id is the complete federated
 * key. Because the Session lives in another instance's catalog, the target also
 * carries the owner's pin/archive facts and, while that instance is not
 * connected, the reason every action is unavailable. These tests read what the
 * row actually passes to `getTriggerProps`; the menu's own rendering is covered
 * by ui-workspace, and the forwarded RPCs by the control-plane/session tests.
 */
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { ContextMenuBindings, ContextMenuTarget } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InstanceGroups, instanceGroupsSlot, type InstanceGroupView, type InstanceSessionView,
} from '../src/client/InstanceGroups.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate({ ...commonEn, ...en })

afterEach(() => { cleanup() })

/** Flush the readers' already-resolved promises inside act. */
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

/** One instance group with one workspace and the given session rows. */
function group(
  sessions: readonly InstanceSessionView[],
  state: InstanceGroupView['state'] = 'connected',
): InstanceGroupView {
  return {
    instanceId: 'alpha',
    label: 'ALPHA(alpha)',
    state,
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

/**
 * Menu bindings that record the captured target instead of opening the popup.
 * @param captured - receives the target the row handed the gesture.
 * @returns the shape the shell injects through `useContextMenu`.
 */
function bindings(captured: ContextMenuTarget[]): ContextMenuBindings {
  return {
    getTriggerProps: (target, handlers = {}) => ({
      ...handlers,
      onContextMenu: (event) => {
        event.preventDefault()
        if (typeof target === 'function') captured.push(target())
        else if (target !== undefined) captured.push(target)
      },
    }),
  }
}

describe('t100643 / session row menu target', () => {
  it('captures the complete federated key and both owner facts', async () => {
    const captured: ContextMenuTarget[] = []
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group([{ ...session('alpha:s-1', 's-1', 'Fix login'), pinned: true, archived: false }])]}
        retry={vi.fn(async () => {})}
        t={t}
        useContextMenu={() => bindings(captured)}
      />,
    )
    await settle()
    const row = container.querySelector('[data-session-key="alpha:s-1"]')
    if (row === null) throw new Error('fixture: row missing')

    fireEvent.contextMenu(row)

    expect(captured).toEqual([{
      kind: 'session',
      value: {
        sessionId: 'alpha:s-1',
        displayTitle: 'Fix login',
        pinned: true,
        archived: false,
      },
    }])
  })

  it('carries the offline reason while the instance is connecting', async () => {
    const captured: ContextMenuTarget[] = []
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group([session('alpha:s-2', 's-2')], 'connecting')]}
        retry={vi.fn(async () => {})}
        t={t}
        useContextMenu={() => bindings(captured)}
      />,
    )
    await settle()
    const row = container.querySelector('[data-session-key="alpha:s-2"]')
    if (row === null) throw new Error('fixture: row missing')

    fireEvent.contextMenu(row)

    expect(captured[0]).toMatchObject({
      kind: 'session',
      value: { sessionId: 'alpha:s-2', unavailableReason: 'Instance Connecting: session actions are unavailable' },
    })
  })

  it('keeps Enter and Space activating the row alongside the menu keyboard chord', async () => {
    const captured: ContextMenuTarget[] = []
    const openSession = vi.fn<(key: string) => void>()
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group([session('alpha:s-3', 's-3')])]}
        retry={vi.fn(async () => {})}
        openSession={openSession}
        t={t}
        useContextMenu={() => bindings(captured)}
      />,
    )
    await settle()
    const row = container.querySelector('[data-session-key="alpha:s-3"]')
    if (row === null) throw new Error('fixture: row missing')

    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.keyDown(row, { key: ' ' })

    expect(openSession).toHaveBeenCalledTimes(2)
    expect(openSession).toHaveBeenCalledWith('alpha:s-3', '/repo')
    // Plain activation never opens the menu.
    expect(captured).toEqual([])
  })

  it('renders the same rows when the shell provides no menu bindings', async () => {
    const openSession = vi.fn<(key: string) => void>()
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group([session('alpha:s-4', 's-4')])]}
        retry={vi.fn(async () => {})}
        openSession={openSession}
        t={t}
      />,
    )
    await settle()
    const row = container.querySelector('[data-session-key="alpha:s-4"]')
    if (row === null) throw new Error('fixture: row missing')

    fireEvent.click(row)

    expect(openSession).toHaveBeenCalledWith('alpha:s-4', '/repo')
  })

  it('passes the shell bindings through the slot face', async () => {
    const captured: ContextMenuTarget[] = []
    const Slot = instanceGroupsSlot({ fetchTree: async () => [group([session('alpha:s-5', 's-5')])], retry: vi.fn(async () => {}) })
    const { container } = render(<Slot t={t} wide useContextMenu={() => bindings(captured)} />)
    await settle()
    const row = container.querySelector('[data-session-key="alpha:s-5"]')
    if (row === null) throw new Error('fixture: row missing')

    fireEvent.contextMenu(row)

    expect(captured[0]).toMatchObject({ kind: 'session', value: { sessionId: 'alpha:s-5' } })
  })
})

describe('t100643 / offline rows stay inert', () => {
  it('an unreachable instance keeps its rows out of reach, as before', async () => {
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group([session('alpha:s-6', 's-6')], 'unreachable')]}
        retry={vi.fn(async () => {})}
        t={t}
        useContextMenu={() => bindings([])}
      />,
    )
    await settle()
    expect(container.querySelectorAll('[data-session-key]')).toHaveLength(0)
    expect(screen.getByText(/Unreachable/)).toBeTruthy()
  })
})
