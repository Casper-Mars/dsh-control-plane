/**
 * Independent verification of t100637: real cross-instance forwarding.
 *
 * Three seams are exercised, each with the real artifact of the layer above:
 *
 * 1. `RemoteRelay` over the **real generated `session` descriptors** and a mock
 *    Client Remote namespace. This is where the wire shape matters: the relay
 *    forwards named wire arguments (`{ request: { sessionId } }`) and the
 *    descriptor — not this package — decides the positional call shape.
 * 2. The **real Gateway** with the router `ControlPlane` registers itself, so a
 *    call travels `invoke`/`stream` → router → forwarder → upstream connection.
 * 3. A **real generated Client** mounted in a browser-shaped Context, to prove
 *    the arguments the router actually sees on the wire are the wrapped ones.
 */
import { Context } from '@deepseek-ai/cordis'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import * as SessionRemote from '@deepseek-ai/dsh-api-session-controller/remote'
import * as WorkspaceRemote from '@deepseek-ai/dsh-api-workspace-controller/remote'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService, {
  isFederatedEndpoint,
  resolveFederationTarget,
  type TypertGateway,
} from '@deepseek-ai/dsh-api-gateway'
import { apply as applyGatewayClient, inject as gatewayClientInject } from '@deepseek-ai/dsh-api-gateway/client'
import {
  RemoteError,
  remoteErrorOf,
  type InvocationDescriptor,
  type TypertRemoteMethod,
} from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { ResolvedInstance } from '../src/config.ts'
import { InstanceConnections, type InstanceConnection } from '../src/connections.ts'
import { ControlPlane, RemoteRelay, Upstream } from '../src/index.ts'

const INSTANCES: readonly ResolvedInstance[] = [
  { id: 'alpha', name: 'Alpha', host: '127.0.0.1', port: 1, baseUrl: 'http://127.0.0.1:1' },
  { id: 'beta', name: 'Beta', host: '127.0.0.1', port: 2, baseUrl: 'http://127.0.0.1:2' },
]

const descriptors = SessionRemote.TYPERT_REMOTE.descriptors

/** The real generated descriptor of one endpoint. */
function method(endpoint: string, stream = false): TypertRemoteMethod<object, unknown> {
  const descriptor = descriptors.find(candidate => `${candidate.namespace}/${candidate.method}` === endpoint)
  if (descriptor === undefined) throw new Error(`fixture: ${endpoint} is not a generated method`)
  if ((descriptor.mode === 'stream') !== stream) throw new Error(`fixture: ${endpoint} carrier mismatch`)
  return descriptor as unknown as TypertRemoteMethod<object, unknown>
}

/**
 * A mock Client Remote namespace root holding the real descriptors.
 *
 * Only the namespaces a test touches exist, and every member records the
 * positional arguments the descriptor produced — which is exactly the question
 * "did the relay unwrap the wire shape correctly" reduces to.
 */
function mockRemote(faces: Record<string, Record<string, (...args: never[]) => unknown>>): {
  readonly remote: unknown
  readonly calls: { method: string; args: readonly unknown[] }[]
} {
  const calls: { method: string; args: readonly unknown[] }[] = []
  const root: Record<string, unknown> = {}
  for (const [namespace, members] of Object.entries(faces)) {
    const recorded: Record<string, unknown> = {}
    for (const [name, implementation] of Object.entries(members)) {
      recorded[name] = (...args: unknown[]) => {
        calls.push({ method: `${namespace}/${name}`, args })
        return implementation(...args as never[])
      }
    }
    root[namespace] = recorded
  }
  return { remote: root, calls }
}

/** A relay over one mock namespace root and the real descriptor table. */
function relay(remote: unknown, instanceId = 'alpha'): RemoteRelay {
  return new RemoteRelay({
    instanceId,
    remote: () => remote,
    descriptor: (endpoint) => {
      const [namespace, name] = endpoint.split('/') as [string, string]
      return descriptors.find(candidate => candidate.namespace === namespace && candidate.method === name)
    },
    mount: async () => {},
  })
}

/** A body writer the relay tests share: resolves the upstream envelope shape. */
function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

/**
 * A browser-shaped Client: the real Client Remote service over a recording RPC
 * carrier, with the real generated `session` contribution mounted.
 */
async function generatedClient(): Promise<{
  readonly cancel: (request: unknown) => Promise<unknown>
  readonly sent: unknown[]
}> {
  const ctx = new Context()
  contexts.add(ctx)
  const sent: unknown[] = []
  ctx.reflect.provide('connection', {
    interactions: 'none',
    isLoopback: true,
    rpc: {
      call: async (channel: string, endpoint: string, payload: unknown) => {
        sent.push({ channel, endpoint, payload })
        return ok({ accepted: true })
      },
    },
    openWebSocket: () => { throw new Error('fixture: no WebSocket') },
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    state: { getSnapshot: () => 'connected', subscribe: () => () => {} },
    reconnect: () => {},
    registerGenerationSource: () => () => {},
    start: () => ({ stop: () => {} }),
  })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin({ apply: applyGatewayClient, inject: gatewayClientInject })
  await ctx.remote.$mount(SessionRemote.default)
  return {
    cancel: async request => await (ctx.remote as unknown as {
      session: { cancel: (request: unknown) => Promise<unknown> }
    }).session.cancel(request),
    sent,
  }
}

const contexts = new Set<Context>()

afterEach(async () => {
  await Promise.all([...contexts].map(async (ctx) => { await ctx.fiber.dispose() }))
  contexts.clear()
})

// ---------------------------------------------------------------------------
// 1 — the wire shape: wrapped `request`, real descriptors
// ---------------------------------------------------------------------------
describe('t100637 / real descriptor wire shape', () => {
  it('declares the cancel argument under its wire name, not as a flat sessionId', () => {
    expect(method('session/cancel').parameters.map(parameter => parameter.wire)).toEqual(['request'])
    expect(method('session/follow', true).parameters.map(parameter => parameter.wire)).toEqual(['request'])
  })

  it('proves a generated Client sends session/cancel as { request: { sessionId } }', async () => {
    const client = await generatedClient()
    const result = await client.cancel({ sessionId: 'alpha:s-1' })

    expect(result).toEqual(ok({ accepted: true }))
    expect(client.sent).toEqual([{
      channel: '/api',
      endpoint: 'session/cancel',
      payload: { args: { request: { sessionId: 'alpha:s-1' } } },
    }])
  })

  it('routes the arguments a real generated Client produced through the Gateway', async () => {
    // Step 1: the wire arguments are produced by the real generated Client, not
    // by a hand-written fixture.
    const client = await generatedClient()
    await client.cancel({ sessionId: 'alpha:s-1' })
    const wireArgs = (client.sent[0] as { payload: { args: Record<string, unknown> } }).payload.args

    // Step 2: exactly those arguments enter a real Gateway whose router is the
    // control plane's own forwarder.
    const alpha = fakeInstance('alpha')
    const { gateway, peer } = await bench(instances => new InstanceConnections(instances, {
      open: async instance => instance.id === 'alpha' ? alpha.connection : fakeInstance(instance.id).connection,
    }))
    const value = await gateway.invoke({ peer, namespace: 'session', method: 'cancel', args: wireArgs })

    expect(value).toEqual({ accepted: true, instanceId: 'alpha' })
    expect(alpha.unary.map(call => call.endpoint)).toEqual(['session/cancel'])
    expect(alpha.unary[0]?.args).toEqual({ request: { sessionId: 's-1' } })
  })

  it('unwraps that shape for the upstream method and strips the prefix in place', async () => {
    const { remote, calls } = mockRemote({
      session: { cancel: async () => ok({ accepted: true }) },
    })
    const result = await relay(remote).unary(
      'session/cancel',
      { request: { sessionId: 's-1' } },
      new AbortController().signal,
    )

    expect(result).toEqual({ accepted: true })
    // Positional, one business argument: the descriptor unwrapped `request`.
    expect(calls).toEqual([{ method: 'session/cancel', args: [{ sessionId: 's-1' }] }])
  })

  it('mounts the workspace namespace on demand and then forwards through it', async () => {
    const mounted: string[] = []
    const available: InvocationDescriptor[] = []
    const remote = {
      workspace: {
        rename: async (request: unknown) => ok({ renamed: request }),
      },
    }
    // Nothing is mounted yet, so the first lookup misses and the relay must ask
    // for the namespace before it can name the method.
    const lazy = new RemoteRelay({
      instanceId: 'alpha',
      remote: () => remote,
      descriptor: endpoint => available.find(candidate => `${candidate.namespace}/${candidate.method}` === endpoint),
      mount: async (namespace) => {
        mounted.push(namespace)
        available.push(...WorkspaceRemote.TYPERT_REMOTE.descriptors)
      },
    })

    const result = await lazy.unary(
      'workspace/rename',
      { request: { workspaceId: '/repo', title: 'renamed' } },
      new AbortController().signal,
    )

    expect(mounted).toEqual(['workspace'])
    expect(result).toEqual({ renamed: { workspaceId: '/repo', title: 'renamed' } })
  })

  it('forwards a history call that nests the identifier under request.address', async () => {
    const { remote, calls } = mockRemote({
      session: {
        follow: () => (async function * () { yield { type: 'baseline' } })(),
      },
    })
    const values: unknown[] = []
    for await (const value of relay(remote).stream(
      'session/follow',
      { request: { address: { kind: 'session', sessionId: 's-2' }, activate: true } },
      new AbortController().signal,
    )) values.push(value)

    expect(values).toEqual([{ type: 'baseline' }])
    expect(calls[0]?.args[0]).toEqual({ address: { kind: 'session', sessionId: 's-2' }, activate: true })
  })
})

// ---------------------------------------------------------------------------
// 2 — relay failures: business codes survive, unreachable is ours
// ---------------------------------------------------------------------------
describe('t100637 / relay failure contract', () => {
  it('passes an upstream business code through untouched', async () => {
    const failure = new RemoteError('gateway/bad-request', 'upstream refused', {})
    const { remote } = mockRemote({ session: { cancel: async () => ({ ok: false, error: failure }) } })

    const error = await relay(remote).unary(
      'session/cancel',
      { request: { sessionId: 's-1' } },
      new AbortController().signal,
    ).catch((caught: unknown) => caught)

    expect(remoteErrorOf(error)?.code).toBe('gateway/bad-request')
    expect(error).toBe(failure)
  })

  it('maps a carrier failure to control-plane/instance-unreachable with the instance id', async () => {
    const carrier = new RemoteError('gateway/internal', 'client api: session/cancel failed: fetch failed', {})
    const { remote } = mockRemote({ session: { cancel: async () => ({ ok: false, error: carrier }) } })

    const error = await relay(remote, 'beta').unary(
      'session/cancel',
      { request: { sessionId: 's-1' } },
      new AbortController().signal,
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect(remoteErrorOf(error)?.code).toBe('control-plane/instance-unreachable')
    expect(remoteErrorOf(error)?.details).toEqual({ instanceId: 'beta', endpoint: 'session/cancel' })
    expect((error as Error).cause).toBe(carrier)
  })

  it('maps a stream carrier failure to instance-unreachable and releases the handle', async () => {
    let disposed = false
    const { remote } = mockRemote({
      session: {
        follow: () => {
          return {
            [Symbol.asyncIterator]: async function * () {
              throw new Error('socket closed')
            },
            dispose: () => { disposed = true },
          }
        },
      },
    })

    const error = await (async () => {
      for await (const _ of relay(remote, 'beta').stream('session/follow', { request: { address: { kind: 'session', sessionId: 's-1' } } }, new AbortController().signal)) {
        // never reached
      }
    })().catch((caught: unknown) => caught)

    expect(remoteErrorOf(error)?.code).toBe('control-plane/instance-unreachable')
    expect(disposed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3 — stream lifetime: downstream abort cancels the upstream iterator
// ---------------------------------------------------------------------------
describe('t100637 / stream cancellation', () => {
  it('cancels the upstream iterator when the caller aborts, with no pending work left', async () => {
    const controller = new AbortController()
    let upstreamAborted = false
    let opened = false
    let released = false
    const { remote } = mockRemote({
      session: {
        follow: (request: unknown, signal: AbortSignal) => {
          opened = true
          signal.addEventListener('abort', () => { upstreamAborted = true }, { once: true })
          const handle = {
            [Symbol.asyncIterator]: async function * () {
              try {
                yield { type: 'baseline', request }
                await new Promise<void>((resolve) => {
                  if (signal.aborted) resolve()
                  else signal.addEventListener('abort', () => { resolve() }, { once: true })
                })
              } finally {
                released = true
              }
            },
            dispose: () => {
              // The Client handle's own way of cancelling the logical stream.
              controller.abort()
            },
          }
          return handle
        },
      },
    })

    const stream = relay(remote).stream(
      'session/follow',
      { request: { address: { kind: 'session', sessionId: 's-1' } } },
      controller.signal,
    )
    const iterator = stream[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'baseline', request: { address: { kind: 'session', sessionId: 's-1' } } },
    })
    expect(opened).toBe(true)

    controller.abort()
    // The relay ends the generator quietly: the caller asked for the abort.
    const ended = await iterator.next()
    expect(ended.done).toBe(true)
    expect(upstreamAborted).toBe(true)
    expect(released).toBe(true)

    // A second abort/return must be harmless.
    await iterator.return?.(undefined)
    expect(released).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4 — Gateway → router → ControlPlane forwarder → upstream connection
// ---------------------------------------------------------------------------

/** One recorded forward the fake instance received. */
interface ForwardedCall {
  readonly endpoint: string
  readonly args: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
}

/**
 * A fake instance connection that records what the control plane forwarded.
 * Its probe succeeds and its stream yields one frame per call.
 */
function fakeInstance(id: string): {
  readonly connection: InstanceConnection
  readonly unary: ForwardedCall[]
  readonly stream: ForwardedCall[]
  readonly aborted: { value: boolean }
} {
  const unary: ForwardedCall[] = []
  const stream: ForwardedCall[] = []
  const aborted = { value: false }
  const connection: InstanceConnection = {
    reachability: 'connected',
    error: undefined,
    listSessions: async () => [],
    createSession: async () => `${id}-s`,
    onSessionStatus: () => () => {},
    async forwardUnary(endpoint, args, signal) {
      unary.push({ endpoint, args, signal })
      return { accepted: true, instanceId: id }
    },
    forwardStream(endpoint, args, signal) {
      stream.push({ endpoint, args, signal })
      return (async function * () {
        signal.addEventListener('abort', () => { aborted.value = true }, { once: true })
        yield { instanceId: id, endpoint }
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      })()
    },
    dispose: async () => {},
  }
  return { connection, unary, stream, aborted }
}

/** A Context the control plane can register its router on. */
function gatewayContext(): Context {
  const ctx = new Context()
  contexts.add(ctx)
  ctx.reflect.provide('remoteAccess', {
    decide: () => ({ kind: 'deny', reason: 'resource-invalid' }),
  })
  return ctx
}

/**
 * ControlPlane over a real Gateway, with its connection registry replaced by
 * fakes. The constructor's own effect never runs (it would dial the real
 * configured hosts), which is what the `effect` override is for.
 */
async function bench(connectionsFor: (instances: readonly ResolvedInstance[]) => InstanceConnections): Promise<{
  readonly ctx: Context
  readonly control: ControlPlane
  readonly gateway: TypertGateway
  readonly peer: Peer
  readonly connections: InstanceConnections
}> {
  const ctx = gatewayContext()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGatewayService)
  const facade = new Proxy(ctx, {
    get(target, property, receiver) {
      if (property === 'effect') return () => () => {}
      return Reflect.get(target, property, receiver) as unknown
    },
  })
  const control = new ControlPlane(facade, { instances: INSTANCES.map(instance => ({
    id: instance.id,
    name: instance.name,
    host: instance.host,
    port: instance.port,
  })) })
  const connections = connectionsFor(INSTANCES)
  ;(control as unknown as { connections: InstanceConnections }).connections = connections
  await connections.connect()
  return {
    ctx,
    control,
    gateway: ctx.typertGateway,
    peer: new Peer(ctx.root, { principal: { kind: 'owner' } }),
    connections,
  }
}

describe('t100637 / gateway → router → forwarder → instance', () => {
  it('forwards a unary read with the identifier stripped at its own route', async () => {
    const alpha = fakeInstance('alpha')
    const { gateway, peer } = await bench(instances => new InstanceConnections(instances, {
      open: async instance => instance.id === 'alpha' ? alpha.connection : fakeInstance(instance.id).connection,
    }))

    const value = await gateway.invoke({
      peer,
      namespace: 'session',
      method: 'cancel',
      args: { request: { sessionId: 'alpha:s-1' } },
    })

    expect(value).toEqual({ accepted: true, instanceId: 'alpha' })
    expect(alpha.unary).toHaveLength(1)
    expect(alpha.unary[0]?.endpoint).toBe('session/cancel')
    expect(alpha.unary[0]?.args).toEqual({ request: { sessionId: 's-1' } })
  })

  it('forwards a unary write whose identifier sits under request.workspaceId', async () => {
    const alpha = fakeInstance('alpha')
    const { gateway, peer } = await bench(instances => new InstanceConnections(instances, {
      open: async instance => instance.id === 'alpha' ? alpha.connection : fakeInstance(instance.id).connection,
    }))

    await gateway.invoke({
      peer,
      namespace: 'workspace',
      method: 'rename',
      args: { request: { workspaceId: 'alpha:/repo', title: 'renamed' } },
    })

    expect(alpha.unary[0]?.args).toEqual({ request: { workspaceId: '/repo', title: 'renamed' } })
  })

  it('forwards a stream and keeps sibling arguments intact', async () => {
    const alpha = fakeInstance('alpha')
    const { gateway, peer } = await bench(instances => new InstanceConnections(instances, {
      open: async instance => instance.id === 'alpha' ? alpha.connection : fakeInstance(instance.id).connection,
    }))

    const values: unknown[] = []
    const stream = await gateway.stream({
      peer,
      namespace: 'session',
      method: 'follow',
      args: { request: { address: { kind: 'session', sessionId: 'alpha:s-1' }, activate: true } },
    })
    for await (const value of stream) {
      values.push(value)
      break
    }

    expect(values).toEqual([{ instanceId: 'alpha', endpoint: 'session/follow' }])
    expect(alpha.stream[0]?.args).toEqual({
      request: { address: { kind: 'session', sessionId: 's-1' }, activate: true },
    })
  })

  it('aborts the upstream stream when the downstream call is aborted', async () => {
    const alpha = fakeInstance('alpha')
    const { gateway, peer } = await bench(instances => new InstanceConnections(instances, {
      open: async instance => instance.id === 'alpha' ? alpha.connection : fakeInstance(instance.id).connection,
    }))
    const control = new AbortController()

    const stream = await gateway.stream({
      peer,
      namespace: 'session',
      method: 'follow',
      args: { request: { address: { kind: 'session', sessionId: 'alpha:s-1' } } },
      signal: control.signal,
    })
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()
    control.abort()
    // The federated iterable owns cancellation: ending quietly is the caller's
    // own abort coming back, so there is no error frame to send.
    const ended = await iterator.next()
    expect(ended.done).toBe(true)
    expect(alpha.aborted.value).toBe(true)
    expect(alpha.stream[0]?.signal.aborted).toBe(true)
  })

  it('refuses a call to an instance that never connected, without dialling out', async () => {
    const { gateway, peer } = await bench(instances => new InstanceConnections(instances, {
      open: async () => { throw new Error('fixture: no instance may be dialled') },
    }))

    const error = await gateway.invoke({
      peer,
      namespace: 'session',
      method: 'cancel',
      args: { request: { sessionId: 'alpha:s-1' } },
    }).catch((caught: unknown) => caught)

    expect(remoteErrorOf(error)?.code).toBe('control-plane/instance-unreachable')
    expect(remoteErrorOf(error)?.details).toMatchObject({ instanceId: 'alpha', endpoint: 'session/cancel' })
  })

  it('refuses a stream to an unreachable instance before any carrier work', async () => {
    const alpha = fakeInstance('alpha')
    const { gateway, peer } = await bench(instances => new InstanceConnections(instances, {
      open: async instance => instance.id === 'alpha' ? alpha.connection : fakeInstance(instance.id).connection,
    }))
    // The probe failed, so the instance is mounted but reported unreachable.
    Object.defineProperty(alpha.connection, 'reachability', { get: () => 'unreachable' })

    const error = await gateway.stream({
      peer,
      namespace: 'session',
      method: 'follow',
      args: { request: { address: { kind: 'session', sessionId: 'alpha:s-1' } } },
    }).catch((caught: unknown) => caught)

    expect(remoteErrorOf(error)?.code).toBe('control-plane/instance-unreachable')
    expect(alpha.stream).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 5 — a descriptor this build does not know is refused, never mis-forwarded
// ---------------------------------------------------------------------------
describe('t100637 / unsupported endpoint', () => {
  it('keeps an endpoint without a declared identifier local instead of guessing', async () => {
    const alpha = fakeInstance('alpha')
    const { gateway, peer } = await bench(instances => new InstanceConnections(instances, {
      open: async instance => instance.id === 'alpha' ? alpha.connection : fakeInstance(instance.id).connection,
    }))

    // `session/list` names no instance; on a Host that mounts no descriptor it
    // must fail as a local method rather than route somewhere arbitrary.
    const error = await gateway.invoke({
      peer,
      namespace: 'session',
      method: 'list',
      args: { _request: { cursor: 'alpha:1' } },
    }).catch((caught: unknown) => caught)

    expect(remoteErrorOf(error)?.code).not.toBe('control-plane/instance-unreachable')
    expect(alpha.unary).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 6 — several instance-qualified identifiers in one request
// ---------------------------------------------------------------------------

describe('t100637 / multi-identifier routing', () => {
  const alphaOrBeta = (id: string): boolean => id === 'alpha' || id === 'beta'

  it('strips both ids on session/create when they name the same instance', () => {
    const args = {
      request: { workspaceId: 'alpha:/repo', sessionId: 'alpha:s-1', agentPreset: 'p' },
    }
    const target = resolveFederationTarget('session/create', args, alphaOrBeta)

    expect(target).toEqual({
      instanceId: 'alpha',
      endpoint: 'session/create',
      args: { request: { workspaceId: '/repo', sessionId: 's-1', agentPreset: 'p' } },
    })
    // The caller's record is never mutated.
    expect(args.request).toEqual({ workspaceId: 'alpha:/repo', sessionId: 'alpha:s-1', agentPreset: 'p' })
  })

  it('strips workspaceId and beforeWorkspaceId on workspace/insertBefore', () => {
    expect(resolveFederationTarget(
      'workspace/insertBefore',
      { request: { workspaceId: 'alpha:/repo', beforeWorkspaceId: 'alpha:/other' } },
      alphaOrBeta,
    )?.args).toEqual({ request: { workspaceId: '/repo', beforeWorkspaceId: '/other' } })
  })

  it('strips all three ids on workspace/insertSessionBefore', () => {
    expect(resolveFederationTarget(
      'workspace/insertSessionBefore',
      { request: { workspaceId: 'alpha:/repo', sessionId: 'alpha:s-1', beforeSessionId: 'alpha:s-2' } },
      alphaOrBeta,
    )?.args).toEqual({ request: { workspaceId: '/repo', sessionId: 's-1', beforeSessionId: 's-2' } })
  })

  it('refuses a request whose identifiers name different instances', () => {
    expect(resolveFederationTarget(
      'session/create',
      { request: { workspaceId: 'alpha:/repo', sessionId: 'beta:s-1' } },
      alphaOrBeta,
    )).toBeUndefined()
    expect(resolveFederationTarget(
      'workspace/insertSessionBefore',
      { request: { workspaceId: 'alpha:/repo', sessionId: 'alpha:s-1', beforeSessionId: 'beta:s-2' } },
      alphaOrBeta,
    )).toBeUndefined()
  })

  it('keeps an unprefixed sibling identifier untouched', () => {
    expect(resolveFederationTarget(
      'session/create',
      { request: { workspaceId: 'alpha:/repo', sessionId: 's-1' } },
      alphaOrBeta,
    )?.args).toEqual({ request: { workspaceId: '/repo', sessionId: 's-1' } })
  })

  it('strips a subagent address on every endpoint that carries one', () => {
    for (const endpoint of ['session/events', 'session/follow', 'session/observeEvent', 'session/page']) {
      const args = {
        request: {
          address: { kind: 'subagent', parentSessionId: 'alpha:p', childSessionId: 'alpha:c' },
          throughSeq: 7,
        },
      }
      const target = resolveFederationTarget(endpoint, args, alphaOrBeta)
      expect(target, endpoint).toEqual({
        instanceId: 'alpha',
        endpoint,
        args: {
          request: {
            address: { kind: 'subagent', parentSessionId: 'p', childSessionId: 'c' },
            throughSeq: 7,
          },
        },
      })
    }
  })

  it('refuses a subagent address that spans two instances', () => {
    expect(resolveFederationTarget(
      'session/events',
      { request: { address: { kind: 'subagent', parentSessionId: 'alpha:p', childSessionId: 'beta:c' } } },
      alphaOrBeta,
    )).toBeUndefined()
  })

  it('never routes an endpoint outside the identifier table', () => {
    for (const endpoint of ['session/list', 'workspace/read', 'session/xxx']) {
      expect(isFederatedEndpoint(endpoint), endpoint).toBe(false)
      expect(resolveFederationTarget(endpoint, { sessionId: 'alpha:s-1', workspaceId: 'alpha:/repo' }, () => true), endpoint)
        .toBeUndefined()
    }
    // An endpoint in the table still routes.
    expect(isFederatedEndpoint('session/cancel')).toBe(true)
  })

  it('keeps a table endpoint local when no declared identifier is prefixed', () => {
    expect(resolveFederationTarget('session/cancel', { request: { sessionId: 's-1' } }, () => true)).toBeUndefined()
    expect(resolveFederationTarget('session/create', { request: {} }, () => true)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 7 — a failed lazy workspace mount is retryable
// ---------------------------------------------------------------------------

type UpstreamConstructor = new (instance: ResolvedInstance, root: Context) => Upstream

/**
 * A minimal Upstream root: only `remote.$mount` and the lazily mounted
 * `workspace` namespace matter here. The real generated contribution is still
 * what gets mounted, so the relay resolves the real descriptor afterwards.
 */
function mountRoot(failFirst: boolean): {
  readonly root: Context
  readonly attempts: () => number
  readonly received: unknown[]
} {
  let attempts = 0
  const received: unknown[] = []
  const remote = {
    $mount: async (contribution: unknown) => {
      attempts += 1
      if (failFirst && attempts === 1) throw new Error('mount exploded')
      void contribution
      return async () => {}
    },
    workspace: {
      rename: async (request: unknown) => {
        received.push(request)
        return { ok: true, value: { renamed: request } }
      },
    },
  }
  return { root: { remote } as unknown as Context, attempts: () => attempts, received }
}

describe('t100637 / lazy workspace mount retry', () => {
  it('retries after a failed mount instead of caching the rejection', async () => {
    const fake = mountRoot(true)
    const upstream = new (Upstream as unknown as UpstreamConstructor)(INSTANCES[0] as ResolvedInstance, fake.root)
    const signal = new AbortController().signal

    await expect(upstream.forwardUnary(
      'workspace/rename',
      { request: { workspaceId: '/repo', title: 'one' } },
      signal,
    )).rejects.toThrow('mount exploded')

    await expect(upstream.forwardUnary(
      'workspace/rename',
      { request: { workspaceId: '/repo', title: 'two' } },
      signal,
    )).resolves.toEqual({ renamed: { workspaceId: '/repo', title: 'two' } })
    expect(fake.attempts()).toBe(2)
    expect(fake.received).toEqual([{ workspaceId: '/repo', title: 'two' }])

    // Once mounted, later calls do not mount again.
    await upstream.forwardUnary(
      'workspace/rename',
      { request: { workspaceId: '/repo', title: 'three' } },
      signal,
    )
    expect(fake.attempts()).toBe(2)
  })

  it('shares one in-flight mount between concurrent first forwards', async () => {
    const fake = mountRoot(false)
    const upstream = new (Upstream as unknown as UpstreamConstructor)(INSTANCES[0] as ResolvedInstance, fake.root)
    const signal = new AbortController().signal

    await Promise.all([
      upstream.forwardUnary('workspace/rename', { request: { workspaceId: '/repo', title: 'a' } }, signal),
      upstream.forwardUnary('workspace/rename', { request: { workspaceId: '/repo', title: 'b' } }, signal),
    ])
    expect(fake.attempts()).toBe(1)
    expect(fake.received).toHaveLength(2)
  })
})
