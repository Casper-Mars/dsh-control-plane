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
import type { FederationForwarder, FederationRouter, FederationTarget } from '@deepseek-ai/dsh-api-gateway'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { resolveInstances, type Config as RawConfig, type ResolvedInstance } from './config.ts'
import { InstanceConnections, type InstanceConnection } from './connections.ts'
import { instanceUnreachable } from './errors.ts'
import { ControlPlaneEventHub, diffInstanceStates } from './events.ts'
import { buildTree, qualify, split } from './tree.ts'
import type {
  ControlPlaneEvent, InstanceInfo, InstanceNode, InstanceStateReport, ReconnectRequest,
  ReconnectValue, RouteRequest, RouteValue, SessionChange, SessionRow,
} from './types.ts'
import { Upstream, type UpstreamTransport } from './upstream.ts'

export type { InstanceConfig, ResolvedInstance, Config as ControlPlaneConfig } from './config.ts'
export type {
  ControlPlaneEvent, InstanceInfo, InstanceNode, InstanceStateFrame, InstanceStateReport, ReconnectRequest,
  ReconnectValue, RouteRequest, RouteValue, SessionChange, SessionNode, SessionRow, UpstreamState,
  WorkspaceNode,
} from './types.ts'
export { ControlPlaneEventHub, DEFAULT_QUEUE_LIMIT, diffInstanceStates } from './events.ts'
export type { SubscriptionDiagnostic } from './events.ts'
export { InstanceConnections, DEFAULT_RETRY_INTERVAL_MS } from './connections.ts'
export type { InstanceConnectionsOptions, OpenUpstream } from './connections.ts'
export { Upstream } from './upstream.ts'
/** The failure code a federated call gets when its instance cannot be reached. */
export { instanceUnreachable } from './errors.ts'
export { RemoteRelay } from './relay.ts'
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
  federation: z.object({
    enabled: z.boolean().default(true),
  }),
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

  /** Whether prefixed calls may cross instance boundaries; false is local-only. */
  private readonly federationEnabled: boolean

  /** Outbound transport, installed once federation can reach other instances. */
  private federationForwarder: FederationForwarder | undefined

  /** Disposer of the router currently registered on the Gateway. */
  private disposeFederationRouter: (() => void) | undefined

  /** Session running state per instance, fed by forwarded events. */
  private readonly running = new Map<string, Map<string, boolean>>()

  /** Listeners for qualified status changes, consumed by the Remote stream. */
  private readonly statusListeners = new Set<(key: string, running: boolean) => void>()

  /** Listeners for session add/update/remove, consumed by the Remote stream. */
  private readonly changeListeners = new Set<(key: string, kind: SessionChange) => void>()

  /** Last composed view per instance, used to diff refresh passes. */
  private readonly previous = new Map<string, Map<string, { updatedAt: number; running: boolean }>>()

  /** Push fan-out for the `events` stream: status, change, states, and tree frames. */
  private readonly eventHub = new ControlPlaneEventHub()

  /**
   * Reachability last announced to subscribers. Every `states` frame diffs
   * against it, so an instance that did not move is never announced twice and a
   * background retry can publish the outcome without a snapshot read.
   */
  private announced: Record<string, InstanceStateReport>

  /** Registry listeners are attached to, so a swapped registry re-attaches. */
  private stateListenerSource: InstanceConnections | undefined

  /** Disposer of the reachability listener installed on {@link stateListenerSource}. */
  private stateListenerDispose: (() => void) | undefined

  /** In-flight state pass, shared by every change that arrived while it ran. */
  private statePassRunning: Promise<void> | undefined

  /** Set when a change arrived during a running state pass; the pass repeats. */
  private statePassQueued = false

  /** Depth of the initial-tree composition, whose states land in the tree itself. */
  private composingInitial = 0

  /** Set by {@link dispose}: a disposed plane never starts a loop or a listener again. */
  private disposed = false

  /** Live `events` streams; the refresh loop runs while at least one exists. */
  private eventStreams = 0

  /** Whether the refresh loop exists because of the `events` stream (not a Host call). */
  private ownsRefreshLoop = false

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
    this.federationEnabled = config.federation?.enabled !== false
    this.connections = new InstanceConnections(this.instances, {
      open: async (instance, transport) => await Upstream.connect(instance, transport),
      attach: (instance, upstream) => {
        upstream.onSessionStatus((sessionId, running) => { this.publishStatus(instance.id, sessionId, running) })
      },
    })
    this.announced = this.connections.states()
    // Federation transport: this control plane *is* the forwarder, so the
    // router exists from the first tick. Registration itself still waits for a
    // Gateway, and {@link attachFederationRouter} is retried below when the
    // Gateway service arrives after this plugin.
    this.installFederationForwarder({
      unary: async (target, signal) => await this.forwardUnary(target, signal),
      stream: (target, signal) => this.forwardStream(target, signal),
    })
    // A control-plane Host may list this plugin before the Gateway; the router
    // then attaches on the service's arrival instead of staying silent.
    // Structural test contexts supply no `inject`; a real Cordis Context does.
    const inject = (ctx as unknown as { inject?: Context['inject'] }).inject
    if (typeof inject === 'function') {
      inject.call(ctx, ['typertGateway'], () => {
        this.attachFederationRouter()
        return () => { this.detachFederationRouter() }
      })
    }
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
   * Follow the sidebar's live frames.
   *
   * The first frame is a complete tree, so a subscriber that connected after
   * the last published change still starts from the truth. After that the
   * stream carries session running state, add/update/remove changes, and
   * reachability changes, plus a fresh tree whenever reachability moved (a
   * recovered instance has to bring its rows back).
   *
   * The stream starts the 2s refresh loop while it has subscribers — that loop
   * is what turns `listSessions` diffs into `change` frames — and stops it when
   * the last subscriber leaves, unless a Host already runs one.
   * @param signal - subscription cancellation owned by the Remote carrier.
   * @returns the initial tree followed by published frames.
   */
  @Remote({ name: 'events', mode: 'stream' })
  events(signal: AbortSignal): AsyncIterable<ControlPlaneEvent> {
    // Reachability changes that happen outside a snapshot pass (a background
    // `recover()` settling, an explicit reconnect) must reach the sidebar as
    // they happen, not on the next 30s poll, so the registry is followed from
    // the moment a stream exists. A disposed plane keeps no listener: its
    // stream ends immediately (the hub is closed) and a late subscriber must
    // not resurrect a background loop.
    if (!this.disposed) this.attachStateListener()
    return this.watchEvents(signal)
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
    const value = await this.connections.reconnect(request.instanceId)
    await this.publishReachability()
    return value
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
    const ids = await this.connections.connect(transportFor)
    await this.publishReachability()
    return ids
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
    this.ownsRefreshLoop = false
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
    // The same state may arrive twice (an upstream event and a list diff); the
    // second one is not a change and must not wake every browser.
    if (bySession.get(sessionId) === running) return
    bySession.set(sessionId, running)
    const key = qualify(instanceId, sessionId)
    for (const listener of [...this.statusListeners]) {
      try {
        listener(key, running)
      } catch (error) {
        console.error('[control-plane] 状态监听器抛错:', error)
      }
    }
    this.eventHub.publishStatus(key, running)
  }

  /**
   * Reachability per instance, for the sidebar group headers.
   * @returns state plus the last error when unreachable.
   */
  states(): Record<string, InstanceStateReport> {
    return this.connections.states()
  }

  async snapshot(): Promise<InstanceNode[]> {
    const tree = await this.compose()
    this.publishStateChanges(tree)
    return tree
  }

  /**
   * Compose the tree that opens a `events` subscription.
   *
   * The frame itself carries every instance's reachability, so it *is* the new
   * baseline: states observed while it composed are not announced again on top
   * of a view that already shows them.
   * @returns the instance → workspace → session tree.
   */
  private async initialTree(): Promise<readonly InstanceNode[]> {
    this.composingInitial += 1
    try {
      const tree = await this.compose()
      this.announced = this.connections.states()
      return tree
    } finally {
      this.composingInitial -= 1
    }
  }

  /**
   * Compose the instance → workspace → session tree without publishing state
   * or change frames. Callers that watch reachability wrap this themselves.
   *
   * An instance that fails here keeps the reachability its upstream reported
   * (`unreachable` + error) and contributes **no row entry at all** — writing
   * an empty list would make it indistinguishable from a connected instance
   * with no sessions. Instances with no connection are retried in the
   * background, rate limited by {@link InstanceConnections.recover}.
   * @returns the instance → workspace → session tree.
   */
  private async compose(recover = true): Promise<InstanceNode[]> {
    if (recover) this.connections.recover()
    const rows = new Map<string, readonly SessionRow[]>()
    await Promise.all(this.instances.map(async (instance) => {
      const upstream = this.connections.get(instance.id)
      if (upstream === undefined) return
      try {
        const listed = await upstream.listSessions()
        // 事件可能比列表更新：先对齐事件已知状态，再 diff 与展示，否则一份滞后的
        // 列表会把刚推送的 running 又改回旧值。
        const effective = this.withLiveStatus(instance.id, listed)
        this.diff(instance.id, effective)
        rows.set(instance.id, effective)
      } catch {
        // 保留该实例的 state/error，不写空数组：离线与"在线但无会话"必须可分
      }
    }))
    return buildTree(this.instances, rows, this.states())
  }

  /**
   * Overlay the running state learned from events onto a fetched list. A
   * persistence read may lag the event stream; the event is the fresher fact.
   * @param instanceId - instance the rows belong to.
   * @param rows - rows as the instance listed them.
   * @returns the rows with every event-known session state applied.
   */
  private withLiveStatus(instanceId: string, rows: readonly SessionRow[]): readonly SessionRow[] {
    const live = this.running.get(instanceId)
    if (live === undefined || live.size === 0) return rows
    return rows.map(row => live.has(row.sessionId) ? { ...row, running: live.get(row.sessionId) === true } : row)
  }

  /**
   * Publish the reachability changes a composed pass observed, preceded by a
   * fresh tree: a recovered instance has to bring its rows back with it, and a
   * newly unreachable one must stop showing clickable rows.
   * @param tree - tree the pass composed, already carrying the new states.
   */
  private publishStateChanges(tree: readonly InstanceNode[]): void {
    if (this.eventHub.subscriberCount === 0) return
    const after = this.connections.states()
    const changed = diffInstanceStates(this.announced, after, this.instanceIds())
    if (changed.length === 0) return
    this.announced = after
    this.eventHub.publishStates(changed)
    this.eventHub.publishTree(tree)
  }

  /**
   * Announce whatever an explicit connect/retry changed, recomposing first so
   * the tree frame carries the rows of every instance whose state moved.
   * @returns resolves once the pass that observed the attempt finished.
   */
  private async publishReachability(): Promise<void> {
    if (this.eventHub.subscriberCount === 0) return
    await this.requestStatePass()
  }

  /**
   * Ask for one state pass. A change that arrives while a pass runs marks
   * another round instead of starting a competing compose, so two passes never
   * interleave their `previous` bookkeeping.
   * @returns resolves when the drain settled.
   */
  private requestStatePass(): Promise<void> {
    this.statePassQueued = true
    this.statePassRunning ??= this.drainStatePasses()
    return this.statePassRunning
  }

  /** Run queued state passes until no change arrived during the last one. */
  private async drainStatePasses(): Promise<void> {
    try {
      while (this.statePassQueued) {
        this.statePassQueued = false
        const tree = await this.compose(false)
        this.publishStateChanges(tree)
      }
    } finally {
      this.statePassRunning = undefined
    }
  }

  /**
   * Follow the connection registry so a settled background attempt becomes a
   * frame immediately. Skipped while the opening tree composes: that frame
   * carries the same states, and {@link initialTree} makes it the baseline.
   */
  private notifyInstanceState(): void {
    if (this.composingInitial > 0) return
    if (this.eventHub.subscriberCount === 0) return
    void this.requestStatePass().catch((error: unknown) => {
      console.error('[control-plane] 可达性刷新失败:', error)
    })
  }

  /** Listen to the current registry, replacing a listener left on an older one. */
  private attachStateListener(): void {
    if (this.stateListenerSource === this.connections) return
    this.detachStateListener()
    this.stateListenerSource = this.connections
    this.stateListenerDispose = this.connections.onStateChange(() => { this.notifyInstanceState() })
  }

  /** Remove the registry listener, if one is installed. */
  private detachStateListener(): void {
    this.stateListenerDispose?.()
    this.stateListenerDispose = undefined
    this.stateListenerSource = undefined
  }

  /** Configured instance ids, in configuration order. */
  private instanceIds(): readonly string[] {
    return this.instances.map(instance => instance.id)
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
    this.eventHub.publishChange(key, kind)
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

  /**
   * Forward one unary call to the instance that owns it.
   *
   * An instance without a live connection is refused here, before any carrier
   * work: a federated call must fail fast instead of opening a connection the
   * retry policy did not schedule.
   * @param target - owning instance, endpoint, and prefix-free arguments.
   * @param signal - cancellation of the inbound call.
   * @returns the upstream business value.
   * @throws RemoteError `control-plane/instance-unreachable` when the instance
   *   is not connected, otherwise whatever the upstream answered.
   */
  private async forwardUnary(target: FederationTarget, signal: AbortSignal): Promise<unknown> {
    const forward = this.relayFor(target)
    if (forward.forwardUnary === undefined) throw instanceUnreachable(target.instanceId, target.endpoint)
    return await forward.forwardUnary(target.endpoint, target.args, signal)
  }

  /**
   * Forward one stream call to the instance that owns it.
   * @param target - owning instance, endpoint, and prefix-free arguments.
   * @param signal - cancellation of the inbound logical stream.
   * @returns the upstream items.
   * @throws RemoteError `control-plane/instance-unreachable` when the instance
   *   is not connected.
   */
  private forwardStream(target: FederationTarget, signal: AbortSignal): AsyncIterable<unknown> {
    const forward = this.relayFor(target)
    if (forward.forwardStream === undefined) throw instanceUnreachable(target.instanceId, target.endpoint)
    return forward.forwardStream(target.endpoint, target.args, signal)
  }

  /**
   * The connection a federated call may use, or the failure that refuses it.
   * @param target - owning instance and endpoint.
   * @returns the connected upstream.
   * @throws RemoteError `control-plane/instance-unreachable` when no connected
   *   upstream exists for the instance.
   */
  private relayFor(target: FederationTarget): InstanceConnection {
    const upstream = this.connections.get(target.instanceId)
    if (upstream === undefined || upstream.reachability !== 'connected') {
      throw instanceUnreachable(target.instanceId, target.endpoint)
    }
    return upstream
  }

  /**
   * Install the transport federated calls travel on.
   *
   * The control plane installs its own relay at construction, so federation is
   * available from the first tick; this stays public so a Host can substitute
   * a transport and so a disposer can take one back. Registration itself still
   * needs all three of the rollout switch, this transport, and a Gateway, which
   * {@link attachFederationRouter} re-checks whenever one of them appears.
   * @param forwarder - unary and stream transport to other instances.
   * @returns disposer that detaches the router and forgets the forwarder.
   * @throws if a forwarder is already installed.
   */
  installFederationForwarder(forwarder: FederationForwarder): () => void {
    if (this.federationForwarder !== undefined) {
      throw new Error('control-plane: federation forwarder is already installed')
    }
    this.federationForwarder = forwarder
    this.attachFederationRouter()
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.federationForwarder !== forwarder) return
      this.federationForwarder = undefined
      this.detachFederationRouter()
    }
  }

  /** Register the router once the switch, the Gateway, and a forwarder all exist. */
  private attachFederationRouter(): void {
    if (!this.federationEnabled) return
    const forwarder = this.federationForwarder
    if (forwarder === undefined) return
    if (this.disposeFederationRouter !== undefined) return
    const gateway = this.ctx.get('typertGateway')
    if (gateway === undefined) return
    const router: FederationRouter = {
      hasInstance: instanceId => this.instances.some(instance => instance.id === instanceId),
      forwarder,
    }
    this.disposeFederationRouter = gateway.registerFederationRouter(router)
  }

  /** Remove the router, restoring the Gateway's local-only path. */
  private detachFederationRouter(): void {
    const dispose = this.disposeFederationRouter
    this.disposeFederationRouter = undefined
    dispose?.()
  }

  /** Close every outbound connection and detach the federation router. */
  async dispose(): Promise<void> {
    this.disposed = true
    // Subscribers first: a stream must not observe a half-closed connection set.
    this.detachStateListener()
    this.eventHub.close()
    this.eventStreams = 0
    this.stopPolling()
    // Order matters: no inbound call may observe a half-closed set of
    // connections, so the router goes first and the sockets after it.
    this.federationForwarder = undefined
    this.detachFederationRouter()
    await this.connections.dispose()
  }

  /**
   * Drive one `events` subscription and keep the refresh loop alive for it.
   * @param signal - subscription cancellation.
   * @returns the initial tree followed by published frames.
   */
  private async *watchEvents(signal: AbortSignal): AsyncIterable<ControlPlaneEvent> {
    if (this.disposed) return
    this.retainRefreshLoop()
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.releaseRefreshLoop()
    }
    // The refresh loop belongs to the subscription, not to this generator's
    // finalizer: an abort can arrive while the opening tree is still composing,
    // and the 2s poll (whose retries touch every instance) has to stop then,
    // not whenever the consumer next pulls.
    signal.addEventListener('abort', release, { once: true })
    try {
      yield* this.eventHub.subscribe(async () => await this.initialTree(), signal)
    } finally {
      signal.removeEventListener('abort', release)
      release()
    }
  }

  /**
   * Start the 2s refresh loop if nothing else already runs it. Diffs from that
   * loop are what turn list changes into `change` frames between client polls.
   */
  private retainRefreshLoop(): void {
    this.eventStreams += 1
    if (this.timer !== undefined) return
    this.startPolling()
    this.ownsRefreshLoop = true
  }

  /** Stop the refresh loop once the last `events` subscriber left, if we own it. */
  private releaseRefreshLoop(): void {
    this.eventStreams = Math.max(0, this.eventStreams - 1)
    if (this.eventStreams > 0 || !this.ownsRefreshLoop) return
    this.stopPolling()
    this.ownsRefreshLoop = false
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
