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
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { resolveInstances, type Config as RawConfig, type ResolvedInstance } from './config.ts'
import { buildTree, qualify, split } from './tree.ts'
import type {
  InstanceInfo, InstanceNode, RouteRequest, RouteValue, SessionChange, SessionRow, UpstreamState,
} from './types.ts'
import { Upstream, type UpstreamTransport } from './upstream.ts'

export type { InstanceConfig, ResolvedInstance, Config as ControlPlaneConfig } from './config.ts'
export type {
  InstanceInfo, InstanceNode, RouteRequest, RouteValue, SessionChange, SessionNode, SessionRow, UpstreamState, WorkspaceNode,
} from './types.ts'
export { Upstream } from './upstream.ts'
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
export class ControlPlane extends TypertRemoteService {
  /** Instances in configuration order. */
  readonly instances: readonly ResolvedInstance[]

  /** Per-instance reachability reported alongside the tree. */
  private readonly upstreams = new Map<string, Upstream>()

  /** Failures recorded by the last connect pass, keyed by instance id. */
  private readonly connectErrors = new Map<string, string>()

  /** Session running state per instance, fed by forwarded events. */
  private readonly running = new Map<string, Map<string, boolean>>()

  /** Listeners for qualified status changes, consumed by the Remote stream. */
  private readonly statusListeners = new Set<(key: string, running: boolean) => void>()

  /** Listeners for session add/update/remove, consumed by the Remote stream. */
  private readonly changeListeners = new Set<(key: string, kind: SessionChange) => void>()

  /** Last composed view per instance, used to diff refresh passes. */
  private readonly previous = new Map<string, Map<string, { updatedAt: number; running: boolean }>>()

  /** Polling timer; undefined when refresh is driven manually. */
  private timer: ReturnType<typeof setInterval> | undefined

  /**
   * @param _ctx - owning plugin context (unused until outbound connections land).
   * @param config - validated plugin configuration.
   */
  static readonly inject = ['typert']

  constructor(ctx: Context, config: RawConfig) {
    super(ctx, 'controlPlane', { namespace: 'controlPlane' })
    this.instances = resolveInstances(config)
  }

  /**
   * Instance roster with reachability, for the sidebar group headers.
   * @returns configured instances in sidebar order.
   */
  @Remote('instances')
  instanceList(): InstanceInfo[] {
    const states = this.states()
    return this.instances.map((instance) => {
      const current = states[instance.id]
      return {
        id: instance.id,
        name: instance.name,
        label: `${instance.name}(${instance.id})`,
        state: current?.state ?? 'unreachable',
        ...(current?.error === undefined ? {} : { error: current.error }),
      }
    })
  }

  /**
   * Current instance → workspace → session tree.
   * @returns the composed tree; unreachable instances contribute empty groups.
   */
  @Remote('tree')
  async treeSnapshot(): Promise<InstanceNode[]> {
    return await this.snapshot()
  }

  /**
   * Resolve a federated session key to its owning instance.
   * @param request - the qualified key.
   * @returns instance id and instance-local session id.
   */
  @Remote('route')
  routeKey(request: RouteRequest): RouteValue {
    const { instance, sessionId } = this.route(request.key)
    return { instanceId: instance.id, sessionId }
  }

  /**
   * Open one connection per configured instance. Failures are recorded per
   * instance and never reject the pass: one unreachable agent must not hide
   * the others.
   * @returns the instance ids that connected.
   */
  async connect(transportFor?: (instance: ResolvedInstance) => UpstreamTransport): Promise<string[]> {
    const connected: string[] = []
    await Promise.all(this.instances.map(async (instance) => {
      try {
        const upstream = await Upstream.connect(instance, transportFor?.(instance))
        this.upstreams.set(instance.id, upstream)
        upstream.onSessionStatus((sessionId, running) => { this.publishStatus(instance.id, sessionId, running) })
        // A mounted connection is not a reachable one: probe once so the
        // sidebar can mark an instance unreachable before its first refresh.
        await upstream.listSessions()
        this.connectErrors.delete(instance.id)
        connected.push(instance.id)
      } catch (error) {
        this.connectErrors.set(instance.id, error instanceof Error ? error.message : String(error))
      }
    }))
    return connected
  }

  /**
   * Subscribe to session add/update/remove changes.
   * @param listener - receives `<instanceId>:<sessionId>` and the change kind.
   * @returns disposer.
   */
  onSessionChange(listener: (key: string, kind: SessionChange) => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }

  /**
   * Start periodic refreshes; each pass diffs against the previous one and
   * emits changes. Polling stands in for the forwarded-event stream until the
   * Node carrier supports it (see README known limitations).
   * @param intervalMs - refresh interval in milliseconds.
   * @returns disposer.
   */
  startPolling(intervalMs: number = 2000): () => void {
    this.stopPolling()
    this.timer = setInterval(() => { void this.snapshot() }, intervalMs)
    return () => { this.stopPolling() }
  }

  /** Stop periodic refreshes. */
  stopPolling(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * Subscribe to qualified running-state changes.
   * @param listener - receives `<instanceId>:<sessionId>` and its state.
   * @returns disposer.
   */
  onSessionStatus(listener: (key: string, running: boolean) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  /** Remember one instance's status change and forward it qualified. */
  private publishStatus(instanceId: string, sessionId: string, running: boolean): void {
    let bySession = this.running.get(instanceId)
    if (bySession === undefined) {
      bySession = new Map()
      this.running.set(instanceId, bySession)
    }
    bySession.set(sessionId, running)
    const key = qualify(instanceId, sessionId)
    for (const listener of [...this.statusListeners]) {
      try {
        listener(key, running)
      } catch (error) {
        console.error('[control-plane] 状态监听器抛错:', error)
      }
    }
  }

  /**
   * Reachability per instance, for the sidebar group headers.
   * @returns state plus the last error when unreachable.
   */
  states(): Record<string, { state: UpstreamState; error?: string }> {
    const result: Record<string, { state: UpstreamState; error?: string }> = {}
    for (const instance of this.instances) {
      const upstream = this.upstreams.get(instance.id)
      const error = upstream?.error ?? this.connectErrors.get(instance.id)
      result[instance.id] = {
        state: upstream?.reachability ?? 'unreachable',
        ...(error === undefined ? {} : { error }),
      }
    }
    return result
  }

  /**
   * Read every instance and compose the sidebar tree. An instance that fails
   * here contributes no sessions and flips to `unreachable` on its own.
   * @returns the instance → workspace → session tree.
   */
  async snapshot(): Promise<InstanceNode[]> {
    const rows = new Map<string, readonly SessionRow[]>()
    await Promise.all(this.instances.map(async (instance) => {
      const upstream = this.upstreams.get(instance.id)
      if (upstream === undefined) return
      try {
        const listed = await upstream.listSessions()
        this.diff(instance.id, listed)
        // 事件可能比列表更新：用事件里已知的状态覆盖列表里的旧值
        const live = this.running.get(instance.id)
        rows.set(instance.id, live === undefined
          ? listed
          : listed.map(row => live.has(row.sessionId) ? { ...row, running: live.get(row.sessionId) === true } : row))
      } catch {
        rows.set(instance.id, [])
      }
    }))
    return buildTree(this.instances, rows)
  }

  /** Compare one instance's fresh list with the previous pass and emit changes. */
  private diff(instanceId: string, rows: readonly SessionRow[]): void {
    const next = new Map<string, { updatedAt: number; running: boolean }>()
    for (const row of rows) next.set(row.sessionId, { updatedAt: row.updatedAt, running: row.running })
    const before = this.previous.get(instanceId)

    if (before !== undefined) {
      for (const [sessionId, value] of next) {
        const old = before.get(sessionId)
        if (old === undefined) this.emitChange(instanceId, sessionId, 'added')
        else if (old.running !== value.running) this.publishStatus(instanceId, sessionId, value.running)
        else if (old.updatedAt !== value.updatedAt) this.emitChange(instanceId, sessionId, 'updated')
      }
      for (const sessionId of before.keys()) {
        if (!next.has(sessionId)) this.emitChange(instanceId, sessionId, 'removed')
      }
    }
    this.previous.set(instanceId, next)
  }

  /** Publish one session change, qualified. */
  private emitChange(instanceId: string, sessionId: string, kind: SessionChange): void {
    const key = qualify(instanceId, sessionId)
    for (const listener of [...this.changeListeners]) {
      try {
        listener(key, kind)
      } catch (error) {
        console.error('[control-plane] 变更监听器抛错:', error)
      }
    }
  }

  /**
   * Create a session on one instance (verification helper).
   * @param instanceId - configured instance id.
   * @param cwd - working directory the new session owns.
   * @returns the qualified session key.
   */
  async createSession(instanceId: string, cwd: string): Promise<string> {
    const upstream = this.upstreams.get(instanceId)
    if (upstream === undefined) throw new Error(`control-plane: 实例 ${instanceId} 未连接`)
    return qualify(instanceId, await upstream.createSession(cwd))
  }

  /** Close every outbound connection. */
  async dispose(): Promise<void> {
    this.stopPolling()
    await Promise.all([...this.upstreams.values()].map(upstream => upstream.dispose()))
    this.upstreams.clear()
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
