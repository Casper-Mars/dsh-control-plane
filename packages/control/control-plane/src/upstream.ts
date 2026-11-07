/**
 * Outbound connection to one Harness instance.
 *
 * Each instance gets its own Cordis root: the control plane's own host-side
 * services stay untouched, and one instance going away cannot dispose another.
 * The connection is the same client carrier a browser page uses, built for
 * Node (see `socket`/`rpc` seams below), with only the `session` Remote
 * namespace mounted — the sidebar needs nothing else yet.
 * @module @deepseek-ai/dsh-control-plane/src/upstream
 */

import { Context } from '@deepseek-ai/cordis'
import type { ResolvedInstance } from './config.ts'
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
  default: unknown
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
  private stopStatus: (() => void) | undefined
  private readonly statusListeners = new Set<(sessionId: string, running: boolean) => void>()
  private readonly running = new Map<string, boolean>()
  private lastError: string | undefined
  private state: UpstreamState = 'connecting'

  private constructor(instance: ResolvedInstance, root: Context) {
    this.instance = instance
    this.root = root
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
  async mountRemote(contribution: unknown): Promise<() => Promise<void>> {
    const remote = (this.root as unknown as {
      remote: { $mount: (value: unknown) => Promise<() => Promise<void>> }
    }).remote
    return await remote.$mount(contribution)
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
      // `session/list` takes no arguments; the generated client omits the
      // reserved request slot when it is empty.
      const remote = (this.root as unknown as {
        remote: { session: { list: (request: unknown, signal?: AbortSignal) => Promise<RemoteResult<{ items: readonly RawSummary[] }>> } }
      }).remote
      const value = unwrap(await remote.session.list({}, signal))
      this.state = 'connected'
      this.lastError = undefined
      return value.items.map(toSessionRow)
    } catch (error) {
      this.state = 'unreachable'
      this.lastError = message(error)
      throw error
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
 * Project one upstream summary onto the row the sidebar consumes. The title is
 * optional: the projection reports `null` before a title exists, and a blank
 * string never becomes a row field, so the sidebar keeps its id fallback.
 * @param raw - one `SessionSummary` as the Host sent it.
 * @returns the normalized row; `title` is present only when non-blank.
 */
export function toSessionRow(raw: RawSummary): SessionRow {
  const candidate = raw.projections?.values?.title
  const title = typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : undefined
  return {
    sessionId: String(raw.sessionId),
    cwd: raw.cwd,
    updatedAt: Number(raw.updatedAt),
    running: raw.running === true,
    agentAvailable: raw.agentAvailable === true ? true : raw.agentAvailable === false ? false : undefined,
    ...(title === undefined ? {} : { title }),
  }
}

/** Normalize an unknown thrown value into a message. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
