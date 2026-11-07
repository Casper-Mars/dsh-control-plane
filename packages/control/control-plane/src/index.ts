/**
 * Control-plane plugin: one Web UI over several Harness instances.
 *
 * This package owns the data model and the routing identity: configuration
 * validation ({@link resolveInstances}), the sidebar tree ({@link buildTree}),
 * and the outbound connection registry ({@link InstanceConnections}) with its
 * per-instance reachability, retry, and rate limiting. The Remote namespace
 * below feeds all of that to the browser.
 *
 * @module @deepseek-ai/dsh-control-plane
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { resolveInstances, type Config as RawConfig, type ResolvedInstance } from './config.ts'
import { InstanceConnections } from './connections.ts'
import { buildTree, qualify, split } from './tree.ts'
import type {
  InstanceInfo, InstanceNode, InstanceStateReport, ReconnectRequest, ReconnectValue, RouteRequest, RouteValue,
  SessionChange, SessionRow,
} from './types.ts'
import { Upstream, type UpstreamTransport } from './upstream.ts'

export type { InstanceConfig, ResolvedInstance, Config as ControlPlaneConfig } from './config.ts'
export type {
  InstanceInfo, InstanceNode, InstanceStateReport, ReconnectRequest, ReconnectValue, RouteRequest, RouteValue,
  SessionChange, SessionNode, SessionRow, UpstreamState, WorkspaceNode,
} from './types.ts'
export { InstanceConnections, DEFAULT_RETRY_INTERVAL_MS } from './connections.ts'
export type { InstanceConnectionsOptions, OpenUpstream } from './connections.ts'
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
    token: z.string(),
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
 * Connections live in {@link InstanceConnections}; this class adds the
 * session-status/change fan-out and the polling loop the sidebar consumes.
 */
export class ControlPlane extends TypertRemoteService {
  /** Instances in configuration order. */
  readonly instances: readonly ResolvedInstance[]

  /** Outbound connections, reachability, and the retry policy. */
  private readonly connections: InstanceConnections

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
    this.connections = new InstanceConnections(this.instances, {
      open: async (instance, transport) => await Upstream.connect(instance, transport),
      attach: (instance, upstream) => {
        upstream.onSessionStatus((sessionId, running) => { this.publishStatus(instance.id, sessionId, running) })
      },
    })
    console.log('[control-plane] 插件已激活，实例数:', this.instances.length)
    // 调试：确认描述符是否已被 typert-loader 注册
    const typert = ctx.get('typert') as { listPackages?: () => Array<{ package: string; face: string }> } | undefined
    const mine = typert?.listPackages?.().filter(entry => entry.package === '@deepseek-ai/dsh-control-plane') ?? []
    console.log(`[control-plane] typert 描述符: ${JSON.stringify(mine)}`)
    // 插件激活即开始连接各实例；卸载时关闭全部出站连接
    ctx.effect(() => {
      void this.connect()
      return async () => { await this.dispose() }
    }, 'control-plane.instances')
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
   * @returns the composed tree; an unreachable instance appears with its state,
   *   its last error, and no sessions.
   */
  @Remote('tree')
  async treeSnapshot(): Promise<InstanceNode[]> {
    return await this.snapshot()
  }

  /**
   * Retry one instance without restarting the control plane.
   *
   * A failed retry resolves with `{ state: 'unreachable', error }` instead of
   * rejecting, so the sidebar can render the reason on that group. Concurrent
   * retries of the same instance share one attempt.
   * @param request - the instance to reconnect.
   * @returns the outcome of the attempt.
   * @throws if the id is not configured.
   */
  @Remote('reconnect')
  async reconnect(request: ReconnectRequest): Promise<ReconnectValue> {
    return await this.connections.reconnect(request.instanceId)
  }

  /**
   * Resolve a federated session key to its owning instance.
   * @param request - the qualified key.
   * @returns instance id and instance-local session id.
   */
  @Remote('route')
  routeKey(request: RouteRequest): RouteValue {
    const { instance, sessionId } = this.resolveKey(request.key)
    return { instanceId: instance.id, sessionId }
  }

  /**
   * Open one connection per configured instance. Failures are recorded per
   * instance and never reject the pass: one unreachable agent must not hide
   * the others.
   * @param transportFor - optional per-instance transport overrides.
   * @returns the instance ids that connected, in configuration order.
   */
  async connect(transportFor?: (instance: ResolvedInstance) => UpstreamTransport): Promise<string[]> {
    return await this.connections.connect(transportFor)
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
  states(): Record<string, InstanceStateReport> {
    return this.connections.states()
  }

  /**
   * Read every instance and compose the sidebar tree.
   *
   * An instance that fails here keeps the reachability its upstream reported
   * (`unreachable` + error) and contributes **no row entry at all** — writing
   * an empty list would make it indistinguishable from a connected instance
   * with no sessions. Instances with no connection are retried in the
   * background, rate limited by {@link InstanceConnections.recover}.
   * @returns the instance → workspace → session tree.
   */
  async snapshot(): Promise<InstanceNode[]> {
    this.connections.recover()
    const rows = new Map<string, readonly SessionRow[]>()
    await Promise.all(this.instances.map(async (instance) => {
      const upstream = this.connections.get(instance.id)
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
        // 保留该实例的 state/error，不写空数组：离线与"在线但无会话"必须可分
      }
    }))
    return buildTree(this.instances, rows, this.states())
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
    const upstream = this.connections.get(instanceId)
    if (upstream === undefined) throw new Error(`control-plane: 实例 ${instanceId} 未连接`)
    return qualify(instanceId, await upstream.createSession(cwd))
  }

  /** Close every outbound connection. */
  async dispose(): Promise<void> {
    this.stopPolling()
    await this.connections.dispose()
  }

  /**
   * Route a federated session key back to its instance.
   * @param key - `<instanceId>:<sessionId>`.
   * @returns the owning instance and the instance-local session id.
   * @throws if the key is malformed or names an unconfigured instance.
   */
  private resolveKey(key: string): { instance: ResolvedInstance; sessionId: string } {
    const { instanceId, value } = split(key)
    const instance = this.instances.find(candidate => candidate.id === instanceId)
    if (instance === undefined) throw new Error(`control-plane: 未知实例 ${JSON.stringify(instanceId)}`)
    return { instance, sessionId: value }
  }
}

export default ControlPlane
