/**
 * Outbound connections and their reachability, one per configured instance.
 *
 * The registry owns three things a plain `Map<id, Upstream>` did not:
 *
 * 1. **Retry.** A failed connect pass used to be final until the control plane
 *    restarted. {@link InstanceConnections.reconnect} opens a fresh connection
 *    on demand (the sidebar's "retry"), and {@link InstanceConnections.recover}
 *    retries instances that never got a connection at all — rate limited, so the
 *    6s tree poll cannot turn into a connection storm.
 * 2. **Concurrency.** Reconnects are keyed per instance: two triggers in the
 *    same tick await the same attempt instead of racing two connections.
 * 3. **A failure value, not a throw.** A retry that fails resolves with
 *    `{ state: 'unreachable', error }`, because the sidebar has to render the
 *    reason on the group the user just retried.
 *
 * Upstream construction is injected ({@link InstanceConnectionsOptions.open})
 * so this module holds no protocol knowledge and tests need no network.
 * @module @deepseek-ai/dsh-control-plane/src/connections
 */

import type { ResolvedInstance } from './config.ts'
import type { InstanceStateReport, ReconnectValue, SessionRow, UpstreamState } from './types.ts'
import type { UpstreamTransport } from './upstream.ts'

/**
 * The slice of an `Upstream` this registry owns and hands back.
 *
 * Structural on purpose: `Upstream` satisfies it as-is, and tests can supply a
 * plain object instead of building a real Cordis connection. `createSession`
 * rides along because the registry is the only handle the plugin keeps on a
 * live instance.
 */
export interface InstanceConnection {
  /** Current reachability, updated by every read. */
  readonly reachability: UpstreamState
  /** Last failure when unreachable. */
  readonly error: string | undefined
  /** Reads the instance's visible sessions. */
  listSessions: (signal?: AbortSignal) => Promise<SessionRow[]>
  /** Creates one session in `cwd`. */
  createSession: (cwd: string) => Promise<string>
  /** Subscribes to session running-state changes. */
  onSessionStatus: (listener: (sessionId: string, running: boolean) => void) => () => void
  /** Closes the connection. */
  dispose: () => Promise<void>
}

/** Opens one connection; the injectable seam over `Upstream.connect`. */
export type OpenUpstream = (instance: ResolvedInstance, transport: UpstreamTransport) => Promise<InstanceConnection>

/** Wiring {@link InstanceConnections} needs. */
export interface InstanceConnectionsOptions {
  /** Opens one outbound connection. Required: this module never touches a socket itself. */
  readonly open: OpenUpstream
  /** Called with every successful connection, before its first probe. */
  readonly attach?: ((instance: ResolvedInstance, upstream: InstanceConnection) => void) | undefined
  /** Minimum gap between automatic retries of one instance, in milliseconds. */
  readonly retryIntervalMs?: number | undefined
  /** Clock seam, so the retry throttle is testable without fake timers. */
  readonly now?: (() => number) | undefined
}

/** Default minimum gap between automatic retries of one instance. */
export const DEFAULT_RETRY_INTERVAL_MS = 5000

/**
 * Per-instance connections, their failures, and the retry policy.
 *
 * A connection that mounted but failed its probe stays in the registry: it is
 * unreachable with an error, and the next `listSessions()` can bring it back
 * without a reconnect. Only an instance that never mounted is retried by
 * {@link recover}.
 */
export class InstanceConnections {
  private readonly instances: readonly ResolvedInstance[]
  private readonly open: OpenUpstream
  private readonly attach: ((instance: ResolvedInstance, upstream: InstanceConnection) => void) | undefined
  private readonly retryIntervalMs: number
  private readonly now: () => number

  /** Live connections, mounted or unreachable-after-probe. */
  private readonly upstreams = new Map<string, InstanceConnection>()

  /** Last connect failure per instance, cleared by a successful probe. */
  private readonly failures = new Map<string, string>()

  /** In-flight attempts per instance; concurrent callers share one. */
  private readonly attempts = new Map<string, Promise<ReconnectValue>>()

  /** Last attempt start per instance, used by the {@link recover} throttle. */
  private readonly lastAttemptAt = new Map<string, number>()

  /** Set by {@link dispose}; a connection finishing afterwards is closed at once. */
  private closed = false

  /**
   * @param instances - configured instances, in sidebar order.
   * @param options - connection factory, attach hook, and retry policy.
   */
  constructor(instances: readonly ResolvedInstance[], options: InstanceConnectionsOptions) {
    this.instances = instances
    this.open = options.open
    this.attach = options.attach
    this.retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Open every instance that has no connection yet.
   * @param transportFor - optional per-instance transport overrides (tests, auth).
   * @returns the ids that connected, in configuration order.
   */
  async connect(transportFor?: (instance: ResolvedInstance) => UpstreamTransport): Promise<string[]> {
    const results = await Promise.all(this.instances.map(async instance => ({
      instanceId: instance.id,
      value: await this.attempt(instance, transportFor?.(instance)),
    })))
    return results.filter(result => result.value.state === 'connected').map(result => result.instanceId)
  }

  /**
   * Reconnect one instance, disposing its previous connection first.
   * @param instanceId - configured instance id.
   * @returns the outcome; a failure is a value carrying the reason.
   * @throws if the id is not configured.
   */
  async reconnect(instanceId: string): Promise<ReconnectValue> {
    const instance = this.instances.find(candidate => candidate.id === instanceId)
    if (instance === undefined) throw new Error(`control-plane: 未知实例 ${JSON.stringify(instanceId)}`)
    return await this.attempt(instance)
  }

  /**
   * Retry instances that have no connection at all, at most once per
   * {@link InstanceConnectionsOptions.retryIntervalMs} each. Attempts run in the
   * background: a slow dead host must not hold up the tree frame.
   */
  recover(): void {
    if (this.closed) return
    const now = this.now()
    for (const instance of this.instances) {
      if (this.upstreams.has(instance.id)) continue
      if (this.attempts.has(instance.id)) continue
      const last = this.lastAttemptAt.get(instance.id)
      if (last !== undefined && now - last < this.retryIntervalMs) continue
      void this.attempt(instance)
    }
  }

  /**
   * The live connection for one instance.
   * @param instanceId - configured instance id.
   * @returns the connection, or undefined when it never mounted.
   */
  get(instanceId: string): InstanceConnection | undefined {
    return this.upstreams.get(instanceId)
  }

  /**
   * Reachability per instance.
   * @returns state plus the last error when unreachable; `connecting` while a
   *   retry is in flight, so the sidebar shows progress instead of a failure.
   */
  states(): Record<string, InstanceStateReport> {
    const result: Record<string, InstanceStateReport> = {}
    for (const instance of this.instances) {
      const upstream = this.upstreams.get(instance.id)
      const state: UpstreamState = upstream?.reachability
        ?? (this.attempts.has(instance.id) ? 'connecting' : 'unreachable')
      // A mounted connection owns its own error: the recorded map only holds
      // attempts that never mounted, so a probe that recovered on its own does
      // not keep showing a stale reason.
      const error = upstream === undefined ? this.failures.get(instance.id) : upstream.error
      result[instance.id] = {
        state,
        ...(error === undefined ? {} : { error }),
      }
    }
    return result
  }

  /** Close every connection; an attempt still in flight closes its own result. */
  async dispose(): Promise<void> {
    this.closed = true
    const mounted = [...this.upstreams.values()]
    this.upstreams.clear()
    this.failures.clear()
    await Promise.all(mounted.map(upstream => upstream.dispose()))
  }

  /**
   * Run one attempt, sharing an in-flight attempt with every other caller.
   * @param instance - instance to connect.
   * @param transport - transport overrides for this attempt.
   * @returns the outcome once the shared attempt settles.
   */
  private attempt(instance: ResolvedInstance, transport?: UpstreamTransport): Promise<ReconnectValue> {
    const running = this.attempts.get(instance.id)
    if (running !== undefined) return running
    this.lastAttemptAt.set(instance.id, this.now())
    const task = this.run(instance, transport)
    this.attempts.set(instance.id, task)
    const settle = (): void => {
      if (this.attempts.get(instance.id) === task) this.attempts.delete(instance.id)
    }
    // `run` never rejects; the catch keeps a future change from wedging the map.
    void task.then(settle, settle)
    return task
  }

  /**
   * Open, mount, probe, and record one connection.
   * @param instance - instance to connect.
   * @param transport - transport overrides merged over the forwarded-event defaults.
   * @returns `connected` after a successful probe, otherwise `unreachable` with the reason.
   */
  private async run(instance: ResolvedInstance, transport?: UpstreamTransport): Promise<ReconnectValue> {
    await this.drop(instance.id)
    this.failures.delete(instance.id)
    try {
      const upstream = await this.open(instance, { events: true, ...transport })
      if (this.closed) {
        await upstream.dispose()
        return { state: 'unreachable' }
      }
      this.upstreams.set(instance.id, upstream)
      this.attach?.(instance, upstream)
      // A mounted connection is not a reachable one: probe once so the frame
      // that follows a retry reports the real outcome. A failed probe keeps the
      // connection in the registry — its next read can still recover it.
      await upstream.listSessions()
      this.failures.delete(instance.id)
      return { state: 'connected' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[control-plane] 实例 ${instance.id} 连接失败: ${message}`)
      this.failures.set(instance.id, message)
      return { state: 'unreachable', error: message }
    }
  }

  /**
   * Dispose and forget one instance's previous connection.
   * @param instanceId - configured instance id.
   */
  private async drop(instanceId: string): Promise<void> {
    const previous = this.upstreams.get(instanceId)
    if (previous === undefined) return
    this.upstreams.delete(instanceId)
    await previous.dispose()
  }
}
