import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import type { ConversationContentProps, ConversationViewsProps, InputZone } from '../contract/slots.ts'
import { HeroShell, WorkspaceChip, workspaceLabel } from './EmptyHero.tsx'
import { ControlPlaneEmpty } from './ControlPlaneEmpty.tsx'
import css from './ConversationRoot.module.css'

/**
 * Whether one Session identity is instance-qualified (`<instanceId>:<local>`).
 *
 * Restated locally because the client bundle purity gate forbids a value import
 * from the Session Controller's module table row; the shape rule is identical
 * to `packages/api/session-controller/src/client/federation.ts`.
 * @param id - Session identity from navigation or the Session list.
 * @returns whether the identity names a Session on another instance.
 */
function isFederatedSessionId(id: string): boolean {
  const separator = id.indexOf(':')
  return separator > 0 && separator < id.length - 1
}

function ConversationSessionView({ renderSlot }: ConversationViewsProps) {
  return renderSlot('conversation.session', {})
}

function NoConversationWidthControls() {
  return null
}

/**
 * Render the shared Conversation body and its occurrence-selected local Components.
 *
 * A control plane owns remote instances only, so with no Session selected there
 * is nothing to prompt: the Hero's composer, model selector, and workspace
 * chrome would all be dead controls. That one combination renders the centered
 * notice instead. Selecting a Session (including a federated one) keeps the
 * ordinary Conversation below.
 * @param props - Factory input, standard Session sources, and Conversation seats.
 * @returns the empty notice, or the Conversation view, Composer, and width controls.
 */
export function ConversationContent(props: ConversationContentProps) {
  if (props.controlPlane && props.sessionId === undefined) {
    return <ControlPlaneEmpty t={props.t} />
  }
  return <ConversationSurface {...props} />
}

/**
 * Render the Conversation view, Composer chain, and optional width controls.
 * @param props - Factory input, standard Session sources, and Conversation seats.
 * @returns the Conversation body.
 */
function ConversationSurface(props: ConversationContentProps) {
  const {
    sessionId, phase, hero, useSession, useSessions, useSessionStatus,
    useWorkspaces, useInput, useComposerBlock, renderSlot, renderSlotChain,
    selectWorkspace, t, useFactorySlot,
  } = props
  const session = useSession(snapshot => snapshot)
  const Views = useFactorySlot('views', ConversationSessionView)
  const WidthControls = useFactorySlot('widthControls', NoConversationWidthControls)
  const [body, setBody] = useState<HTMLDivElement | null>(null)
  const pendingInteraction = useSessionStatus(snapshot =>
    sessionId === undefined ? undefined : snapshot.get(sessionId)?.pendingInteraction)
  const inputState = useInput(s => s)
  const cwd = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.cwd)
  const workspaces = useWorkspaces(s => s)
  // A federated Session is owned by another instance: this Client's Workspace
  // catalog never lists it, and its `cwd` reaches the identity row only as the
  // control-plane tree's hint, which is authoritative regardless of the local
  // list's phase.
  const federated = sessionId !== undefined && isFederatedSessionId(sessionId)
  // A plugin this package cannot import (ui-model-selection) says this session cannot
  // send; its reason is already localized by whoever raised it.
  const composerBlock = useComposerBlock(block => block)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<WorkspaceId | undefined>()
  const pickerAnchor = useRef<HTMLButtonElement>(null)

  // Publishes the two live measurements floating View chrome reads off the
  // scroll body: the seat's height as --dsh-composer-height, so controls clear
  // the composer as it grows, and the scrollport's own height as
  // --dsh-conversation-viewport-height, so a control can sit in the band the
  // seat leaves visible. Callback ref, not an effect; stable identity prevents
  // observer churn while the first blank session fills the resident body
  // outlet.
  const seatObserver = useRef<ResizeObserver | null>(null)
  const seatResizeRef = useCallback((seat: HTMLDivElement | null): void => {
    seatObserver.current?.disconnect()
    seatObserver.current = null
    const scroller = seat?.parentElement ?? null
    if (seat === null || scroller === null) return
    seatObserver.current = new ResizeObserver(() => {
      scroller.style.setProperty('--dsh-composer-height', `${seat.offsetHeight}px`)
      scroller.style.setProperty(
        '--dsh-conversation-viewport-height',
        `${scroller.clientHeight}px`,
      )
    })
    seatObserver.current.observe(seat)
    seatObserver.current.observe(scroller)
  }, [])

  const sessionWorkspace = sessionId === undefined
    ? undefined
    : workspaces.items.find(workspace => workspace.sessionIds.includes(sessionId))
  const pendingWorkspace = workspaces.items.find(
    workspace => workspace.workspaceId === pendingWorkspaceId,
  )

  // Clear the pending pick once the session lands in it, or when the picked
  // workspace disappears from a ready list (deleted from the sidebar).
  useEffect(() => {
    if (pendingWorkspaceId === undefined) return
    if (sessionWorkspace?.workspaceId === pendingWorkspaceId
      || (workspaces.phase === 'ready' && pendingWorkspace === undefined)) {
      setPendingWorkspaceId(undefined)
    }
  }, [pendingWorkspaceId, sessionWorkspace?.workspaceId, workspaces.phase, pendingWorkspace])

  const zone: InputZone | undefined =
    session === undefined || inputState === undefined ? undefined : { session, input: inputState }

  // The chip is a selector; label resolution walks the flow top-down:
  //   1. a just-picked workspace (pending) → its title;
  //   2. cold start, no session yet → placeholder ("Choose workspace");
  //   3. the blank session's workspace is in the list → its title;
  //   4. list still loading → cwd folder name bridges so the title does not
  //      flash on refresh (empty cwd → placeholder);
  //   5. list ready but no owning workspace (deleted from the sidebar) →
  //      placeholder, never the deleted folder's name via cwd.
  // A title still automatic reads in the reader's language, matching the
  // sidebar row the same Workspace has there.
  // A local cwd bridges only while the list loads: once it is ready, a cwd with
  // no owning Workspace means that Workspace was deleted, and the picker must
  // say so instead of impersonating it with the dead folder's name. A
  // federated cwd is the opposite case — there is no local membership to wait
  // for — so its hint always names the owner's Workspace.
  const cwdTitle = cwd === undefined || cwd === ''
    ? undefined
    : federated || workspaces.phase !== 'ready' ? workspaceLabel(cwd) : undefined
  const storedChipTitle = pendingWorkspace?.title
    ?? (sessionId === undefined
      ? undefined
      : sessionWorkspace?.title ?? cwdTitle)
  const chipTitle = storedChipTitle === undefined
    ? undefined
    : workspaceDisplayTitle(storedChipTitle, t('workspace.defaultName'))

  // A federated Session is bound to its owning instance: this Client can never
  // switch its Workspace, and even a disabled chip would still be announced as
  // "Choose workspace". Render no chip and mount no workspace slot at all; the
  // row keeps its other seats (agent preset, plugin options). `chipTitle` above
  // still decides the composer's inert posture and the empty-state copy.
  const heroWorkspaceRow = (
    <div className={css.heroWorkspaceRow}>
      {federated ? null : (
        <>
          <WorkspaceChip
            buttonRef={pickerAnchor}
            label={chipTitle}
            menuOpen={pickerOpen}
            onClick={() => { setPickerOpen(open => !open) }}
            t={t}
          />
          {renderSlot('conversation.hero.workspace', {
            open: pickerOpen,
            anchorRef: pickerAnchor,
            selectedId: pendingWorkspaceId ?? sessionWorkspace?.workspaceId,
            onPick: (workspaceId) => {
              setPickerOpen(false)
              setPendingWorkspaceId(workspaceId)
              void selectWorkspace(workspaceId).catch(() => {
                setPendingWorkspaceId(current => current === workspaceId ? undefined : current)
              })
            },
            onClose: () => { setPickerOpen(false) },
          })}
        </>
      )}
      {renderSlot('conversation.hero.agentPreset', {})}
      {sessionId === undefined ? null : <div className={css.heroOptions}>{renderSlot('conversation.hero.options', {})}</div>}
    </div>
  )

  // The placeholder chip ("Choose workspace") and the Workspace-trigger input travel
  // together: no workspace picked yet (cold start, no session at all), or a
  // blank session whose workspace vanished (deleted from the sidebar). The
  // bar is ONE session-maybe slot rendered unconditionally — inert is a prop,
  // not a different tree, so the textarea DOM survives the transition.
  const inert = sessionId === undefined || (hero && chipTitle === undefined)
  // A raised block is the same inert posture with the blocker's own reason:
  // one disabled textarea, never a second tree. The no-workspace state wins
  // when both hold — picking a workspace is the earlier prerequisite.
  const blocked = !inert && composerBlock !== undefined
  const inputBar = renderSlot('conversation.composer.bar', {
    variant: hero ? 'hero' : 'composer',
    ...(inert
      ? {
        disabled: true,
        // A federated row has no local picker to open; its notice names the
        // recovery action (choose the Session from the instance in the sidebar).
        placeholder: federated ? t('empty.controlPlane.description') : t('placeholder.workspace'),
        ...(federated
          ? {}
          : {
            workspacePickerOpen: pickerOpen,
            onRequestWorkspace: () => { setPickerOpen(true) },
          }),
      }
      : blocked
        // `blocked`, not `disabled`: the bar refuses input either way, but a
        // block keeps the model seat live because choosing a model is how the
        // user clears it.
        ? { blocked: composerBlock, placeholder: composerBlock.reason }
        : hero ? { placeholder: t('placeholder.hero') } : {}),
  })

  const composerBar = (
    <div className={clsx(css.composerStack, hero && css.composerHero)}>
      {hero && <HeroShell t={t} renderSlot={renderSlot} />}
      {hero && heroWorkspaceRow}
      {zone !== undefined && renderSlot('conversation.input.dock', zone)}
      {inputBar}
    </div>
  )

  const composer = renderSlotChain(
    'conversation.composer',
    { sessionId, session, pendingInteraction },
    { fallback: composerBar, fallbackOnly: sessionId === undefined, overlay: true },
  )

  // Sticky wraps the whole chain output (fallback + elected overlay), not
  // only `.composerStack`: overlay:true renders those as siblings, and sticky
  // on the fallback alone would leave a business-owned takeover at the content
  // end off-screen when the user is not pinned to the floor.
  const composerSeat = (
    <div ref={seatResizeRef} className={css.composerSeat} data-composer-seat="" data-conversation-region="composer">
      {composer}
    </div>
  )

  return (
    <div
      ref={setBody}
      className={clsx(css.body, props.variant === 'embedded' && css.embeddedBody)}
      data-conversation-content=""
      data-conversation-session={sessionId}
      data-conversation-region="chat"
      data-content-phase={phase}
    >
      {/* The frame wraps the scroll body in every phase, so leaving the home keeps the composer mounted. */}
      {renderSlot('conversation.hero.frame', { hero: hero && props.variant !== 'embedded' }, {
        children: (
          <div className={css.scrollBody} data-conversation-scroll="">
            {sessionId === undefined ? null : <Views />}
            {composerSeat}
          </div>
        ),
      })}
      <WidthControls container={body} phase={phase} />
    </div>
  )
}
