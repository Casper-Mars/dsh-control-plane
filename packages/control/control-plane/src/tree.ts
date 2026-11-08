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
import type {
  InstanceNode, InstanceStateReport, SessionNode, SessionRow, UpstreamState, WorkspaceNode,
} from './types.ts'

export type { InstanceNode, InstanceStateReport, SessionNode, SessionRow, WorkspaceNode } from './types.ts'

/** Separator between the instance id and the instance-local value. */
const SEPARATOR = ':'

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
 * @param sessionsByInstance - raw rows keyed by instance id. An unreachable
 *   instance has no entry: the caller must not fabricate an empty list, or the
 *   sidebar cannot tell "offline" from "connected with no sessions".
 * @param states - reachability per instance id; a missing entry means the
 *   caller composed rows for an instance whose reachability it did not track,
 *   which the tree reports as `connected`.
 * @returns instance nodes in configuration order, workspaces by path, sessions newest first.
 */
export function buildTree(
  instances: readonly ResolvedInstance[],
  sessionsByInstance: ReadonlyMap<string, readonly SessionRow[]>,
  states: Readonly<Record<string, InstanceStateReport>> = {},
): InstanceNode[] {
  return instances.map((instance) => {
    const all = sessionsByInstance.get(instance.id) ?? []
    // Archived Sessions leave the tree the moment the owner archives them, the
    // same rule the official Workspace browser applies. Their rows stay in the
    // owner's list (so an unarchive brings them back), but a sidebar that kept
    // them would contradict the menu it just ran.
    const rows = all.filter(row => row.archived !== true)
    const reported: InstanceStateReport | undefined = states[instance.id]
    const state: UpstreamState = reported?.state ?? 'connected'
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
        // Pinned Sessions float to the top of their workspace, the way the
        // official browser keeps them above the recency list. The owner's pin
        // set has no order of its own here, so recency breaks the tie.
        const sorted = [...sessions].sort((a, b) =>
          Number(b.pinned === true) - Number(a.pinned === true) || b.updatedAt - a.updatedAt)
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
      state,
      ...(reported?.error === undefined ? {} : { error: reported.error }),
      workspaces,
      runningCount: rows.filter(row => row.running).length,
      sessionCount: rows.length,
    }
  })
}
