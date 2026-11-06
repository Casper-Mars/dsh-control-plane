/**
 * Control-plane plugin: one Web UI over several Harness instances.
 *
 * Milestone 2 (this package) owns the data model and the routing identity:
 * configuration validation ({@link resolveInstances}) and the sidebar tree
 * ({@link buildTree}) with instance-qualified keys. The outbound connection
 * layer (one client connection per instance) and the Remote namespace that
 * feeds the browser land next; this module deliberately keeps no per-instance
 * runtime state yet.
 *
 * @module @deepseek-ai/dsh-control-plane
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveInstances, type Config as RawConfig, type ResolvedInstance } from './config.ts'
import { buildTree, split, type InstanceNode, type SessionRow } from './tree.ts'

export type { InstanceConfig, ResolvedInstance, Config as ControlPlaneConfig } from './config.ts'
export type { InstanceNode, SessionNode, SessionRow, WorkspaceNode } from './tree.ts'
export { buildTree, qualify, split, NO_WORKSPACE } from './tree.ts'
export { resolveInstances } from './config.ts'

/** Plugin configuration schema, matching {@link RawConfig}. */
export const Config: z<RawConfig> = z.object({
  instances: z.array(z.object({
    id: z.string().required(),
    name: z.string(),
    host: z.string().required(),
    port: z.natural().required(),
  })).required(),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Control-plane instance registry and tree composer. */
    controlPlane: ControlPlane
  }
}

/**
 * Instance registry the browser-side tree is composed from.
 *
 * A live instance list is configuration-derived today; when the outbound
 * connection layer arrives it will add per-instance reachability here without
 * changing the shape the sidebar consumes.
 */
export class ControlPlane {
  /** Instances in configuration order. */
  readonly instances: readonly ResolvedInstance[]

  /**
   * @param _ctx - owning plugin context (unused until outbound connections land).
   * @param config - validated plugin configuration.
   */
  constructor(_ctx: Context, config: RawConfig) {
    this.instances = resolveInstances(config)
  }

  /**
   * Compose the sidebar tree from already-collected session rows.
   * @param sessionsByInstance - rows keyed by instance id; unknown ids are ignored.
   * @returns the instance → workspace → session tree.
   */
  tree(sessionsByInstance: ReadonlyMap<string, readonly SessionRow[]>): InstanceNode[] {
    return buildTree(this.instances, sessionsByInstance)
  }

  /**
   * Route a federated session key back to its instance.
   * @param key - `<instanceId>:<sessionId>`.
   * @returns the owning instance and the instance-local session id.
   * @throws if the key is malformed or names an unconfigured instance.
   */
  route(key: string): { instance: ResolvedInstance; sessionId: string } {
    const { instanceId, value } = split(key)
    const instance = this.instances.find(candidate => candidate.id === instanceId)
    if (instance === undefined) throw new Error(`control-plane: 未知实例 ${JSON.stringify(instanceId)}`)
    return { instance, sessionId: value }
  }
}

export default ControlPlane
