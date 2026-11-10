/**
 * Control-plane instance groups above the workspace browser.
 *
 * Rendered only when the control plane is composed into this Client (the
 * `controlPlane` Remote namespace is present). The section shows which
 * instances exist, whether each is reachable, its workspaces, and which
 * sessions carry activity; an unreachable instance offers a retry instead of a
 * misleading "0 sessions". Session keys it renders are already qualified
 * (`<instanceId>:<sessionId>`), so the routing work in S3 can attach to the
 * same rows.
 *
 * Presentation reuses the official Workspace-browser row language instead of a
 * private one: the shell's own `--dsh-sidebar-*` geometry, `--dsw-alias-*`
 * design tokens, the official state dots, and the folder/chevron hover swap.
 * The three levels carry three distinct marks without a font-size step: the
 * instance header is 36px with a layers icon, a Workspace is 32px with a folder
 * one step in, and a Session is 32px with no leading mark two steps in (only a
 * running rail). Reachability moved to the instance row's trailing edge, so the
 * leading cell always names the level instead of standing in for a state. The
 * rows are re-built here rather
 * than imported from ui-workspace because ui-workspace's row components take
 * the Workspace browser's own render seats and controllers as props (see the
 * notes on `ProjectRowItem` / `SessionNodeItem` in its `rows/Rows.tsx`), which
 * a control-plane Client does not compose.
 *
 * A session row is the one interactive row of the tree: activating it opens
 * that federated Session in the main column (`openSession`), and the row of the
 * Session the main view currently shows carries the current marker. Rows are
 * native buttons, not tree items: this section is not a tree widget (its
 * headers and rows are plain stacked rows, each folding or navigating on its
 * own), so `button` + `aria-current` keeps the ARIA self-consistent without
 * inventing a roving-tabindex tree around markup that does not nest as one.
 *
 * A workspace row carries two sibling actions (fold, and create a Session in
 * that workspace). It stays a non-interactive flex container around two native
 * buttons instead of becoming a `role="treeitem"`: a treeitem needs a
 * `tree`/`treegroup` owner this section intentionally does not have, and a
 * nested button would be invalid HTML. Two siblings keep both controls
 * keyboard-native (Tab + Enter/Space) and leave the fold state on the button
 * that owns `aria-expanded`, with no composite widget semantics to maintain.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import clsx from 'clsx'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import {
  IconFolderCloseRegular, IconFolderOpenRegular, IconLayersOutlineRegular, IconNewChatOutlineRegular,
  IconTriangleRightFillRegular, relativeTime, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContextMenuBindings, UseContextMenu } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import css from './InstanceGroups.module.css'

/** Reachability of one configured instance; mirrors the control plane's `UpstreamState`. */
export type InstanceState = 'connecting' | 'connected' | 'unreachable'

/** One session row; mirrors the control plane's `SessionNode` fields this section reads. */
export interface InstanceSessionView {
  /** Federated key, `<instanceId>:<sessionId>`. */
  readonly key: string
  /** Instance-local session id; the display fallback when no title is reported. */
  readonly sessionId?: string | undefined
  /** Title the session reported, when the control plane mapped one. */
  readonly title?: string | undefined
  /** Whether an agent turn is currently running. */
  readonly running: boolean
  /** Whether the owning instance lists this Session in its pin set. */
  readonly pinned?: boolean | undefined
  /** Whether the owning instance lists this Session in its archive set. */
  readonly archived?: boolean | undefined
  /** Last update time, epoch milliseconds. */
  readonly updatedAt: number
}

/** One workspace group inside an instance; mirrors the control plane's `WorkspaceNode`. */
export interface InstanceWorkspaceView {
  /** Federated key, `<instanceId>:<cwd>`. */
  readonly key: string
  /** Path shown to the user, without the instance prefix. */
  readonly path: string
  /** User-visible Workspace title from the owner; absent means fall back to `path`. */
  readonly title?: string | undefined
  /**
   * Owner-local Workspace id, when the control plane learned it from the
   * instance's `workspace/follow` baseline. The owner's registry looks
   * workspaces up by this id, so a row without one offers no create control
   * (it would only produce `workspace/not-found`). Absent for the
   * `(no workspace)` placeholder and before the baseline arrives.
   */
  readonly workspaceId?: string | undefined
  /** Sessions, newest activity first. */
  readonly sessions: readonly InstanceSessionView[]
  /** Sessions with a running turn in this workspace. */
  readonly runningCount: number
}

/** One instance group; mirrors the control plane's `InstanceNode`. */
export interface InstanceGroupView {
  readonly instanceId: string
  /** `name(id)`, the title the sidebar renders. */
  readonly label: string
  /**
   * Reachability carried by the tree frame itself. The section reads state
   * from here and nowhere else, so one poll refreshes rows and reachability
   * together (two reads could disagree about the same instance).
   */
  readonly state: InstanceState
  /** Last failure when {@link state} is `unreachable`. */
  readonly error?: string | undefined
  readonly runningCount: number
  readonly sessionCount: number
  readonly workspaces: readonly InstanceWorkspaceView[]
}

/** One instance a `states` frame reports; mirrors `InstanceStateFrame`. */
export interface InstanceStateView {
  /** Configured instance id. */
  readonly instanceId: string
  /** Reachability after the change. */
  readonly state: InstanceState
  /** Last failure when {@link state} is `unreachable`. */
  readonly error?: string | undefined
}

/**
 * One frame of the control-plane `events` stream; mirrors `ControlPlaneEvent`.
 *
 * `tree` replaces the whole view, `status` patches one row's running state in
 * place, `change` asks for a debounced re-read, and `states` patches instance
 * reachability without reading sessions.
 */
export type InstanceGroupsEvent =
  | { readonly kind: 'tree'; readonly tree: readonly InstanceGroupView[] }
  | { readonly kind: 'status'; readonly key: string; readonly running: boolean }
  | { readonly kind: 'change'; readonly key: string; readonly change: 'added' | 'updated' | 'removed' }
  | { readonly kind: 'states'; readonly states: readonly InstanceStateView[] }

/** Remote calls this section makes, plus the local navigation its rows drive. */
export interface InstanceGroupsReaders {
  /** Reads the composed instance → workspace → session tree. */
  readonly fetchTree: () => Promise<readonly InstanceGroupView[]>
  /**
   * Retries one instance without restarting the control plane. Resolves once the
   * attempt settled; the caller re-reads the tree for the outcome.
   */
  readonly retry: (instanceId: string) => Promise<void>
  /**
   * Opens one Session by its complete federated key
   * (`<instanceId>:<localSessionId>`). The section never splits the key: the
   * prefix decides routing, and only the owner knows how to interpret it.
   *
   * The second argument is the Workspace path the tree grouped the row under.
   * It is the only `cwd` evidence a federated Session can carry here (the local
   * catalog never lists one), so navigation forwards it to the Conversation's
   * Workspace chip.
   *
   * Optional only so the section stays renderable without a navigation
   * service (isolated fixtures); a composed control-plane Client always wires
   * it, which is the only composition that renders rows at all.
   */
  readonly openSession?: ((key: string, cwd?: string) => void) | undefined
  /**
   * Creates a Session in one workspace and resolves its owner-local id.
   *
   * The argument is the federated **Workspace id**
   * (`<instanceId>:<workspaceId>`): the control plane strips the instance
   * prefix, forwards the call to the owner, and returns that instance's
   * **bare** Session id. The caller must therefore qualify the result with the
   * instance it used before navigating — the answer is never prefixed here.
   *
   * The id, not the path: the owner's Workspace registry looks rows up by the
   * `randomUUID` it assigned, so a path would be `workspace/not-found`.
   *
   * Optional for the same reason as {@link openSession}: an isolated fixture
   * renders the tree without a Session service. A composed control-plane
   * Client always wires it. Without it the section renders no create control
   * at all, rather than a button that cannot do anything.
   */
  readonly createSession?: ((workspaceId: string) => Promise<string>) | undefined
  /**
   * Re-reads the tree once a created Session exists, so the new row lands
   * immediately instead of on the next poll. Separate from {@link fetchTree}
   * so a caller can supply a different refresh policy (future: incremental).
   */
  readonly refreshTree?: (() => Promise<readonly InstanceGroupView[]>) | undefined
  /**
   * The Session the main view currently shows. The section subscribes with
   * `useSyncExternalStore`, so the current-row marker follows navigation
   * immediately instead of waiting for the next tree poll.
   */
  readonly currentSession?: ObservableSnapshot<string | undefined> | undefined
  /**
   * Subscribes to the control plane's live frames. Present only under a
   * composed control plane: without it the section keeps the fallback poll as
   * its only refresh path.
   */
  readonly events?: ((signal: AbortSignal) => AsyncIterable<InstanceGroupsEvent>) | undefined
}

/** Props of the rendered section. */
export interface InstanceGroupsProps extends InstanceGroupsReaders {
  /** Poll period in milliseconds. */
  readonly intervalMs?: number
  /**
   * The shell's menu bindings (a root standard prop on the slot face). Missing
   * only in isolated fixtures, where rows simply carry no context menu.
   */
  readonly useContextMenu?: UseContextMenu | undefined
}

/**
 * The slice of the Session list the current-Session derivation reads. ui-sidebar
 * does not depend on the Session Controller package, and the derivation is two
 * fields wide, so the shape is named here instead of imported.
 */
export interface SessionListLike {
  readonly byId: Readonly<Record<string, {
    readonly id: string
    readonly retainedBy: { readonly mainView?: number | undefined }
  }>>
}

/**
 * The Session list as the section reads it: the current-Session snapshot plus
 * its subscription. Named here so the wiring site can hold the two-field face
 * without importing the Session Controller package.
 */
export interface SessionListSource {
  getSnapshot(): SessionListLike
  subscribe(listener: () => void): () => void
}

/**
 * The Session the main view currently shows, derived exactly as the Workspace
 * browser derives it (`retainedBy.mainView > 0`), so both surfaces agree on
 * which Session is "current" — including a federated key, which the Session
 * Controller projects into the same list under its complete key.
 * @param list - current Session list state.
 * @returns the main-view Session id, or undefined when nothing is retained.
 */
export function mainSessionId(list: SessionListLike): string | undefined {
  return Object.values(list.byId)
    .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
}

/** In-memory disclosure state; polling frames never touch it. */
interface DisclosureState {
  /** Instance ids the user folded, independent of any frame. */
  readonly collapsedInstances: readonly string[]
  /** Workspace keys the user folded. */
  readonly collapsedWorkspaces: readonly string[]
  /** Raised per-workspace session watermarks; absent means {@link WATERMARK_BASE}. */
  readonly watermarks: Readonly<Record<string, number>>
}

/**
 * Sessions shown per workspace before the "show more" control appears. Matches
 * the previous truncation point, but nothing is dropped silently: the rest are
 * one click away.
 */
const WATERMARK_BASE = 8

/** Rows revealed per "show more" click, mirroring the official browser's step. */
const WATERMARK_STEP = 8

/**
 * Fallback poll period. Pushed frames carry the fast path; this slow read is
 * what recovers whatever a dropped stream lost, so it is never switched off
 * just because the stream exists.
 */
const DEFAULT_POLL_INTERVAL_MS = 30_000

/** Quiet window that coalesces a burst of `change` frames into one tree read. */
const CHANGE_DEBOUNCE_MS = 300

/** First reconnect delay after the event stream ends or fails. */
const RECONNECT_BASE_MS = 1000

/** Ceiling for the exponential reconnect delay. */
const RECONNECT_MAX_MS = 30_000

/**
 * Module-level store: folding survives every 6s poll and a remount of the
 * sidebar content. It holds user choices only — defaults stay derived from the
 * current frame.
 */
const disclosure = createSnapshotStore<DisclosureState>({
  collapsedInstances: [],
  collapsedWorkspaces: [],
  watermarks: {},
})

/**
 * Stable subscribe/snapshot pair for {@link useDisclosureState}. Arrow
 * wrappers keep `useSyncExternalStore` from calling them without the store.
 */
const subscribeDisclosure = (onStoreChange: () => void): (() => void) => disclosure.subscribe(onStoreChange)
const getDisclosureSnapshot = (): DisclosureState => disclosure.getSnapshot()

/** Read the module-level disclosure store. */
function useDisclosureState(): DisclosureState {
  return useSyncExternalStore(subscribeDisclosure, getDisclosureSnapshot, getDisclosureSnapshot)
}

/**
 * Toggle one key inside a readonly string list.
 * @param list - current members.
 * @param key - member to add or remove.
 * @returns a new list with the key toggled.
 */
function toggled(list: readonly string[], key: string): readonly string[] {
  return list.includes(key) ? list.filter(item => item !== key) : [...list, key]
}

/**
 * Longest error message the offline notice shows before eliding. Full text
 * stays on the `title` attribute, so nothing is lost, only contained.
 */
const ERROR_LIMIT = 160

/**
 * One-line failure text for the offline notice: trimmed, length-capped with an
 * ellipsis. An empty or missing message yields undefined and the notice falls
 * back to the generic unreachable label.
 * @param error - last failure reported by the control plane.
 * @returns the display text, or undefined when there is nothing to show.
 */
function errorText(error: string | undefined): string | undefined {
  const text = error?.trim()
  if (text === undefined || text.length === 0) return undefined
  return text.length <= ERROR_LIMIT ? text : `${text.slice(0, ERROR_LIMIT - 1)}…`
}

/**
 * Reconnect delay for one attempt: exponential from {@link RECONNECT_BASE_MS}
 * with half-to-full jitter, so a Host restart does not gather every client on
 * the same tick.
 * @param attempt - zero-based count of consecutive failures.
 * @returns the delay in milliseconds, at most {@link RECONNECT_MAX_MS}.
 */
function reconnectDelay(attempt: number): number {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 5))
  return Math.round(base * (0.5 + Math.random() * 0.5))
}

/**
 * Apply one `status` frame in place: only the addressed row and its two
 * running counters change, so a running turn never costs a tree read.
 * @param groups - current view, or undefined before the first frame.
 * @param key - complete federated Session key (`<instanceId>:<sessionId>`).
 * @param running - state the frame reports.
 * @returns the updated view, or the same reference when nothing changed.
 */
function withRunning(
  groups: readonly InstanceGroupView[] | undefined,
  key: string,
  running: boolean,
): readonly InstanceGroupView[] | undefined {
  if (groups === undefined) return groups
  const next = groups.map((group) => {
    const workspaces = group.workspaces.map((workspace) => {
      const index = workspace.sessions.findIndex(session => session.key === key)
      if (index < 0) return workspace
      const session = workspace.sessions[index]
      if (session === undefined || session.running === running) return workspace
      const sessions = workspace.sessions.slice()
      sessions[index] = { ...session, running }
      return { ...workspace, sessions, runningCount: sessions.filter(row => row.running).length }
    })
    if (!workspaces.some((workspace, index) => workspace !== group.workspaces[index])) return group
    return {
      ...group,
      workspaces,
      runningCount: workspaces.reduce((count, workspace) => count + workspace.runningCount, 0),
    }
  })
  return next.some((group, index) => group !== groups[index]) ? next : groups
}

/**
 * Apply one `states` frame: reachability and failure text only. Rows are left
 * alone because the render gate already hides them under an unreachable group,
 * and a connecting group keeps the rows it had on its way back.
 * @param groups - current view, or undefined before the first frame.
 * @param states - instances whose reachability changed.
 * @returns the updated view, or the same reference when nothing changed.
 */
function withStates(
  groups: readonly InstanceGroupView[] | undefined,
  states: readonly InstanceStateView[],
): readonly InstanceGroupView[] | undefined {
  if (groups === undefined) return groups
  const changed = new Map(states.map(state => [state.instanceId, state]))
  const next = groups.map((group) => {
    const state = changed.get(group.instanceId)
    if (state === undefined || (group.state === state.state && group.error === state.error)) return group
    return {
      instanceId: group.instanceId,
      label: group.label,
      state: state.state,
      ...(state.error === undefined ? {} : { error: state.error }),
      runningCount: group.runningCount,
      sessionCount: group.sessionCount,
      workspaces: group.workspaces,
    }
  })
  return next.some((group, index) => group !== groups[index]) ? next : groups
}

/**
 * Reachability → the official state-dot vocabulary: green connected, the
 * spinner while the first connection is still being established, red
 * unreachable (mirrors how the official rows color their states).
 * @param state - instance reachability.
 * @returns the dot state to render.
 */
function reachabilityDot(state: InstanceState): StateDotState {
  switch (state) {
    case 'connected': return 'done'
    case 'connecting': return 'ongoing'
    case 'unreachable': return 'error'
  }
}

/**
 * Display title of a session row: the reported title when it is non-blank,
 * then the instance-local id, then the key's suffix as the last resort.
 * @param session - session row.
 * @returns the title text.
 */
function sessionTitle(session: InstanceSessionView): string {
  const title = session.title?.trim()
  if (title !== undefined && title.length > 0) return title
  if (session.sessionId !== undefined && session.sessionId.length > 0) return session.sessionId
  const separator = session.key.indexOf(':')
  return separator < 0 ? session.key : session.key.slice(separator + 1)
}

/**
 * Localized compact relative time ("刚刚"/"5分钟" in zh, "now"/"5min" in en),
 * same buckets as the official rows.
 * @param at - epoch ms of the last update.
 * @param now - current epoch ms.
 * @param t - sidebar dictionary.
 * @returns the trailing time label.
 */
function timeLabel(at: number, now: number, t: TranslateNS<'sidebar'>): string {
  const { unit, n } = relativeTime(at, now)
  return unit === 'now' ? t('time.now') : t(`time.${unit}`, { n })
}

/** No-op subscription: the stable stand-in while no current-Session source is wired. */
function subscribeNothing(): () => void {
  return () => {}
}

/**
 * Slot component the sidebar registers into `sidebar.instances`. The readers
 * are closed over, so the shell supplies only the standard locale seat and its
 * column state.
 * @param readers - tree read, per-instance retry, and the Session navigation the rows drive.
 * @returns the slot component.
 */
export function instanceGroupsSlot(readers: InstanceGroupsReaders) {
  return function ControlPlaneInstanceGroups({ t, wide, useContextMenu }: {
    t: TranslateNS<'sidebar'>
    wide: boolean
    useContextMenu?: UseContextMenu | undefined
  }) {
    // The rail has no room for the rows (the same reason the workspace browser
    // swaps to a compact control there), so folding the column unmounts the
    // list and stops its poll; expanding reads a fresh frame.
    return wide ? <InstanceGroups {...readers} t={t} useContextMenu={useContextMenu} /> : null
  }
}

/**
 * Instance groups with their reachability, workspaces, and session rows.
 *
 * One read feeds the whole section: each tree frame carries the per-instance
 * state, so a group can never show a fresh row list next to a stale dot. A
 * failed frame keeps the previous frame, so one unreachable upstream never
 * blanks the tree.
 * @param props - readers, poll period, and the sidebar dictionary seat.
 * @returns the instance section, or nothing while there is neither a frame nor a control plane.
 */
export function InstanceGroups({
  fetchTree, retry, createSession, refreshTree, openSession, currentSession, events,
  intervalMs = DEFAULT_POLL_INTERVAL_MS, t, useContextMenu,
}: InstanceGroupsProps & { t: TranslateNS<'sidebar'> }) {
  // Ordinary function, not a React Hook: the shell hands in one binding set for
  // the plugin lifetime, so reading it per render is the supported usage.
  const menu = useContextMenu?.()
  const [groups, setGroups] = useState<readonly InstanceGroupView[]>()
  // Instance ids whose retry is still running: the button shows progress and
  // refuses a second click until the attempt settles.
  const [retrying, setRetrying] = useState<readonly string[]>([])
  // Last refused open: a row that cannot be opened says so instead of failing
  // silently, and the next accepted open clears the line.
  const [openFailure, setOpenFailure] = useState<string>()
  // Workspace keys with a create in flight: the button renders disabled and a
  // synchronous guard (below) refuses a second click from the same tick.
  const [creating, setCreating] = useState<readonly string[]>([])
  // Last create failure per workspace key. A failed create stays inline under
  // its row instead of taking the tree down; only a later success in the same
  // workspace (or that workspace leaving the tree) drops the message, so a
  // retry keeps showing why the previous attempt failed while it runs.
  const [createFailures, setCreateFailures] = useState<Readonly<Record<string, string>>>({})
  // Synchronous pending set: React state lands after the handler returns, so
  // two clicks in one tick would both pass an `includes` check.
  const creatingKeys = useRef(new Set<string>())
  const disclosureState = useDisclosureState()
  // One subscribed source for the whole section: the readers hand in the same
  // observable every render, so the pair below is stable and the store is read
  // once per commit rather than once per row.
  const subscribeCurrent = useCallback(
    (onStoreChange: () => void): (() => void) => currentSession?.subscribe(onStoreChange) ?? subscribeNothing(),
    [currentSession],
  )
  const readCurrent = useCallback((): string | undefined => currentSession?.getSnapshot(), [currentSession])
  const currentId = useSyncExternalStore(subscribeCurrent, readCurrent, readCurrent)
  // Latest readers: the poll reads through this ref, so a caller that hands in
  // fresh closures every render cannot restart (or multiply) the timer.
  const readers = useRef({ fetchTree, retry, createSession, refreshTree, events })
  // The event subscriber wakes on a debounce timer; the timer outlives a
  // render, so it reads the newest readers through {@link readers}.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Monotonic read ticket. Poll frames, retry re-reads, and post-create
  // refreshes all race: only the newest *requested* frame may land, otherwise a
  // slower older read would commit over a newer one and drop rows it already
  // showed. Allocated before the read starts, compared when it settles.
  const frameTicket = useRef(0)
  /**
   * Claim the ticket of a read that is about to start.
   * @returns the ticket to pass to {@link commitFrame}.
   */
  const beginFrame = (): number => {
    frameTicket.current += 1
    return frameTicket.current
  }
  /**
   * Commit a frame, unless a newer read has been requested since this one
   * started (that newer request owns the tree now, even if it is still in
   * flight or will fail and keep the previous frame).
   * @param ticket - ticket claimed by {@link beginFrame} for this read.
   * @param next - the frame the read produced.
   */
  const commitFrame = (ticket: number, next: readonly InstanceGroupView[]): void => {
    if (ticket !== frameTicket.current) return
    setGroups(next)
  }
  // Frames and retry outcomes that arrive after unmount are dropped.
  const mounted = useRef(true)
  // A function, not a property read: TypeScript would otherwise narrow the
  // ref to `true` and the lint gate would flag the unmount check as dead.
  const isMounted = (): boolean => mounted.current
  useEffect(() => {
    readers.current = { fetchTree, retry, createSession, refreshTree, events }
  })
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (refreshTimer.current !== undefined) clearTimeout(refreshTimer.current)
      refreshTimer.current = undefined
    }
  }, [])

  /**
   * Re-read the tree once, coalescing a burst of `change` frames into one read.
   * The trailing window (not a reset timer) keeps a chatty instance from
   * starving the read: the first frame opens a 300ms window, the read happens
   * when it closes.
   */
  const scheduleRefresh = (): void => {
    if (refreshTimer.current !== undefined) return
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined
      if (!isMounted()) return
      const ticket = beginFrame()
      const read = readers.current.refreshTree ?? readers.current.fetchTree
      void read().then((next) => {
        if (isMounted()) commitFrame(ticket, next)
      }, () => {
        // Keep the previous tree; the fallback poll retries the read.
      })
    }, CHANGE_DEBOUNCE_MS)
  }

  // Live frames. The stream reconnects with exponential backoff when the
  // carrier ends or throws (Host restart, laptop sleep), and re-applies the
  // first frame of the new stream, which is always a complete tree. The
  // fallback poll above keeps running: pushed frames are an optimization, not
  // the only source of truth.
  const hasEvents = events !== undefined
  useEffect(() => {
    if (!hasEvents) return
    // A mutable flag behind a function: TypeScript narrows a boolean assigned
    // only inside the cleanup closure to its initial value.
    const lifecycle = { closed: false }
    const isClosed = (): boolean => lifecycle.closed
    const controller = new AbortController()
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let wakeRetry: (() => void) | undefined
    let failures = 0

    const apply = (frame: InstanceGroupsEvent): void => {
      switch (frame.kind) {
        case 'tree':
          commitFrame(beginFrame(), frame.tree)
          return
        case 'status':
          setGroups(previous => withRunning(previous, frame.key, frame.running))
          return
        case 'states':
          setGroups(previous => withStates(previous, frame.states))
          return
        case 'change':
          scheduleRefresh()
          return
      }
    }

    const wait = async (delay: number): Promise<void> => {
      await new Promise<void>((resolve) => {
        wakeRetry = resolve
        retryTimer = setTimeout(() => {
          retryTimer = undefined
          wakeRetry = undefined
          resolve()
        }, delay)
      })
    }

    const run = async (): Promise<void> => {
      while (!isClosed()) {
        let received = false
        try {
          const stream = readers.current.events?.(controller.signal)
          if (stream === undefined) return
          for await (const frame of stream) {
            if (isClosed()) return
            received = true
            failures = 0
            apply(frame)
          }
        } catch {
          // A dropped stream is expected (Host restart, sleep, network loss).
        }
        if (isClosed()) return
        // A stream that produced frames before ending starts over from the
        // first delay; one that never opened keeps backing off.
        if (received) failures = 0
        await wait(reconnectDelay(failures))
        failures += 1
      }
    }

    void run()
    return () => {
      lifecycle.closed = true
      controller.abort()
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      retryTimer = undefined
      const wake = wakeRetry
      wakeRetry = undefined
      wake?.()
    }
  }, [hasEvents])

  useEffect(() => {
    let disposed = false
    const read = (): void => {
      const ticket = beginFrame()
      void readers.current.fetchTree().then((next) => {
        if (!disposed) commitFrame(ticket, next)
      }, () => {
        // Keep the previous tree: a failed frame must not render as "no instances".
      })
    }
    read()
    const timer = setInterval(read, intervalMs)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [intervalMs])

  // Failure messages belong to the frame that produced them. Once a workspace
  // leaves the tree its message is meaningless, and keeping the key would
  // resurrect the old reason the moment the same path came back. Pruning here
  // (rather than inside a setGroups updater, which must stay pure) keeps the
  // correction in one place; returning `previous` unchanged when nothing is
  // stale keeps it out of a render loop.
  useEffect(() => {
    if (groups === undefined) return
    const live = new Set<string>()
    for (const group of groups) {
      for (const workspace of group.workspaces) live.add(workspace.key)
    }
    setCreateFailures((previous) => {
      const kept = Object.entries(previous).filter(([key]) => live.has(key))
      if (kept.length === Object.keys(previous).length) return previous
      return Object.fromEntries(kept)
    })
  }, [groups])

  /**
   * Retry one instance and re-read the tree so the group shows the outcome of
   * this attempt rather than the state of the previous poll.
   * @param instanceId - instance whose group was clicked.
   */
  const retryInstance = (instanceId: string): void => {
    if (retrying.includes(instanceId)) return
    setRetrying(previous => [...previous, instanceId])
    void (async () => {
      try {
        await readers.current.retry(instanceId)
        // Unmounted while the attempt ran: skip the pointless re-read.
        if (!isMounted()) return
        const ticket = beginFrame()
        const next = await readers.current.fetchTree()
        // Unmounted while the frame was in flight: nothing to update.
        if (!isMounted()) return
        commitFrame(ticket, next)
      } catch {
        // A refused read keeps the previous frame; the next poll retries.
      } finally {
        if (isMounted()) setRetrying(previous => previous.filter(id => id !== instanceId))
      }
    })()
  }

  /**
   * Open one federated Session from its row. The key goes to the Workspace UI
   * whole: it is the routing prefix plus the owner-local id, and only the
   * Gateway's federation router may split it. A refused open (an instance that
   * went offline between the poll and the click) is reported under the tree; it
   * must never take the sidebar down with it.
   * @param key - complete federated Session key of the activated row.
   * @param cwd - Workspace path the row was grouped under, forwarded as the
   * opened Session's hint.
   */
  const open = (key: string, cwd?: string): void => {
    if (openSession === undefined) return
    try {
      openSession(key, cwd)
      if (openFailure !== undefined) setOpenFailure(undefined)
    } catch (error: unknown) {
      setOpenFailure(errorText(error instanceof Error ? error.message : String(error)))
    }
  }

  /**
   * Create a Session in one workspace and open it.
   *
   * The owner-local Workspace id is federated with the instance
   * (`<instanceId>:<workspaceId>`), so the control plane routes the whole call;
   * its answer is the owner-local Session id, which this section prefixes
   * before navigating. A failed refresh does not fail the operation: the
   * create already succeeded, the poll recovers the tree, and navigation still
   * proceeds. A failed create stays inline under the row and restores the
   * button once the attempt settles; it is dropped only when this workspace
   * creates successfully, so a retry never runs behind a blank line.
   * @param instanceId - owning instance, used to qualify both ids.
   * @param workspaceKey - row key (`<instanceId>:<cwd>`), used for the local
   *   pending/failure state and as the display identity.
   * @param workspaceId - owner-local Workspace id; the value the owner accepts.
   * @param workspacePath - path the row was grouped under, forwarded as the
   * opened Session's `cwd` hint.
   */
  const createSessionIn = (
    instanceId: string, workspaceKey: string, workspaceId: string, workspacePath: string,
  ): void => {
    const { createSession } = readers.current
    if (createSession === undefined || creatingKeys.current.has(workspaceKey)) return
    creatingKeys.current.add(workspaceKey)
    setCreating(previous => [...previous, workspaceKey])
    void (async () => {
      try {
        const sessionId = await createSession(`${instanceId}:${workspaceId}`)
        if (!isMounted()) return
        // The attempt succeeded: the reason for the previous failure no longer
        // describes this workspace. Cleared here, not when the retry starts, so
        // the message stays up while the user waits for the outcome.
        setCreateFailures((previous) => {
          if (previous[workspaceKey] === undefined) return previous
          return Object.fromEntries(
            Object.entries(previous).filter(([key]) => key !== workspaceKey),
          )
        })
        const refresh = readers.current.refreshTree
        if (refresh !== undefined) {
          try {
            const ticket = beginFrame()
            const next = await refresh()
            if (isMounted()) commitFrame(ticket, next)
          } catch {
            // Creation succeeded; the next poll carries the new row.
          }
        }
        if (!isMounted()) return
        // The control plane answers with the bare id (see the reader contract).
        open(`${instanceId}:${sessionId}`, workspacePath)
      } catch (error: unknown) {
        if (!isMounted()) return
        const message = errorText(error instanceof Error ? error.message : String(error))
        setCreateFailures(previous => ({
          ...previous,
          [workspaceKey]: message ?? t('instances.createFailedUnknown'),
        }))
      } finally {
        creatingKeys.current.delete(workspaceKey)
        if (isMounted()) setCreating(previous => previous.filter(key => key !== workspaceKey))
      }
    })()
  }

  if (groups === undefined || groups.length === 0) return null
  const now = Date.now()

  return (
    <section className={css.root} data-dsh-instance-groups="">
      {groups.map((group) => {
        const expanded = !disclosureState.collapsedInstances.includes(group.instanceId)
        const stateLabel = t(`instances.state.${group.state}`)
        // A Session operation is an RPC to the owning instance. While that
        // instance is not connected the menu still opens (a connecting group
        // keeps its rows), but every action is disabled and this reason is the
        // row the menu leads with — no operation is offered that would fail on
        // its first forwarded call.
        const unavailableReason = group.state === 'connected'
          ? undefined
          : t('instances.actionUnavailable', { state: stateLabel })
        return (
          <div key={group.instanceId} className={css.group}>
            <button
              type="button"
              className={css.groupHeader}
              data-level="instance"
              aria-expanded={expanded}
              aria-label={group.state === 'unreachable'
                ? t('instances.groupOffline', { name: group.label, state: stateLabel })
                : t('instances.group', { name: group.label, state: stateLabel, n: group.sessionCount })}
              data-instance-id={group.instanceId}
              data-instance-state={group.state}
              onClick={() => {
                const snapshot = disclosure.getSnapshot()
                disclosure.set({
                  ...snapshot,
                  collapsedInstances: toggled(snapshot.collapsedInstances, group.instanceId),
                })
              }}
            >
              <span className={css.slot}>
                <span className={css.levelIcon}>
                  <IconLayersOutlineRegular size={16} />
                </span>
                <span className={css.chevron}>
                  <IconTriangleRightFillRegular className={clsx(css.arrow, expanded && css.arrowOpen)} />
                </span>
              </span>
              <span className={css.title}>{group.label}</span>
              {/* Reachability is a fact about the host, not the host's level:
                  it sits on the trailing edge beside the count. */}
              <span className={css.status}>
                <StateDot state={reachabilityDot(group.state)} />
              </span>
              {/* An offline group must not read as "0 sessions": that is what
                  a connected, empty instance looks like. */}
              <span className={css.count}>
                {group.state === 'connected'
                  ? group.sessionCount
                  : group.state === 'unreachable' ? t('instances.offline') : '—'}
              </span>
            </button>
            {expanded && group.state === 'unreachable' && (
              <InstanceOffline
                group={group}
                retrying={retrying.includes(group.instanceId)}
                onRetry={() => { retryInstance(group.instanceId) }}
                t={t}
              />
            )}
            {expanded && group.state === 'connected' && group.workspaces.length === 0 && (
              <div className={css.empty}>{t('instances.empty')}</div>
            )}
            {/* Rows exist only under a reachable instance: a stale frame that
                still carried workspaces for a now-unreachable instance must not
                leave clickable rows behind. A connecting instance keeps the
                rows its frame carried — it is on its way, not gone. */}
            {/* A create control appears only under a reachable instance whose
                create reader is wired: on a connecting group it is not offered
                yet, and without a reader it would be a button that cannot do
                anything. The gate reads the prop (not the ref) so a reader that
                appears later re-renders the control immediately. A workspace
                the owner has not identified by id offers no control either:
                the owner's registry would reject a path as `workspace/not-found`. */}
            {expanded && group.state !== 'unreachable' && group.workspaces.map((workspace) => {
              const workspaceId = workspace.workspaceId
              return (
                <WorkspaceGroup
                  key={workspace.key}
                  workspace={workspace}
                  canCreate={
                    group.state === 'connected' && createSession !== undefined && workspaceId !== undefined
                  }
                  creating={creating.includes(workspace.key)}
                  createFailure={createFailures[workspace.key]}
                  state={disclosureState}
                  now={now}
                  current={currentId}
                  onOpen={open}
                  onCreate={() => {
                    if (workspaceId === undefined) return
                    createSessionIn(group.instanceId, workspace.key, workspaceId, workspace.path)
                  }}
                  getTriggerProps={menu?.getTriggerProps}
                  unavailableReason={unavailableReason}
                  t={t}
                />
              )
            })}
          </div>
        )
      })}
      {/* A refused open keeps the tree intact and names the failure where the
          user acted; the accessibility hint is announced, not only painted. */}
      {openFailure !== undefined && (
        <p className={css.openFailure} role="alert" data-open-failure="">
          {t('instances.openFailed', { message: openFailure })}
        </p>
      )}
    </section>
  )
}

/**
 * The offline notice under an unreachable instance: the last failure and a
 * retry control. Rendered instead of rows, because an unreachable instance has
 * none to show.
 * @param props.group - instance group in the unreachable state.
 * @param props.retrying - whether this instance's retry is still running.
 * @param props.onRetry - starts a retry.
 * @param props.t - sidebar dictionary.
 * @returns the notice row.
 */
function InstanceOffline({ group, retrying, onRetry, t }: {
  group: InstanceGroupView
  retrying: boolean
  onRetry: () => void
  t: TranslateNS<'sidebar'>
}) {
  const detail = errorText(group.error)
  return (
    <div className={css.notice} data-instance-offline={group.instanceId}>
      <span className={css.error} title={group.error ?? undefined}>
        {detail ?? t('instances.state.unreachable')}
      </span>
      <button
        type="button"
        className={css.retry}
        disabled={retrying}
        onClick={onRetry}
      >
        {retrying ? t('instances.retrying') : t('instances.retry')}
      </button>
    </div>
  )
}

/**
 * One workspace row plus its session rows and its "show more" control.
 * @param props.workspace - workspace node.
 * @param props.canCreate - whether this instance is connected and a create reader is wired
 *   (a connecting group and a reader-less fixture offer no control).
 * @param props.creating - whether a create is in flight for this workspace.
 * @param props.createFailure - last create failure for this workspace, if any.
 * @param props.state - disclosure snapshot.
 * @param props.now - epoch ms for relative times.
 * @param props.current - federated key of the Session the main view shows.
 * @param props.onOpen - opens one row's Session by its complete federated key.
 * @param props.onCreate - creates a Session in this workspace.
 * @param props.getTriggerProps - menu bindings for one Session row, when the shell provides them.
 * @param props.unavailableReason - why Session operations cannot run right now, when they cannot.
 * @param props.t - sidebar dictionary.
 * @returns the workspace block.
 */
function WorkspaceGroup({
  workspace, canCreate, creating, createFailure,
  state, now, current, onOpen, onCreate, getTriggerProps, unavailableReason, t,
}: {
  workspace: InstanceWorkspaceView
  canCreate: boolean
  creating: boolean
  createFailure: string | undefined
  state: DisclosureState
  now: number
  current: string | undefined
  onOpen: (key: string, cwd?: string) => void
  onCreate: () => void
  getTriggerProps: ContextMenuBindings['getTriggerProps'] | undefined
  unavailableReason: string | undefined
  t: TranslateNS<'sidebar'>
}) {
  const expanded = !state.collapsedWorkspaces.includes(workspace.key)
  const watermark = state.watermarks[workspace.key] ?? WATERMARK_BASE
  const sessions = workspace.sessions.slice(0, watermark)
  const hidden = workspace.sessions.length - sessions.length
  const label = workspace.title ?? workspace.path
  return (
    <>
      {/* A row container, not a control: the fold button and the create button
          are siblings, so neither nests inside the other and both keep native
          button semantics. `data-workspace-key` stays on the fold button, the
          element that owns `aria-expanded` and performs the disclosed action. */}
      <div className={css.workspaceRow} data-level="workspace" data-workspace-row={workspace.key}>
        <button
          type="button"
          className={css.workspaceToggle}
          aria-expanded={expanded}
          data-workspace-key={workspace.key}
          title={workspace.path}
          onClick={() => {
            const snapshot = disclosure.getSnapshot()
            disclosure.set({
              ...snapshot,
              collapsedWorkspaces: toggled(snapshot.collapsedWorkspaces, workspace.key),
            })
          }}
        >
          <span className={css.slot}>
            <span className={css.folder}>
              {expanded ? <IconFolderOpenRegular /> : <IconFolderCloseRegular />}
            </span>
            <span className={css.chevron}>
              <IconTriangleRightFillRegular className={clsx(css.arrow, expanded && css.arrowOpen)} />
            </span>
          </span>
          <span className={css.title}>{label}</span>
          <span className={css.count}>{workspace.sessions.length}</span>
        </button>
        {canCreate && (
          // The visible affordance is an icon; the name says where the
          // Session will be created, which the icon alone cannot convey.
          // Enter/Space are consumed before activating so a modified chord
          // stays inert and the path is deterministic under test.
          <button
            type="button"
            className={css.workspaceCreate}
            aria-label={t('instances.workspace.newSession', { workspace: label })}
            data-workspace-create={workspace.key}
            disabled={creating}
            aria-busy={creating ? 'true' : undefined}
            onClick={onCreate}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
              onCreate()
            }}
          >
            <IconNewChatOutlineRegular size={14} />
          </button>
        )}
      </div>
      {createFailure !== undefined && (
        <p className={css.createFailure} role="alert" data-create-failure={workspace.key}>
          {t('instances.createFailed', { name: label, message: createFailure })}
        </p>
      )}
      {expanded && sessions.map((session) => {
        const title = sessionTitle(session)
        const selected = session.key === current
        // The target carries the owner's pin/archive facts: this Client's
        // Workspace catalog has no row for a federated Session, so the menu
        // cannot derive them locally. The key stays whole — only the Gateway's
        // federation router splits the instance prefix.
        const menuTarget = {
          kind: 'session' as const,
          value: {
            sessionId: session.key as SessionId,
            displayTitle: title,
            pinned: session.pinned === true,
            archived: session.archived === true,
            ...(unavailableReason === undefined ? {} : { unavailableReason }),
          },
        }
        const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
          if (event.target !== event.currentTarget) return
          if (event.key !== 'Enter' && event.key !== ' ') return
          // Consume the press before deciding: a modified chord is not this
          // row's command, and the native activation must not fire for it.
          event.preventDefault()
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          onOpen(session.key, workspace.path)
        }
        return (
          <button
            key={session.key}
            type="button"
            className={clsx(css.sessionRow, selected && css.sessionRowCurrent)}
            data-level="session"
            data-session-key={session.key}
            // The visible row is a title and a timestamp; the accessible name
            // is the action it performs, so the timestamp is not read as part
            // of the Session's name.
            aria-label={t('instances.session.open', { name: title })}
            aria-current={selected ? 'true' : undefined}
            title={session.key}
            onClick={() => { onOpen(session.key, workspace.path) }}
            onKeyDown={onKeyDown}
            // The menu's binding adds the context-menu chord and repeats
            // `onKeyDown`; without bindings the row keeps plain activation.
            {...getTriggerProps === undefined ? {} : getTriggerProps(menuTarget, { onKeyDown })}
          >
            <span className={css.slot}>
              {session.running && <span className={css.runningBar} aria-hidden="true" />}
            </span>
            <span className={css.title}>{title}</span>
            <span className={css.time}>{timeLabel(session.updatedAt, now, t)}</span>
          </button>
        )
      })}
      {expanded && workspace.sessions.length > WATERMARK_BASE && (
        <button
          type="button"
          className={css.more}
          aria-expanded={hidden === 0}
          onClick={() => {
            const snapshot = disclosure.getSnapshot()
            const current = snapshot.watermarks[workspace.key] ?? WATERMARK_BASE
            if (hidden === 0) {
              const watermarks = Object.fromEntries(
                Object.entries(snapshot.watermarks).filter(([key]) => key !== workspace.key),
              )
              disclosure.set({ ...snapshot, watermarks })
              return
            }
            const next = hidden <= WATERMARK_BASE ? Number.POSITIVE_INFINITY : current + WATERMARK_STEP
            disclosure.set({ ...snapshot, watermarks: { ...snapshot.watermarks, [workspace.key]: next } })
          }}
        >
          {hidden === 0 ? t('instances.collapse') : t('instances.expand', { n: hidden })}
        </button>
      )}
    </>
  )
}
