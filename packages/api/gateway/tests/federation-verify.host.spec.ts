/**
 * Independent re-verification of the t100636 claims fix.
 *
 * The bug under test: on a control-plane Host that mounts no `session` or
 * `workspace` descriptor at all, an HTTP unary federated call was rejected as
 * 404 by the claims layer before `prepareInvocation()` could forward it.
 *
 * Every federated case here enters through a public transport: HTTP
 * `/api/<namespace>/<method>` for unary calls and `/api/remote.mux` for logical
 * streams. The forwarder is a probe recording the exact target and signal it
 * receives; local business methods record their own calls so a pass-through is
 * proven by which side ran, not only by a return value.
 *
 * This file is deliberately independent of `federation.host.spec.ts`: it uses
 * its own fixtures and asserts the error envelope a caller actually sees.
 */
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { type RawData } from 'ws'
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { bindTypertRemote, Remote } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertGatewayService, {
  type FederationRouter,
  type FederationTarget,
} from '@deepseek-ai/dsh-api-gateway'
import { browserCookie, provideBrowserCredentials } from './browser-credentials.ts'
import { peerFor } from './peer.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'verify-federation-guest': { readonly kind: 'verify-federation-guest' }
  }
}

/** Local `session` namespace, used only by the non-owner pass-through case. */
class VerifySession extends Service {
  readonly typertRemote = bindTypertRemote(this, 'verifySession', { namespace: 'session' })
  readonly calls: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'verifySession')
  }

  @Remote
  list(sessionId: string): string {
    this.calls.push(sessionId)
    return `local:${sessionId}`
  }

  @Remote
  ping(): string {
    this.calls.push('<ping>')
    return 'pong'
  }
}

/** Local `workspace` namespace, so an unprefixed workspace id has a local home. */
class VerifyWorkspace extends Service {
  readonly typertRemote = bindTypertRemote(this, 'verifyWorkspace', { namespace: 'workspace' })
  readonly calls: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'verifyWorkspace')
  }

  @Remote
  read(workspaceId: string): string {
    this.calls.push(workspaceId)
    return `local:${workspaceId}`
  }
}

interface ForwardedRecord {
  readonly target: FederationTarget
  readonly signal: AbortSignal
}

interface Probe {
  readonly router: FederationRouter
  readonly unary: ForwardedRecord[]
  readonly stream: ForwardedRecord[]
}

interface ProbeOptions {
  /** Result of one forwarded unary call; defaults to echoing the target. */
  readonly unaryResult?: (target: FederationTarget) => unknown
}

/** Router stub recording exactly what the Gateway handed to the forwarder. */
function makeProbe(instances: readonly string[], options: ProbeOptions = {}): Probe {
  const unary: ForwardedRecord[] = []
  const stream: ForwardedRecord[] = []
  const result = options.unaryResult
    ?? ((target: FederationTarget) => ({ forwarded: true, instanceId: target.instanceId, args: target.args }))
  return {
    unary,
    stream,
    router: {
      hasInstance: instanceId => instances.includes(instanceId),
      forwarder: {
        async unary(target, signal) {
          unary.push({ target, signal })
          return await result(target)
        },
        stream(target, signal) {
          stream.push({ target, signal })
          return (async function * () {
            // The item reaches the client verbatim, without a carrier envelope.
            yield { instanceId: target.instanceId, endpoint: target.endpoint, args: target.args }
            // Hold the logical stream until the inbound cancellation arrives.
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve()
              else signal.addEventListener('abort', () => { resolve() }, { once: true })
            })
          })()
        },
      },
    },
  }
}

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
})

function origin(ctx: Context): string {
  return `http://127.0.0.1:${String(ctx.webServer.port)}`
}

/**
 * The shape federation exists for: the Gateway and its real HTTP/WS carriers
 * are mounted, but no `session` or `workspace` Service (and therefore no
 * descriptor) is. Only the claims layer can let those endpoints through.
 */
async function setupControlPlaneHost(): Promise<Context> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  provideBrowserCredentials(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGatewayService)
  await ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
  return ctx
}

interface LocalFixture {
  readonly ctx: Context
  readonly sessions: VerifySession
  readonly workspaces: VerifyWorkspace
}

/** In-process Host with local descriptors, used to prove pass-through side effects. */
async function setupLocal(): Promise<LocalFixture> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGatewayService)
  await ctx.plugin(VerifySession)
  await ctx.plugin(VerifyWorkspace)
  return {
    ctx,
    sessions: original<VerifySession>(ctx, 'verifySession'),
    workspaces: original<VerifyWorkspace>(ctx, 'verifyWorkspace'),
  }
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- callers name each service face at the call site.
function original<T extends object>(ctx: Context, key: string): T {
  const receiver = ctx.get(key) as unknown as T & { [symbols.original]?: T }
  return receiver[symbols.original] ?? receiver
}

interface RpcBody {
  readonly type: string
  readonly rpcId: string
  readonly result: unknown
}

async function httpPost(
  ctx: Context,
  endpoint: string,
  args: Record<string, unknown>,
  rpcId: string,
): Promise<Response> {
  return await fetch(`${origin(ctx)}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: browserCookie(ctx) },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: { args },
    }),
  })
}

async function postRpc(
  ctx: Context,
  endpoint: string,
  args: Record<string, unknown>,
  rpcId = 'verify-rpc',
): Promise<RpcBody> {
  const response = await httpPost(ctx, endpoint, args, rpcId)
  expect(response.status).toBe(200)
  return await response.json() as RpcBody
}

function sendOpen(socket: WebSocket, streamId: string, endpoint: string, args: object): void {
  socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

// ---------------------------------------------------------------------------
// 1. Real HTTP unary entry on a descriptor-less control-plane Host
// ---------------------------------------------------------------------------

describe('1. HTTP unary federation without any local session/workspace descriptor', () => {
  it('admits session/list, forwards stripped args, and never runs a local method', async () => {
    const ctx = await setupControlPlaneHost()
    const probe = makeProbe(['inst-a'])
    const dispose = ctx.typertGateway.registerFederationRouter(probe.router)

    try {
      // No `session` Service is mounted: this would have been a claims-layer 404
      // before the fix.
      expect(ctx.get('verifySession')).toBeUndefined()

      const body = await postRpc(ctx, 'session/list', { sessionId: 'inst-a:s-1' }, 'fed-claim-http')
      expect(body).toEqual({
        type: 'server-response',
        rpcId: 'fed-claim-http',
        result: {
          ok: true,
          value: { forwarded: true, instanceId: 'inst-a', args: { sessionId: 's-1' } },
        },
      })
      expect(probe.unary).toHaveLength(1)
      expect(probe.unary[0]?.target).toEqual({
        instanceId: 'inst-a',
        endpoint: 'session/list',
        args: { sessionId: 's-1' },
      })
      expect(probe.unary[0]?.signal).toBeInstanceOf(AbortSignal)
    } finally {
      dispose()
    }
  })

  it('admits workspace/read through the workspaceId key', async () => {
    const ctx = await setupControlPlaneHost()
    const probe = makeProbe(['inst-a'])
    const dispose = ctx.typertGateway.registerFederationRouter(probe.router)

    try {
      expect(ctx.get('verifyWorkspace')).toBeUndefined()

      const body = await postRpc(ctx, 'workspace/read', { workspaceId: 'inst-a:/repo' }, 'fed-claim-ws')
      expect(body).toEqual({
        type: 'server-response',
        rpcId: 'fed-claim-ws',
        result: {
          ok: true,
          value: { forwarded: true, instanceId: 'inst-a', args: { workspaceId: '/repo' } },
        },
      })
      expect(probe.unary).toHaveLength(1)
      expect(probe.unary[0]?.target).toEqual({
        instanceId: 'inst-a',
        endpoint: 'workspace/read',
        args: { workspaceId: '/repo' },
      })
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Regression: the pre-fix behaviour and the pass-through boundaries
// ---------------------------------------------------------------------------

describe('2. regression around the claims change', () => {
  it.each(['session/list', 'workspace/read'])(
    'still answers 404 for %s when no router is registered',
    async (endpoint) => {
      const ctx = await setupControlPlaneHost()
      const args = endpoint.startsWith('session')
        ? { sessionId: 'inst-a:s-1' }
        : { workspaceId: 'inst-a:/repo' }

      const response = await httpPost(ctx, endpoint, args, 'fed-no-router')
      expect(response.status).toBe(404)
    },
  )

  it('still answers 404 for a non-whitelisted endpoint with a prefixed argument', async () => {
    const ctx = await setupControlPlaneHost()
    const probe = makeProbe(['inst-a'])
    const dispose = ctx.typertGateway.registerFederationRouter(probe.router)

    try {
      // `goals` is not a federated namespace: the router must not widen claims.
      const response = await httpPost(ctx, 'goals/list', { sessionId: 'inst-a:s-1' }, 'fed-goals')
      expect(response.status).toBe(404)
      expect(probe.unary).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  it('reaches local resolution — not a claims 404 — for a prefix-free session/list', async () => {
    const ctx = await setupControlPlaneHost()
    const probe = makeProbe(['inst-a'])
    const dispose = ctx.typertGateway.registerFederationRouter(probe.router)

    try {
      const body = await postRpc(ctx, 'session/list', { sessionId: 's-1' }, 'fed-local-miss')
      // The claims layer admitted the endpoint; the failure is the ordinary
      // descriptor-missing error, which is a predictable 200 + rpcFailure.
      expect(body).toMatchObject({
        type: 'server-response',
        rpcId: 'fed-local-miss',
        result: {
          ok: false,
          error: {
            code: 'gateway/invocation-unavailable',
            details: { endpoint: 'session/list' },
          },
        },
      })
      expect(probe.unary).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  it('does not forward a non-owner peer even with a configured instance prefix', async () => {
    const { ctx, sessions } = await setupLocal()
    const probe = makeProbe(['inst-a'])
    const dispose = ctx.typertGateway.registerFederationRouter(probe.router)

    try {
      await expect(ctx.typertGateway.invoke({
        peer: peerFor(ctx, { kind: 'verify-federation-guest' }),
        namespace: 'session',
        method: 'list',
        args: { sessionId: 'inst-a:s-1' },
      })).rejects.toMatchObject({ code: 'remote-access/denied' })
      expect(probe.unary).toHaveLength(0)
      expect(sessions.calls).toEqual([])
    } finally {
      dispose()
    }
  })

  it('does not forward a non-owner peer on the descriptor-less host either', async () => {
    const ctx = await setupControlPlaneHost()
    const probe = makeProbe(['inst-a'])
    const dispose = ctx.typertGateway.registerFederationRouter(probe.router)

    try {
      // A non-owner Peer keeps the local path, where the missing descriptor is
      // reported; the forwarder must not be reached, so no cross-instance
      // boundary is crossed on behalf of a guest.
      await expect(ctx.typertGateway.invoke({
        peer: peerFor(ctx, { kind: 'verify-federation-guest' }),
        namespace: 'session',
        method: 'list',
        args: { sessionId: 'inst-a:s-1' },
      })).rejects.toMatchObject({ code: 'gateway/invocation-unavailable' })
      expect(probe.unary).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  it('restores the exact 404 once the router is disposed', async () => {
    const ctx = await setupControlPlaneHost()
    const probe = makeProbe(['inst-a'])
    const dispose = ctx.typertGateway.registerFederationRouter(probe.router)

    const admitted = await httpPost(ctx, 'session/list', { sessionId: 'inst-a:s-1' }, 'fed-before-dispose')
    expect(admitted.status).toBe(200)

    dispose()

    const rejected = await httpPost(ctx, 'session/list', { sessionId: 'inst-a:s-1' }, 'fed-after-dispose')
    expect(rejected.status).toBe(404)
    expect(probe.unary).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 3. Stream carrier must not regress
// ---------------------------------------------------------------------------

describe('3. WebSocket stream carrier', () => {
  it('forwards session/observeEvent with a prefixed id and propagates client abort', async () => {
    const ctx = await setupControlPlaneHost()
    const probe = makeProbe(['inst-a'])
    const dispose = ctx.typertGateway.registerFederationRouter(probe.router)
    const socket = new WebSocket(`ws://127.0.0.1:${String(ctx.webServer.port)}/api/remote.mux`, {
      headers: { cookie: browserCookie(ctx) },
    })

    try {
      await once(socket, 'open')
      const frames: Record<string, unknown>[] = []
      socket.on('message', (data) => { frames.push(JSON.parse(rawText(data)) as Record<string, unknown>) })

      sendOpen(socket, 'fed-stream', 'session/observeEvent', { sessionId: 'inst-a:s-7' })

      await vi.waitFor(() => {
        expect(frames).toContainEqual({
          type: 'item',
          streamId: 'fed-stream',
          value: { instanceId: 'inst-a', endpoint: 'session/observeEvent', args: { sessionId: 's-7' } },
        })
      })
      expect(probe.stream).toHaveLength(1)
      expect(probe.stream[0]?.target).toEqual({
        instanceId: 'inst-a',
        endpoint: 'session/observeEvent',
        args: { sessionId: 's-7' },
      })
      expect(probe.stream[0]?.signal.aborted).toBe(false)

      // Closing the client socket cancels the inbound logical stream and the
      // forwarder's signal sees it.
      socket.close()
      await once(socket, 'close')
      await vi.waitFor(() => { expect(probe.stream[0]?.signal.aborted).toBe(true) })
    } finally {
      dispose()
      if (socket.readyState !== WebSocket.CLOSED) socket.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. The fix must not widen authorization or crash on unknown methods
// ---------------------------------------------------------------------------

describe('4. no privilege widening and predictable failures', () => {
  it.each([
    ['session/xxx', { sessionId: 's-1' }, 'session/xxx'],
    ['workspace/xxx', { workspaceId: '/repo' }, 'workspace/xxx'],
  ] as const)(
    'does not forward a prefix-free unknown endpoint %s and fails predictably',
    async (endpoint, args, expectedEndpoint) => {
      const ctx = await setupControlPlaneHost()
      const probe = makeProbe(['inst-a'])
      const dispose = ctx.typertGateway.registerFederationRouter(probe.router)

      try {
        const body = await postRpc(ctx, endpoint, args, 'fed-unknown')

        // Exactly one well-formed envelope: 200 with rpcFailure, no crash.
        expect(body).toStrictEqual({
          type: 'server-response',
          rpcId: 'fed-unknown',
          result: {
            ok: false,
            error: {
              code: 'gateway/invocation-unavailable',
              message: `typert gateway: ${expectedEndpoint}: no active Remote method exports this endpoint`,
              details: { endpoint: expectedEndpoint },
            },
          },
        })
        expect(probe.unary).toHaveLength(0)
        expect(probe.stream).toHaveLength(0)

        // The Gateway is still serving: a legitimate call after the unknown
        // one still forwards.
        const next = await postRpc(ctx, 'session/list', { sessionId: 'inst-a:s-2' }, 'fed-after-unknown')
        expect(next).toMatchObject({
          result: { ok: true, value: { instanceId: 'inst-a', args: { sessionId: 's-2' } } },
        })
        expect(probe.unary).toHaveLength(1)
      } finally {
        dispose()
      }
    },
  )

  it('does not claim a deeper endpoint that merely starts with session/', async () => {
    const ctx = await setupControlPlaneHost()
    const probe = makeProbe(['inst-a'])
    const dispose = ctx.typertGateway.registerFederationRouter(probe.router)

    try {
      const response = await httpPost(ctx, 'session/list/extra', { sessionId: 'inst-a:s-1' }, 'fed-deep')
      expect(response.status).toBe(404)
      expect(probe.unary).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  it('does not forward an unprefixed unknown method of an unconfigured instance', async () => {
    const ctx = await setupControlPlaneHost()
    const probe = makeProbe(['inst-a'])
    const dispose = ctx.typertGateway.registerFederationRouter(probe.router)

    try {
      const body = await postRpc(ctx, 'session/xxx', { sessionId: 'ghost:s-1' }, 'fed-unknown-ghost')
      expect(body).toMatchObject({
        result: { ok: false, error: { code: 'gateway/invocation-unavailable' } },
      })
      expect(probe.unary).toHaveLength(0)
    } finally {
      dispose()
    }
  })
})
