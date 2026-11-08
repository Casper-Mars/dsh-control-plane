/**
 * Outbound connection to one Harness instance.
 *
 * Each instance gets its own Cordis root: the control plane's own host-side
 * services stay untouched, and one instance going away cannot dispose another.
 * The connection is the same client carrier a browser page uses, built for
 * Node (see `socket`/`rpc` seams below). The `session` namespace is mounted at
 * connect; `workspace` is mounted on the first federated call that needs it, so
 * opening a connection never grows a second startup dependency.
 * @module @deepseek-ai/dsh-control-plane/src/upstream
 */

import { Context } from '@deepseek-ai/cordis'
import type { InvocationDescriptor, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { ResolvedInstance } from './config.ts'
import { RemoteRelay } from './relay.ts'
import type { SessionRow } from './tree.ts'

/*
 * The carrier and the Remote descriptors are Client-aggregate artifacts; a
 * Host project cannot reference that aggregate, so the specifiers stay
 * non-literal and every surface below is declared structurally. Runtime
 * resolution is unchanged — these packages exist in the workspace.
 */

/** Minimal shape of the Node client carrier. */
interface ConnectionClientModule {
  installConnection: (ctx: Context, options: {
    interactions?: 'none' | 'answer'
    transport?: {
      fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>
      streamBaseUrl?: string
      createWebSocket?: (url: string) => unknown
      openStream?: (...args: never[]) => unknown
    }
  }) => void
}

/** Minimal shape of the Gateway client plugin. */
interface GatewayClientModule {
  apply: (ctx: Context) => Promise<(() => Promise<void>) | undefined>
  inject: readonly string[]
}

/** Minimal shape of a generated Remote contribution. */
interface RemoteContributionModule {
  default: TypertRemoteContribution
}

/** Minimal shape of the Typert registry plugin. */
interface RegistryModule {
  default: unknown
}

/** Import a workspace module whose specifier cannot be typed here. */
async function load<T>(specifier: string): Promise<T> {
  return await import(specifier) as T
}

/** Reachability a sidebar group reports. */
export type UpstreamState = 'connecting' | 'connected' | 'unreachable'

/** Deferred RPC seams an embedding may override (auth cookies, tests). */
export interface UpstreamTransport {
  /** Resolves the channel-relative RPC route against this instance. */
  readonly fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>
  /** WebSocket factory, when the carrier needs headers the global client cannot send. */
  readonly webSocket?: (url: string) => unknown
  /** Join the forwarded-event lifecycle (needs an auth-free Host or a cookie carrier). */
  readonly events?: boolean
}

/** One instance's client connection and the facts the sidebar reads. */
export class Upstream {
  readonly instance: ResolvedInstance
  private readonly root: Context
  private mounted: (() => Promise<void>) | undefined
  /** Descriptors of every mounted namespace, keyed by `<namespace>/<method>`. */
  private readonly descriptors = new Map<string, InvocationDescriptor>()
  /** In-flight lazy mount of the workspace namespace, if it was ever needed. */
  private workspaceMount: Promise<void> | undefined
  /** Startup of the Workspace pin/archive follow, once per connection lifetime. */
  private workspaceSets: Promise<void> | undefined
  /** Ends the current `workspace/follow` generation on dispose. */
  private stopWorkspaceFollow: (() => void) | undefined
  /** Instance-local Session ids the owner lists as pinned. */
  private readonly pinned = new Set<string>()
  /** Instance-local Session ids the owner lists as archived. */
  private readonly archived = new Set<string>()
  /** Forwards federated calls over this connection. */
  private readonly relay: RemoteRelay
  private stopStatus: (() => void) | undefined
  private readonly statusListeners = new Set<(sessionId: string, running: boolean) => void>()
  private readonly running = new Map<string, boolean>()
  private lastError: string | undefined
  private state: UpstreamState = 'connecting'

  private constructor(instance: ResolvedInstance, root: Context) {
    this.instance = instance
    this.root = root
    this.relay = new RemoteRelay({
      instanceId: instance.id,
      remote: () => (this.root as unknown as { remote?: unknown }).remote,
      descriptor: endpoint => this.descriptorOf(endpoint),
      mount: async (namespace) => { await this.mountNamespace(namespace) },
      unreachable: (cause) => {
        this.state = 'unreachable'
        this.lastError = message(cause)
      },
    })
  }

  /**
   * Open the connection and mount the session namespace.
   * @param instance - validated instance from configuration.
   * @param transport - optional RPC seams (auth cookie, test doubles).
   * @returns a connected upstream; throws when the instance cannot be mounted.
   */
  static async connect(instance: ResolvedInstance, transport: UpstreamTransport = {}): Promise<Upstream> {
    const root = new Context()
    const upstream = new Upstream(instance, root)
    // 实例仍要求 launch token 时先换一张 index cookie；免 token 后这段自然失效
    const cookie = transport.fetch === undefined ? await exchangeToken(instance) : undefined
    try {
      const [connection, gateway, registry, session] = await Promise.all([
        load<ConnectionClientModule>('@deepseek-ai/dsh-client-connection/client'),
        load<GatewayClientModule>('@deepseek-ai/dsh-api-gateway/client'),
        load<RegistryModule>('@deepseek-ai/dsh-typert-registry'),
        load<RemoteContributionModule>('@deepseek-ai/dsh-api-session-controller/remote'),
      ])
      connection.installConnection(root, {
        // 控制面不参与人工审批/提问；events 开启时才加入转发事件的生命周期
        // （免 token 的 Host 可以直接用全局 WebSocket）。
        interactions: transport.events === true ? 'answer' : 'none',
        transport: {
          fetch: transport.fetch ?? ((input, init) => {
            const headers = new Headers(init?.headers)
            if (cookie !== undefined) headers.set('cookie', cookie)
            return fetch(new URL(String(input), instance.baseUrl), { ...init, headers })
          }),
          // 事件通道暂未启用；保留 seams 供后续切换到 WS 推送
          streamBaseUrl: `${instance.baseUrl}/`,
          createWebSocket: transport.webSocket ?? ((url: string) => new WebSocket(url)),
        },
      })
      // Cordis 的重载要求 config 参数，这里按运行时契约直接调用
      const mount = async (plugin: unknown): Promise<void> => {
        await (root as unknown as { plugin: (value: unknown) => unknown }).plugin(plugin)
      }
      await mount(registry.default)
      await mount({ apply: gateway.apply, inject: gateway.inject })
      const remote = (root as unknown as {
        remote: {
          $mount: (contribution: unknown) => Promise<() => Promise<void>>
          $on: (event: string, listener: (...args: never[]) => void) => () => void
        }
      }).remote
      upstream.mounted = await remote.$mount(session.default)
      upstream.remember(session.default)
      // interactions=none 时没有事件通道；轮询 diff 负责状态变化（见 index.ts）
      const handle = (root as unknown as { connection: { interactions: 'none' | 'answer' } }).connection
      if (handle.interactions === 'answer') {
        upstream.stopStatus = remote.$on('api-session/status', (sessionId: unknown, running: unknown) => {
          upstream.publishStatus(String(sessionId), running === true)
        })
      }
      upstream.state = 'connected'
      return upstream
    } catch (error) {
      await root.fiber.dispose()
      throw new Error(`control-plane: 实例 ${instance.id} 连接失败: ${message(error)}`)
    }
  }

  /**
   * Mount one more Remote namespace on this connection.
   * @param contribution - generated Remote descriptor.
   * @returns disposer.
   */
  async mountRemote(contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
    const remote = (this.root as unknown as {
      remote: { $mount: (value: unknown) => Promise<() => Promise<void>> }
    }).remote
    const dispose = await remote.$mount(contribution)
    this.remember(contribution)
    return dispose
  }

  /**
   * Record one contribution's descriptors so the relay can name its methods.
   * @param contribution - generated Remote contribution mounted on this root.
   */
  private remember(contribution: TypertRemoteContribution): void {
    for (const descriptor of contribution.descriptors) {
      this.descriptors.set(`${descriptor.namespace}/${descriptor.method}`, descriptor)
    }
  }

  /**
   * Descriptor of one already-mounted endpoint.
   * @param endpoint - canonical `<namespace>/<method>`.
   * @returns the descriptor, or undefined when that namespace is not mounted.
   */
  private descriptorOf(endpoint: string): InvocationDescriptor | undefined {
    return this.descriptors.get(endpoint)
  }

  /**
   * Mount a namespace the first federated call to it needs.
   *
   * Only `workspace` is loadable lazily; every other namespace is either
   * mounted at connect (`session`) or not federated at all. Concurrent first
   * calls share one attempt. A failed attempt is forgotten so the next call
   * can retry: a transient mount failure must not wedge the namespace for the
   * lifetime of the connection.
   * @param namespace - Remote namespace named by a forwarded endpoint.
   */
  private async mountNamespace(namespace: string): Promise<void> {
    if (namespace !== 'workspace') return
    const attempt = this.workspaceMount ??= (async () => {
      const contribution = await load<RemoteContributionModule>('@deepseek-ai/dsh-api-workspace-controller/remote')
      const remote = (this.root as unknown as {
        remote: { $mount: (value: unknown) => Promise<() => Promise<void>> }
      }).remote
      await remote.$mount(contribution.default)
      this.remember(contribution.default)
    })()
    try {
      await attempt
    } catch (error) {
      // Clear only our own attempt: a later call may already have started a
      // retry after this one settled.
      if (this.workspaceMount === attempt) this.workspaceMount = undefined
      throw error
    }
  }

  /**
   * Forward one federated unary call over this connection.
   * @param endpoint - canonical `<namespace>/<method>`.
   * @param args - wire arguments with the instance prefix stripped.
   * @param signal - cancellation of the inbound call.
   * @returns the upstream business value.
   * @throws RemoteError with the upstream code, or
   *   `control-plane/instance-unreachable` when the instance never answered.
   */
  async forwardUnary(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<unknown> {
    return await this.relay.unary(endpoint, args, signal)
  }

  /**
   * Forward one federated stream call over this connection.
   * @param endpoint - canonical `<namespace>/<method>`.
   * @param args - wire arguments with the instance prefix stripped.
   * @param signal - cancellation of the inbound logical stream.
   * @returns the upstream items, cancelled with `signal`.
   */
  forwardStream(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): AsyncIterable<unknown> {
    return this.relay.stream(endpoint, args, signal)
  }

  /**
   * Subscribe to this instance's session running-state changes.
   * @param listener - receives the instance-local session id and its state.
   * @returns disposer.
   */
  onSessionStatus(listener: (sessionId: string, running: boolean) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  /** Session-local running state learned from events since connect. */
  get runningState(): ReadonlyMap<string, boolean> {
    return this.running
  }

  /** Push one status event to every listener, remembering the latest state. */
  private publishStatus(sessionId: string, running: boolean): void {
    this.running.set(sessionId, running)
    for (const listener of [...this.statusListeners]) {
      try {
        listener(sessionId, running)
      } catch (error) {
        console.error(`[control-plane] ${this.instance.id} 状态监听器抛错:`, error)
      }
    }
  }

  /** Current reachability, updated by every read. */
  get reachability(): UpstreamState {
    return this.state
  }

  /** Whether the forwarded-event stream generation is established. */
  get streamReady(): boolean {
    const connection = (this.root as unknown as {
      connection?: { generation: { getSnapshot: () => unknown } }
    }).connection
    return connection?.generation.getSnapshot() !== undefined
  }

  /** Last failure message, when the instance is unreachable. */
  get error(): string | undefined {
    return this.lastError
  }

  /**
   * Read this instance's visible sessions.
   * @param signal - cancellation for the persistence read.
   * @returns rows projected onto what the sidebar consumes.
   * @throws when the instance no longer answers; the upstream is then unreachable.
   */
  async listSessions(signal?: AbortSignal): Promise<SessionRow[]> {
    try {
      // Pin/archive state is not part of `session/list`; the Workspace follow
      // carries it. Starting the follow here (never awaiting it) means the
      // first tree can be a tick early on those two flags — the next compose
      // corrects them and the diff announces the change.
      this.ensureWorkspaceSets()
      // `session/list` takes no arguments; the generated client omits the
      // reserved request slot when it is empty.
      const remote = (this.root as unknown as {
        remote: { session: { list: (request: unknown, signal?: AbortSignal) => Promise<RemoteResult<{ items: readonly RawSummary[] }>> } }
      }).remote
      const value = unwrap(await remote.session.list({}, signal))
      this.state = 'connected'
      this.lastError = undefined
      return value.items.map(raw => toSessionRow(raw, this.pinned, this.archived))
    } catch (error) {
      this.state = 'unreachable'
      this.lastError = message(error)
      throw error
    }
  }

  /**
   * Keep the owner's Workspace pin/archive sets current for this connection.
   *
   * `workspace/follow` is the only read that carries both sets, and it is a
   * stream. One generation per connection feeds them for its lifetime; a
   * generation that ends (an instance restart) is retried by the next compose
   * because the startup promise is cleared with it.
   */
  private ensureWorkspaceSets(): void {
    if (this.workspaceSets !== undefined) return
    this.workspaceSets = this.followWorkspaceSets().catch(() => {
      // A failed workspace read says nothing about the sessions list, which
      // owns reachability; forget the attempt so a later compose retries.
      this.workspaceSets = undefined
    })
  }

  /** Consume one `workspace/follow` generation, refreshing both sets in place. */
  private async followWorkspaceSets(): Promise<void> {
    await this.mountNamespace('workspace')
    const remote = (this.root as unknown as {
      remote: { workspace: { follow: (signal: AbortSignal) => AsyncIterable<WorkspaceFollowFrame> } }
    }).remote
    const controller = new AbortController()
    this.stopWorkspaceFollow = () => { controller.abort() }
    try {
      await drainWorkspaceSets(remote.workspace.follow(controller.signal), this.archived, this.pinned)
    } finally {
      this.stopWorkspaceFollow = undefined
      // The generation is over: the next compose may start another one.
      this.workspaceSets = undefined
    }
  }

  /**
   * Create one session (verification helper; the control plane does not create
   * sessions itself).
   * @param cwd - working directory the new session owns.
   * @returns the instance-local session id.
   */
  async createSession(cwd: string): Promise<string> {
    const remote = (this.root as unknown as {
      remote: { session: { create: (request: { cwd: string }) => Promise<RemoteResult<{ sessionId: unknown }>> } }
    }).remote
    return String(unwrap(await remote.session.create({ cwd })).sessionId)
  }

  /** Close the connection and dispose the subtree. */
  async dispose(): Promise<void> {
    try {
      this.stopStatus?.()
      this.stopStatus = undefined
      this.stopWorkspaceFollow?.()
      this.stopWorkspaceFollow = undefined
      await this.mounted?.()
    } finally {
      await this.root.fiber.dispose()
    }
  }
}

/**
 * Exchange an instance's launch token for the signed index cookie every RPC
 * uses. Skipped when the instance declares no token.
 * @param instance - instance facts including the optional token.
 * @returns the `name=value` cookie pair, or undefined when there is no token.
 * @throws when the exchange fails; the caller reports the instance unreachable.
 */
async function exchangeToken(instance: ResolvedInstance): Promise<string | undefined> {
  if (instance.token === undefined) return undefined
  const token = encodeURIComponent(instance.token)
  const response = await fetch(`${instance.baseUrl}/?token=${token}`, { redirect: 'manual' })
  const pairs = response.headers.getSetCookie().map(entry => entry.split(';', 1)[0]).filter(Boolean)
  if (response.body !== null) await response.body.cancel()
  if (pairs.length === 0) throw new Error(`control-plane: ${instance.id} 拒绝 launch token`)
  return pairs.join('; ')
}

/** Rejection half of a Remote result envelope. */
type RemoteFailure = { readonly ok: false; readonly error: { readonly code?: string; readonly message?: string } }

/** Remote calls answer with a result envelope, not the bare value. */
type RemoteResult<T> = { readonly ok: true; readonly value: T } | RemoteFailure

/**
 * Unwrap a Remote result envelope.
 * @param result - what the generated client resolved with.
 * @returns the business value.
 * @throws when the Host rejected the call.
 */
function unwrap<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  const detail = result.error.message ?? result.error.code ?? 'unknown'
  throw new Error(`Remote 调用失败: ${detail}`)
}

/** Shape the Host's `SessionSummary` arrives in; kept local to this seam. */
export interface RawSummary {
  readonly sessionId: unknown
  readonly cwd?: string
  readonly updatedAt?: unknown
  readonly running?: unknown
  readonly agentAvailable?: unknown
  /** Summary projection block; only the `title` value is read here. */
  readonly projections?: {
    readonly values?: {
      readonly title?: unknown
    }
  }
}

/**
 * The `workspace/follow` frames this connection reads.
 *
 * Only the two Session sets matter here: the workspace tree itself comes from
 * `session/list`, and ordering is the owner's business. Frames that carry
 * neither set are accepted and ignored.
 */
export interface WorkspaceSetsValue {
  readonly pinnedSessionIds?: readonly unknown[] | undefined
  readonly archivedSessionIds?: readonly unknown[] | undefined
}

/** One frame of the Workspace state stream. */
export type WorkspaceFollowFrame =
  | { readonly type: 'baseline'; readonly value: WorkspaceSetsValue }
  | { readonly type: 'replace'; readonly value: WorkspaceSetsValue }
  | { readonly type: 'pinned'; readonly pinnedSessionIds: readonly unknown[] }
  | { readonly type: 'archived'; readonly archivedSessionIds: readonly unknown[] }
  | { readonly type: 'upsert'; readonly workspace?: unknown }
  | { readonly type: 'remove'; readonly workspaceId?: unknown }
  | { readonly type: 'order'; readonly workspaceIds?: readonly unknown[] }

/**
 * Consume a Workspace generation into the cached pin/archive sets.
 *
 * Split from the connection so the fold itself is exercised without a live
 * stream: every frame kind and the end of the generation are ordinary code.
 * @param frames - one `workspace/follow` generation.
 * @param archived - archive set the frames replace.
 * @param pinned - pin set the frames replace.
 * @returns when the generation ends.
 */
export async function drainWorkspaceSets(
  frames: AsyncIterable<WorkspaceFollowFrame>, archived: Set<string>, pinned: Set<string>,
): Promise<void> {
  for await (const frame of frames) applyWorkspaceFrame(frame, archived, pinned)
}

/**
 * Fold one Workspace frame into the cached pin/archive sets.
 * @param frame - frame from the owner's `workspace/follow` generation.
 * @param archived - archive set to replace when the frame carries one.
 * @param pinned - pin set to replace when the frame carries one.
 */
export function applyWorkspaceFrame(
  frame: WorkspaceFollowFrame, archived: Set<string>, pinned: Set<string>,
): void {
  switch (frame.type) {
    case 'baseline':
    case 'replace':
      replaceIds(archived, frame.value.archivedSessionIds)
      replaceIds(pinned, frame.value.pinnedSessionIds)
      return
    case 'archived':
      replaceIds(archived, frame.archivedSessionIds)
      return
    case 'pinned':
      replaceIds(pinned, frame.pinnedSessionIds)
      return
    default:
      // Workspace upserts, removals, and ordering: nothing the tree reads.
      return
  }
}

/**
 * Replace one cached set with the ids a frame reported.
 * @param target - set to overwrite in place.
 * @param ids - ids from the frame; undefined leaves the set empty.
 */
function replaceIds(target: Set<string>, ids: readonly unknown[] | undefined): void {
  target.clear()
  for (const id of ids ?? []) target.add(String(id))
}

/**
 * Project one upstream summary onto the row the sidebar consumes. The title is
 * optional: the projection reports `null` before a title exists, and a blank
 * string never becomes a row field, so the sidebar keeps its id fallback.
 * @param raw - one `SessionSummary` as the Host sent it.
 * @param pinned - the owner's pin set, from `workspace/follow`.
 * @param archived - the owner's archive set, from `workspace/follow`.
 * @returns the normalized row; `title`/`pinned`/`archived` are present only
 *   when they carry information.
 */
export function toSessionRow(
  raw: RawSummary,
  pinned: ReadonlySet<string> = new Set(),
  archived: ReadonlySet<string> = new Set(),
): SessionRow {
  const candidate = raw.projections?.values?.title
  const title = typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : undefined
  const sessionId = String(raw.sessionId)
  return {
    sessionId,
    cwd: raw.cwd,
    updatedAt: Number(raw.updatedAt),
    running: raw.running === true,
    agentAvailable: raw.agentAvailable === true ? true : raw.agentAvailable === false ? false : undefined,
    ...(title === undefined ? {} : { title }),
    ...(pinned.has(sessionId) ? { pinned: true } : {}),
    ...(archived.has(sessionId) ? { archived: true } : {}),
  }
}

/** Normalize an unknown thrown value into a message. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
