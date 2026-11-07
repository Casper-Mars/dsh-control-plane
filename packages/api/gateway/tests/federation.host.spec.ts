/**
 * Federation routing at the Gateway's single preparation point.
 *
 * These specs exercise the public Gateway surface only: a router is registered
 * through `registerFederationRouter`, and calls arrive through `invoke()`,
 * `stream()`, or the carriers. No session/workspace business Service is
 * mounted for the federated cases — resolution must happen before descriptor
 * lookup, exactly as a control-plane Host needs it to.
 */
import { afterEach, describe, expect, it } from 'vitest'
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
import { ownerPeer, peerFor } from './peer.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'test-federation-guest': { readonly kind: 'test-federation-guest' }
  }
}

/** Local `session` namespace: the fall-through target for every pass-through case. */
class LocalSessionService extends Service {
  readonly typertRemote = bindTypertRemote(this, 'federationSession', { namespace: 'session' })
  readonly calls: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'federationSession')
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

/** Local `workspace` namespace, so a missing instance also falls through here. */
class LocalWorkspaceService extends Service {
  readonly typertRemote = bindTypertRemote(this, 'federationWorkspace', { namespace: 'workspace' })
  readonly calls: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'federationWorkspace')
  }

  @Remote
  read(workspaceId: string): string {
    this.calls.push(workspaceId)
    return `local:${workspaceId}`
  }
}

/** A namespace outside the whitelist, to prove routing never scans it. */
class LocalGoalService extends Service {
  readonly typertRemote = bindTypertRemote(this, 'federationGoal', { namespace: 'federationGoal' })
  readonly calls: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'federationGoal')
  }

  @Remote
  echo(value: string): string {
    this.calls.push(value)
    return `local:${value}`
  }
}

interface ForwardedUnary {
  readonly target: FederationTarget
  readonly signal: AbortSignal
}

interface ForwardedStream {
  readonly target: FederationTarget
  readonly signal: AbortSignal
}

/** A router stub recording what the Gateway decided to forward. */
function federationProbe(instances: readonly string[]): {
  readonly router: FederationRouter
  readonly unary: ForwardedUnary[]
  readonly stream: ForwardedStream[]
} {
  const unary: ForwardedUnary[] = []
  const stream: ForwardedStream[] = []
  return {
    unary,
    stream,
    router: {
      hasInstance: instanceId => instances.includes(instanceId),
      forwarder: {
        async unary(target, signal) {
          unary.push({ target, signal })
          return { forwarded: true, instanceId: target.instanceId, args: target.args }
        },
        stream(target, signal) {
          stream.push({ target, signal })
          const localId = String(target.args.sessionId ?? target.args.workspaceId)
          return (async function * () {
            yield `${target.instanceId}|${target.endpoint}|${localId}`
          })()
        },
      },
    },
  }
}

interface Fixture {
  readonly ctx: Context
  readonly sessions: LocalSessionService
  readonly workspaces: LocalWorkspaceService
  readonly goals: LocalGoalService
}

async function setup(): Promise<Fixture> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGatewayService)
  await ctx.plugin(LocalSessionService)
  await ctx.plugin(LocalWorkspaceService)
  await ctx.plugin(LocalGoalService)
  const sessionReceiver = ctx.get('federationSession') as unknown as LocalSessionService
    & { [symbols.original]?: LocalSessionService }
  const workspaceReceiver = ctx.get('federationWorkspace') as unknown as LocalWorkspaceService
    & { [symbols.original]?: LocalWorkspaceService }
  const goalReceiver = ctx.get('federationGoal') as unknown as LocalGoalService
    & { [symbols.original]?: LocalGoalService }
  return {
    ctx,
    sessions: sessionReceiver[symbols.original] ?? sessionReceiver,
    workspaces: workspaceReceiver[symbols.original] ?? workspaceReceiver,
    goals: goalReceiver[symbols.original] ?? goalReceiver,
  }
}

function unaryRequest(ctx: Context, namespace: string, method: string, args: Record<string, unknown>) {
  return { peer: ownerPeer(ctx), namespace, method, args }
}

describe('federation routing', () => {
  it('forwards a whitelisted unary call and strips the instance prefix', async () => {
    const { ctx, sessions } = await setup()
    const probe = federationProbe(['alpha'])
    const disposer = ctx.typertGateway.registerFederationRouter(probe.router)

    await expect(ctx.typertGateway.invoke(unaryRequest(ctx, 'session', 'list', { sessionId: 'alpha:s-1' })))
      .resolves.toEqual({ forwarded: true, instanceId: 'alpha', args: { sessionId: 's-1' } })
    expect(probe.unary).toHaveLength(1)
    expect(probe.unary[0]?.target).toEqual({
      instanceId: 'alpha',
      endpoint: 'session/list',
      args: { sessionId: 's-1' },
    })
    expect(probe.unary[0]?.signal).toBeInstanceOf(AbortSignal)
    // Descriptor resolution and the local method are never reached.
    expect(sessions.calls).toEqual([])
    disposer()
  })

  it('only splits the identifier at its first colon', async () => {
    const { ctx } = await setup()
    const probe = federationProbe(['alpha'])
    const disposer = ctx.typertGateway.registerFederationRouter(probe.router)

    await expect(ctx.typertGateway.invoke(unaryRequest(ctx, 'session', 'list', { sessionId: 'alpha:s-1:tail' })))
      .resolves.toMatchObject({ args: { sessionId: 's-1:tail' } })
    expect(probe.unary[0]?.target.instanceId).toBe('alpha')
    disposer()
  })

  it('routes workspace calls through workspaceId only', async () => {
    const { ctx, workspaces } = await setup()
    const probe = federationProbe(['alpha'])
    const disposer = ctx.typertGateway.registerFederationRouter(probe.router)

    await expect(ctx.typertGateway.invoke(unaryRequest(ctx, 'workspace', 'read', { workspaceId: 'alpha:/repo' })))
      .resolves.toMatchObject({ instanceId: 'alpha', args: { workspaceId: '/repo' } })
    expect(workspaces.calls).toEqual([])
    disposer()
  })

  it('forwards a stream call to the forwarder iterable', async () => {
    const { ctx } = await setup()
    const probe = federationProbe(['alpha'])
    const disposer = ctx.typertGateway.registerFederationRouter(probe.router)

    const values: unknown[] = []
    for await (const value of await ctx.typertGateway.stream(
      unaryRequest(ctx, 'session', 'tail', { sessionId: 'alpha:s-9' }),
    )) values.push(value)

    expect(values).toEqual(['alpha|session/tail|s-9'])
    expect(probe.stream).toHaveLength(1)
    expect(probe.stream[0]?.target).toEqual({
      instanceId: 'alpha',
      endpoint: 'session/tail',
      args: { sessionId: 's-9' },
    })
    disposer()
  })

  it('forwards through the carrier stream entry as well', async () => {
    const { ctx } = await setup()
    const probe = federationProbe(['alpha'])
    const disposer = ctx.typertGateway.registerFederationRouter(probe.router)

    async function * empty(): AsyncIterable<unknown> { /* no uplink in this fixture */ }
    const opened = await ctx.typertGateway.wireStream.open(
      'workspace/read',
      { args: { workspaceId: 'alpha:/repo' } },
      empty(),
      ownerPeer(ctx),
      new AbortController().signal,
    )
    const values: unknown[] = []
    for await (const value of opened) values.push(value)

    expect(values).toEqual(['alpha|workspace/read|/repo'])
    expect(probe.stream).toHaveLength(1)
    expect(probe.stream[0]?.target).toEqual({
      instanceId: 'alpha',
      endpoint: 'workspace/read',
      args: { workspaceId: '/repo' },
    })
    disposer()
  })

  it('passes through when the instance is not registered', async () => {
    const { ctx, sessions } = await setup()
    const probe = federationProbe(['alpha'])
    const disposer = ctx.typertGateway.registerFederationRouter(probe.router)

    await expect(ctx.typertGateway.invoke(unaryRequest(ctx, 'session', 'list', { sessionId: 'ghost:s-1' })))
      .resolves.toBe('local:ghost:s-1')
    expect(sessions.calls).toEqual(['ghost:s-1'])
    expect(probe.unary).toEqual([])
    disposer()
  })

  it('passes through non-whitelisted endpoints even when an id has a prefix', async () => {
    const { ctx, goals } = await setup()
    const probe = federationProbe(['alpha'])
    const disposer = ctx.typertGateway.registerFederationRouter(probe.router)

    await expect(ctx.typertGateway.invoke(unaryRequest(ctx, 'federationGoal', 'echo', {
      value: 'alpha:s-1',
    }))).resolves.toBe('local:alpha:s-1')
    expect(goals.calls).toEqual(['alpha:s-1'])
    expect(probe.unary).toEqual([])
    disposer()
  })

  it('passes through when the namespace id argument is absent', async () => {
    const { ctx, sessions } = await setup()
    const probe = federationProbe(['alpha'])
    const disposer = ctx.typertGateway.registerFederationRouter(probe.router)

    await expect(ctx.typertGateway.invoke(unaryRequest(ctx, 'session', 'ping', {})))
      .resolves.toBe('pong')
    expect(sessions.calls).toEqual(['<ping>'])
    expect(probe.unary).toEqual([])
    disposer()
  })

  it.each([
    ['empty instance', ':s-1'],
    ['empty local id', 'alpha:'],
    ['no separator', 'alpha'],
    ['bare separator', ':'],
  ])('passes through a malformed prefix (%s)', async (_label, sessionId) => {
    const { ctx, sessions } = await setup()
    const probe = federationProbe(['alpha'])
    const disposer = ctx.typertGateway.registerFederationRouter(probe.router)

    await expect(ctx.typertGateway.invoke(unaryRequest(ctx, 'session', 'list', { sessionId })))
      .resolves.toBe(`local:${sessionId}`)
    expect(sessions.calls).toEqual([sessionId])
    expect(probe.unary).toEqual([])
    disposer()
  })

  it('never forwards a non-owner peer', async () => {
    const { ctx, sessions } = await setup()
    const probe = federationProbe(['alpha'])
    const disposer = ctx.typertGateway.registerFederationRouter(probe.router)
    const guest = peerFor(ctx, { kind: 'test-federation-guest' })

    await expect(ctx.typertGateway.invoke({
      peer: guest,
      namespace: 'session',
      method: 'list',
      args: { sessionId: 'alpha:s-1' },
    })).rejects.toMatchObject({ code: 'remote-access/denied' })
    expect(probe.unary).toEqual([])
    expect(sessions.calls).toEqual([])
    disposer()
  })

  it('rejects a second router and restores pass-through after disposal', async () => {
    const { ctx, sessions } = await setup()
    const first = federationProbe(['alpha'])
    const second = federationProbe(['beta'])
    const disposer = ctx.typertGateway.registerFederationRouter(first.router)

    expect(() => ctx.typertGateway.registerFederationRouter(second.router))
      .toThrow(/already registered/)

    disposer()
    await expect(ctx.typertGateway.invoke(unaryRequest(ctx, 'session', 'list', { sessionId: 'alpha:s-1' })))
      .resolves.toBe('local:alpha:s-1')
    expect(sessions.calls).toEqual(['alpha:s-1'])

    // The slot is free again: a later router takes effect.
    const replacement = ctx.typertGateway.registerFederationRouter(second.router)
    await expect(ctx.typertGateway.invoke(unaryRequest(ctx, 'session', 'list', { sessionId: 'beta:s-2' })))
      .resolves.toMatchObject({ instanceId: 'beta', args: { sessionId: 's-2' } })
    replacement()
  })
})

// ---------------------------------------------------------------------------
// Control-plane claims: no session/workspace descriptor is mounted at all
// ---------------------------------------------------------------------------

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
})

/**
 * A control-plane Host in the shape federation exists for: the Gateway and its
 * HTTP carrier are mounted, but no `session` or `workspace` service is. Only
 * the claims layer can let these endpoints through to `prepareInvocation`.
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

async function httpPost(
  ctx: Context,
  endpoint: string,
  args: Record<string, unknown>,
  rpcId: string,
): Promise<Response> {
  return await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: browserCookie(ctx) },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
  })
}

describe('federation claims on a descriptor-less control-plane Host', () => {
  it('admits an unmounted session endpoint over HTTP once a router is registered', async () => {
    const ctx = await setupControlPlaneHost()
    const probe = federationProbe(['inst-a'])
    const disposer = ctx.typertGateway.registerFederationRouter(probe.router)

    const response = await httpPost(ctx, 'session/list', { sessionId: 'inst-a:s-1' }, 'fed-claim')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      type: 'server-response',
      rpcId: 'fed-claim',
      result: { ok: true, value: { forwarded: true, instanceId: 'inst-a', args: { sessionId: 's-1' } } },
    })
    expect(probe.unary).toHaveLength(1)
    expect(probe.unary[0]?.target).toEqual({
      instanceId: 'inst-a',
      endpoint: 'session/list',
      args: { sessionId: 's-1' },
    })
    disposer()
  })

  it('admits an unmounted workspace endpoint the same way', async () => {
    const ctx = await setupControlPlaneHost()
    const probe = federationProbe(['inst-a'])
    const disposer = ctx.typertGateway.registerFederationRouter(probe.router)

    const response = await httpPost(ctx, 'workspace/read', { workspaceId: 'inst-a:/repo' }, 'fed-claim-ws')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      type: 'server-response',
      rpcId: 'fed-claim-ws',
      result: { ok: true, value: { forwarded: true, instanceId: 'inst-a', args: { workspaceId: '/repo' } } },
    })
    expect(probe.unary).toHaveLength(1)
    disposer()
  })

  it('still answers 404 without a router, exactly as before', async () => {
    const ctx = await setupControlPlaneHost()

    const response = await httpPost(ctx, 'session/list', { sessionId: 'inst-a:s-1' }, 'fed-claim-none')
    expect(response.status).toBe(404)
  })

  it('does not claim a non-whitelisted endpoint even with a router', async () => {
    const ctx = await setupControlPlaneHost()
    const probe = federationProbe(['inst-a'])
    const disposer = ctx.typertGateway.registerFederationRouter(probe.router)

    const response = await httpPost(ctx, 'goals/list', { sessionId: 'inst-a:s-1' }, 'fed-claim-other')
    expect(response.status).toBe(404)
    expect(probe.unary).toHaveLength(0)
    disposer()
  })

  it('reaches local descriptor resolution, not 404, when the prefix is missing', async () => {
    const ctx = await setupControlPlaneHost()
    const probe = federationProbe(['inst-a'])
    const disposer = ctx.typertGateway.registerFederationRouter(probe.router)

    const response = await httpPost(ctx, 'session/list', { sessionId: 's-1' }, 'fed-claim-local')
    expect(response.status).toBe(200)
    const body: unknown = await response.json()
    expect(body).toMatchObject({
      type: 'server-response',
      rpcId: 'fed-claim-local',
      result: { ok: false, error: { code: 'gateway/invocation-unavailable' } },
    })
    expect(probe.unary).toHaveLength(0)
    disposer()
  })
})
