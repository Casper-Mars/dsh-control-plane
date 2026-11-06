/**
 * Sidebar data model: instance → workspace → session.
 *
 * Every id that crosses the federation boundary is qualified with its
 * instance, because `dsh` session ids are process-local (`session-1` exists in
 * every instance) and workspace paths repeat across instances (`/workspace`).
 * Encoding is `<instanceId>:<rest>`; the rest is kept verbatim, so a Windows
 * path (`C:\work`) or a session id containing `:` still round-trips.
 * @module @deepseek-ai/dsh-control-plane/src/tree
 */

import type { ResolvedInstance } from './config.ts'

/** Separator between the instance id and the instance-local value. */
const SEPARATOR = ':'

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
  /** Federated path: `<instanceId>:<cwd>`; `undefined` sessions use the instance placeholder. */
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

/** Placeholder path for sessions an instance reports without `cwd`. */
export const NO_WORKSPACE = '(no workspace)'

/**
 * Qualify an instance-local value for the wire.
 * @param instanceId - the owning instance.
 * @param value - instance-local id or path.
 * @returns `<instanceId>:<value>`.
 */
export function qualify(instanceId: string, value: string): string {
  return `${instanceId}${SEPARATOR}${value}`
}

/**
 * Split a federated key back into its parts.
 * @param key - `<instanceId>:<value>`.
 * @returns the parts; throws when the key carries no separator or an empty side.
 */
export function split(key: string): { instanceId: string; value: string } {
  const index = key.indexOf(SEPARATOR)
  if (index <= 0 || index === key.length - 1) {
    throw new Error(`control-plane: 不是合法的联邦键 ${JSON.stringify(key)}`)
  }
  return { instanceId: key.slice(0, index), value: key.slice(index + 1) }
}

/**
 * Compose the sidebar tree from per-instance session lists.
 * @param instances - configuration order; instances without sessions still appear.
 * @param sessionsByInstance - raw rows keyed by instance id.
 * @returns instance nodes in configuration order, workspaces by path, sessions newest first.
 */
export function buildTree(
  instances: readonly ResolvedInstance[],
  sessionsByInstance: ReadonlyMap<string, readonly SessionRow[]>,
): InstanceNode[] {
  return instances.map((instance) => {
    const rows = sessionsByInstance.get(instance.id) ?? []
    const groups = new Map<string, SessionNode[]>()

    for (const row of rows) {
      const path = row.cwd !== undefined && row.cwd.length > 0 ? row.cwd : NO_WORKSPACE
      const node: SessionNode = {
        ...row,
        instanceId: instance.id,
        key: qualify(instance.id, row.sessionId),
      }
      const bucket = groups.get(path)
      if (bucket === undefined) groups.set(path, [node])
      else bucket.push(node)
    }

    const workspaces: WorkspaceNode[] = [...groups.entries()]
      // 占位工作区（实例没有报告 cwd）排在最后
      .sort(([a], [b]) => (a === NO_WORKSPACE ? 1 : b === NO_WORKSPACE ? -1 : a.localeCompare(b)))
      .map(([path, sessions]) => {
        const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
        return {
          key: qualify(instance.id, path),
          path,
          sessions: sorted,
          runningCount: sorted.filter(session => session.running).length,
          latestUpdatedAt: sorted[0]?.updatedAt ?? 0,
        }
      })

    return {
      instanceId: instance.id,
      label: `${instance.name}(${instance.id})`,
      workspaces,
      runningCount: rows.filter(row => row.running).length,
      sessionCount: rows.length,
    }
  })
}
