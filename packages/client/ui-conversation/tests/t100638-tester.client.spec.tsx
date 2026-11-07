// @vitest-environment jsdom
/**
 * t100638 tester — the shell side of the federated `blank` row.
 *
 * `ConversationMainPanel` decides hero vs. settling from the *list row's*
 * `blank`, not the open Session snapshot. The federated projection fixes that
 * row to `false`; these cases pin the visible consequence: a remote Session
 * that has not delivered state yet settles instead of rendering the local
 * blank hero, while a genuinely local blank keeps the hero it always had.
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionListState, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { EMPTY_CONVERSATION_SNAPSHOT } from '@deepseek-ai/dsh-client-ui-conversation/src/client/contract/snapshot.ts'
import type { ConversationSlotProps } from '@deepseek-ai/dsh-client-ui-conversation/src/client/contract/slots.ts'
import { ConversationMainPanel } from '@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/ConversationMainPanel.tsx'

const SID = 'alpha:s-1' as SessionId

afterEach(() => { cleanup() })

function sessionSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: SID,
    openState: 'loading',
    openError: null,
    running: false,
    blank: true,
    awaitingFirstTurn: false,
    promptAttempted: false,
    ...overrides,
  } as SessionSnapshot
}

function listState(blank: boolean | undefined): SessionListState {
  const byId: SessionListState['byId'] = {}
  if (blank !== undefined) {
    byId[SID] = {
      id: SID,
      displayTitle: SID,
      running: false,
      retainedBy: { mainView: 1 },
      blank,
      updatedAt: 0,
    }
  }
  return { ids: [], byId, phase: 'ready', projectionsBySession: {} }
}

function mount(snapshot: SessionSnapshot, rowBlank: boolean | undefined): 'settling' | 'hero' | 'active' {
  const sessions = createSnapshotStore(listState(rowBlank))
  const props = {
    sessionId: SID,
    useSession: (selector: (value: SessionSnapshot) => unknown) => selector(snapshot),
    useConversation: (selector: (value: typeof EMPTY_CONVERSATION_SNAPSHOT) => unknown) => selector(EMPTY_CONVERSATION_SNAPSHOT),
    useSessions: (selector: (value: SessionListState) => unknown) => selector(sessions.getSnapshot()),
    renderSlot: () => null,
    renderFactorySlot: () => null,
  } as unknown as ConversationSlotProps
  const view = render(<ConversationMainPanel {...props} />)
  return view.container.querySelector('[data-phase]')?.getAttribute('data-phase') as
    'settling' | 'hero' | 'active'
}

describe('a federated row keeps the chat area out of the blank hero', () => {
  it('settles while state is outstanding because the row is not blank', () => {
    expect(mount(sessionSnapshot({ blank: true, openState: 'loading' }), false)).toBe('settling')
  })

  it('would have rendered the hero had the row claimed blank (the pre-fix shape)', () => {
    expect(mount(sessionSnapshot({ blank: true, openState: 'loading' }), true)).toBe('hero')
  })

  it('settles conservatively when the list has no row at all', () => {
    expect(mount(sessionSnapshot({ blank: true, openState: 'loading' }), undefined)).toBe('settling')
  })

  it('a local blank still opens straight into its hero', () => {
    expect(mount(sessionSnapshot({ blank: true, openState: 'loading' }), true)).toBe('hero')
  })
})
