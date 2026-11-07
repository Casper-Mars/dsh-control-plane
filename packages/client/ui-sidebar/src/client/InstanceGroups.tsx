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
 * private one: 32px rows, 16px leading cells, the shell's own
 * `--dsh-sidebar-*` geometry, `--dsw-alias-*` design tokens, the official state
 * dots, and the folder/chevron hover swap. The rows are re-built here rather
 * than imported from ui-workspace because ui-workspace's row components take
 * the Workspace browser's own render seats and controllers as props (see the
 * notes on `ProjectRowItem` / `SessionNodeItem` in its `rows/Rows.tsx`), which
 * a control-plane Client does not compose.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  IconFolderCloseRegular, IconFolderOpenRegular, IconTriangleRightFillRegular,
  relativeTime, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
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
  /** Last update time, epoch milliseconds. */
  readonly updatedAt: number
}

/** One workspace group inside an instance; mirrors the control plane's `WorkspaceNode`. */
export interface InstanceWorkspaceView {
  /** Federated key, `<instanceId>:<cwd>`. */
  readonly key: string
  /** Path shown to the user, without the instance prefix. */
  readonly path: string
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

/** Remote calls this section makes. */
export interface InstanceGroupsReaders {
  /** Reads the composed instance → workspace → session tree. */
  readonly fetchTree: () => Promise<readonly InstanceGroupView[]>
  /**
   * Retries one instance without restarting the control plane. Resolves once the
   * attempt settled; the caller re-reads the tree for the outcome.
   */
  readonly retry: (instanceId: string) => Promise<void>
}

/** Props of the rendered section. */
export interface InstanceGroupsProps extends InstanceGroupsReaders {
  /** Poll period in milliseconds. */
  readonly intervalMs?: number
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

/**
 * Slot component the sidebar registers into `sidebar.instances`. The readers
 * are closed over, so the shell supplies only the standard locale seat and its
 * column state.
 * @param readers - tree read and the per-instance retry.
 * @returns the slot component.
 */
export function instanceGroupsSlot(readers: InstanceGroupsReaders) {
  return function ControlPlaneInstanceGroups({ t, wide }: { t: TranslateNS<'sidebar'>; wide: boolean }) {
    // The rail has no room for the rows (the same reason the workspace browser
    // swaps to a compact control there), so folding the column unmounts the
    // list and stops its poll; expanding reads a fresh frame.
    return wide ? <InstanceGroups {...readers} t={t} /> : null
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
  fetchTree, retry, intervalMs = 6000, t,
}: InstanceGroupsProps & { t: TranslateNS<'sidebar'> }) {
  const [groups, setGroups] = useState<readonly InstanceGroupView[]>()
  // Instance ids whose retry is still running: the button shows progress and
  // refuses a second click until the attempt settles.
  const [retrying, setRetrying] = useState<readonly string[]>([])
  const disclosureState = useDisclosureState()
  // Latest readers: the poll reads through this ref, so a caller that hands in
  // fresh closures every render cannot restart (or multiply) the timer.
  const readers = useRef({ fetchTree, retry })
  // Frames and retry outcomes that arrive after unmount are dropped.
  const mounted = useRef(true)
  // A function, not a property read: TypeScript would otherwise narrow the
  // ref to `true` and the lint gate would flag the unmount check as dead.
  const isMounted = (): boolean => mounted.current
  useEffect(() => {
    readers.current = { fetchTree, retry }
  })
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let disposed = false
    const read = (): void => {
      void readers.current.fetchTree().then((next) => {
        if (!disposed) setGroups(next)
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
        const next = await readers.current.fetchTree()
        // Unmounted while the frame was in flight: nothing to update.
        if (!isMounted()) return
        setGroups(next)
      } catch {
        // A refused read keeps the previous frame; the next poll retries.
      } finally {
        if (isMounted()) setRetrying(previous => previous.filter(id => id !== instanceId))
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
        return (
          <div key={group.instanceId} className={css.group}>
            <button
              type="button"
              className={css.groupHeader}
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
                <span className={css.state}>
                  <StateDot state={reachabilityDot(group.state)} />
                </span>
                <span className={css.chevron}>
                  <IconTriangleRightFillRegular className={clsx(css.arrow, expanded && css.arrowOpen)} />
                </span>
              </span>
              <span className={css.title}>{group.label}</span>
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
            {expanded && group.workspaces.map(workspace => (
              <WorkspaceGroup
                key={workspace.key}
                workspace={workspace}
                state={disclosureState}
                now={now}
                t={t}
              />
            ))}
          </div>
        )
      })}
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
 * @param props.state - disclosure snapshot.
 * @param props.now - epoch ms for relative times.
 * @param props.t - sidebar dictionary.
 * @returns the workspace block.
 */
function WorkspaceGroup({ workspace, state, now, t }: {
  workspace: InstanceWorkspaceView
  state: DisclosureState
  now: number
  t: TranslateNS<'sidebar'>
}) {
  const expanded = !state.collapsedWorkspaces.includes(workspace.key)
  const watermark = state.watermarks[workspace.key] ?? WATERMARK_BASE
  const sessions = workspace.sessions.slice(0, watermark)
  const hidden = workspace.sessions.length - sessions.length
  return (
    <>
      <button
        type="button"
        className={css.workspaceRow}
        aria-expanded={expanded}
        data-workspace-key={workspace.key}
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
        <span className={css.title}>{workspace.path}</span>
        <span className={css.count}>{workspace.sessions.length}</span>
      </button>
      {expanded && sessions.map(session => (
        <div
          key={session.key}
          className={css.sessionRow}
          data-session-key={session.key}
          title={session.key}
        >
          <span className={css.slot}>
            <StateDot state={session.running ? 'ongoing' : 'idle'} />
          </span>
          <span className={css.title}>{sessionTitle(session)}</span>
          <span className={css.time}>{timeLabel(session.updatedAt, now, t)}</span>
        </div>
      ))}
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
