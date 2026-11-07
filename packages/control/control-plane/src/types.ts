/**
 * Types crossing the Remote boundary (and the sidebar's view types).
 *
 * Typert requires every boundary type to be reachable from a public type
 * subpath, so this module is exported as `@deepseek-ai/dsh-control-plane/types`
 * and the root re-exports it for convenience.
 * @module @deepseek-ai/dsh-control-plane/types
 */

/** Reachability a sidebar group reports. */
export type UpstreamState = 'connecting' | 'connected' | 'unreachable'

/** Kinds of session change the sidebar reacts to. */
export type SessionChange = 'added' | 'updated' | 'removed'

/** Session facts the sidebar needs; a projection of `SessionSummary`. */
export interface SessionRow {
  /** Instance-local session id, exactly as the instance reported it. */
  readonly sessionId: string
  /** Instance-local working directory when the instance reports one. */
  readonly cwd?: string | undefined
  /**
   * Title the session reported through its `title` projection. Present only
   * when the projection carried a non-blank string; absent otherwise, so the
   * sidebar falls back to the session id.
   */
  readonly title?: string | undefined
  /** Last update time, epoch milliseconds. */
  readonly updatedAt: number
  /** Whether an agent turn is currently running. */
  readonly running: boolean
  /** Whether this session currently owns a live agent. */
  readonly agentAvailable?: boolean | undefined
}

/** One session row in the composed tree. */
export interface SessionNode extends SessionRow {
  /** Federated key: `<instanceId>:<sessionId>`. */
  readonly key: string
  /** Instance that owns this session. */
  readonly instanceId: string
}

/** One workspace group inside an instance. */
export interface WorkspaceNode {
  /** Federated path: `<instanceId>:<cwd>`. */
  readonly key: string
  /** Path shown to the user, without the instance prefix. */
  readonly path: string
  /** Sessions, newest activity first. */
  readonly sessions: readonly SessionNode[]
  /** Sessions with a running turn in this workspace. */
  readonly runningCount: number
  /** Newest `updatedAt` in this workspace, 0 when empty. */
  readonly latestUpdatedAt: number
}

/** Reachability of one instance plus its last failure. */
export interface InstanceStateReport {
  readonly state: UpstreamState
  /** Last failure when unreachable. */
  readonly error?: string | undefined
}

/** One instance group in the sidebar. */
export interface InstanceNode {
  readonly instanceId: string
  /** `name(id)`, the title the sidebar renders. */
  readonly label: string
  /**
   * Reachability at the moment this frame was composed. An unreachable
   * instance still appears (configuration order), but carries no sessions, so
   * the sidebar must read this field instead of treating `sessionCount === 0`
   * as "connected and empty".
   */
  readonly state: UpstreamState
  /** Last failure when {@link state} is `unreachable`. */
  readonly error?: string | undefined
  /** Workspaces, ordered by path. Empty while the instance is not connected. */
  readonly workspaces: readonly WorkspaceNode[]
  /** Sessions with a running turn in this instance. */
  readonly runningCount: number
  /** Total sessions in this instance. */
  readonly sessionCount: number
}

/** One configured instance and its reachability, for group headers. */
export interface InstanceInfo {
  readonly id: string
  readonly name: string
  /** `name(id)`. */
  readonly label: string
  readonly state: UpstreamState
  /** Last failure when unreachable. */
  readonly error?: string | undefined
}

/** Request of the `reconnect` Remote method. */
export interface ReconnectRequest {
  /** Configured instance id to reconnect. */
  readonly instanceId: string
}

/**
 * Value of the `reconnect` Remote method.
 *
 * A failed retry is a value, not a rejection: the sidebar has to show the
 * failure reason on the group it just retried.
 */
export interface ReconnectValue {
  readonly state: UpstreamState
  /** Failure message when the retry did not reconnect. */
  readonly error?: string | undefined
}

/**
 * One instance's reachability inside a `states` event frame.
 *
 * It carries the same fields a tree node reports, but only for the instances
 * that moved, so a reachability change does not force a whole tree read.
 */
export interface InstanceStateFrame {
  /** Configured instance id. */
  readonly instanceId: string
  /** Reachability after the change. */
  readonly state: UpstreamState
  /** Last failure when {@link state} is `unreachable`. */
  readonly error?: string | undefined
}

/**
 * One frame of the `controlPlane/events` stream.
 *
 * `tree` replaces the whole sidebar view (subscription start, reconnection, and
 * after a reachability change), `status` patches one session's running state,
 * `change` reports one session add/update/remove, and `states` patches instance
 * reachability without re-reading sessions.
 */
export type ControlPlaneEvent =
  | { readonly kind: 'tree'; readonly tree: readonly InstanceNode[] }
  | { readonly kind: 'status'; readonly key: string; readonly running: boolean }
  | { readonly kind: 'change'; readonly key: string; readonly change: SessionChange }
  | { readonly kind: 'states'; readonly states: readonly InstanceStateFrame[] }

/** Request of the `route` Remote method. */
export interface RouteRequest {
  /** `<instanceId>:<sessionId>`. */
  readonly key: string
}

/** Value of the `route` Remote method. */
export interface RouteValue {
  readonly instanceId: string
  readonly sessionId: string
}
