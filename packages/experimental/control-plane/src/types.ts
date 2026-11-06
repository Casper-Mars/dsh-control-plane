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

/** One instance group in the sidebar. */
export interface InstanceNode {
  readonly instanceId: string
  /** `name(id)`, the title the sidebar renders. */
  readonly label: string
  /** Workspaces, ordered by path. */
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
