/**
 * Independent tester verification of t100637 (real cross-instance forwarding).
 *
 * This file deliberately does not reuse `t100637-verify.spec.ts`: it derives the
 * endpoint wire shapes from the **real generated descriptors** instead of a
 * hand-written list, then drives the real Gateway and the real ControlPlane
 * forwarder over a real `RemoteRelay` with one fake upstream Client.
 *
 * Sections:
 * 1. descriptor/table inventory diff and per-endpoint prefix stripping,
 *    including every coexisting instance-qualified id and subagent addresses;
 * 2. real Gateway unary read/write and stream calls through the relay;
 * 3. unreachable instances (never connected, mounted-but-unreachable);
 * 4. downstream abort and handle release;
 * 5. business error pass-through vs `gateway/internal` mapping;
 * 6. local calls must never fall back to forwarding;
 * 7. lazy `workspace` namespace mount (single flight, retry after failure);
 * 8. endpoints that carry more than one instance-qualified id;
 * 9. endpoint-only admission: no namespace-wide fallback for unknown endpoints.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  type TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { ResolvedInstance } from '../src/config.ts'
import { InstanceConnections, type InstanceConnection } from '../src/connections.ts'
import { ControlPlane, RemoteRelay, Upstream } from '../src/index.ts'

const INSTANCES: readonly ResolvedInstance[] = [
  { id: 'alpha', name: 'Alpha', host: '127.0.0.1', port: 1, baseUrl: 'http://127.0.0.1:1' },
  { id: 'beta', name: 'Beta', host: '127.0.0.1', port: 2, baseUrl: 'http://127.0.0.1:2' },
]

const ALPHA = INSTANCES[0] as ResolvedInstance

/** Every real descriptor a federated call can name. */
const DESCRIPTORS: readonly InvocationDescriptor[] = [
  ...SessionRemote.default.descriptors,
  ...WorkspaceRemote.default.descriptors,
]

function descriptorOf(endpoint: string): InvocationDescriptor | undefined {
  return DESCRIPTORS.find(candidate => `${candidate.namespace}/${candidate.method}` === endpoint)
}

const contexts: Context[] = []
const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

// ---------------------------------------------------------------------------
// 0 — descriptor-derived identifier inventory
// ---------------------------------------------------------------------------

/** The JSON-Schema subset the generated codecs emit. */
interface SchemaNode {
  readonly properties?: Record<string, SchemaNode>
  readonly items?: SchemaNode
  readonly oneOf?: readonly SchemaNode[]
  readonly anyOf?: readonly SchemaNode[]
  readonly allOf?: readonly SchemaNode[]
}

/** One key path a descriptor declares from a parameter wire root to an id. */
type IdPath = readonly string[]

/** Whether a property name is an instance-qualified identifier field. */
type IdNameTest = (name: string) => boolean

/** Every id the browser qualifies: primary ids, neighbours, and address ids. */
const ANY_ID: IdNameTest = name => /(?:session|workspace)Id$/i.test(name)

function collectIdPaths(
  schema: SchemaNode | undefined,
  path: IdPath,
  names: IdNameTest,
  out: IdPath[],
  seen: Set<SchemaNode>,
): void {
  if (schema === undefined || typeof schema !== 'object' || seen.has(schema)) return
  seen.add(schema)
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const next = [...path, key]
    if (names(key)) out.push(next)
    collectIdPaths(child, next, names, out, seen)
  }
  if (schema.items !== undefined) collectIdPaths(schema.items, [...path, '[]'], names, out, seen)
  for (const branch of [...schema.oneOf ?? [], ...schema.anyOf ?? [], ...schema.allOf ?? []]) {
    collectIdPaths(branch, path, names, out, seen)
  }
}

/** Identifier paths one real descriptor declares, keyed under each parameter wire. */
function descriptorIdPaths(descriptor: InvocationDescriptor, names: IdNameTest): IdPath[] {
  const out: IdPath[] = []
  for (const parameter of descriptor.parameters) {
    const schema = (parameter.codec as { readonly jsonSchema?: unknown }).jsonSchema as SchemaNode | undefined
    collectIdPaths(schema, [parameter.wire], names, out, new Set())
  }
  const unique = new Map(out.map(path => [JSON.stringify(path), path]))
  return [...unique.values()]
}

/**
 * Parse one identifier table out of the shipped source.
 *
 * The tables are module-private, so the only way to compare them against the
 * real descriptors is to read the declarations themselves. The shape is
 * deliberately narrow (an endpoint string plus a list of string paths — the
 * neighbour/address tables wrap one entry per line), and the parser asserts the
 * boundaries it relies on.
 */
function pathTableFromSource(name: string): Map<string, IdPath[]> {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../api/gateway/src/federation.ts'),
    'utf8',
  )
  const start = source.indexOf(`const ${name}`)
  expect(start, `federation.ts must declare ${name}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n])', start)
  expect(end, `${name} must close`).toBeGreaterThan(start)
  const table = new Map<string, IdPath[]>()
  for (const entry of source.slice(start, end).matchAll(/\['([^']+\/[^']*)',\s*(\[(?:[^\[\]]|\[[^\[\]]*\])*\])\]/g)) {
    const paths = [...entry[2]!.matchAll(/\[([^\[\]]+)\]/g)].map(match =>
      [...match[1]!.matchAll(/'([^']+)'/g)].map(quoted => quoted[1]!))
    table.set(entry[1]!, paths)
  }
  return table
}

/**
 * The full routing contract: the primary table plus the extra identifiers the
 * same endpoints also carry. `identifierPaths()` serves exactly this union.
 */
function contractTableFromSource(): Map<string, IdPath[]> {
  const merged = new Map<string, IdPath[]>()
  for (const [endpoint, paths] of pathTableFromSource('IDENTIFIER_PATHS_BY_ENDPOINT')) {
    merged.set(endpoint, [...paths])
  }
  for (const [endpoint, paths] of pathTableFromSource('EXTRA_IDENTIFIER_PATHS_BY_ENDPOINT')) {
    merged.set(endpoint, [...(merged.get(endpoint) ?? []), ...paths])
  }
  return merged
}

/** Real federated endpoints that declare at least one id field. */
function expectedIdPaths(names: IdNameTest): Map<string, IdPath[]> {
  const expected = new Map<string, IdPath[]>()
  for (const descriptor of DESCRIPTORS) {
    if (descriptor.namespace !== 'session' && descriptor.namespace !== 'workspace') continue
    const endpoint = `${descriptor.namespace}/${descriptor.method}`
    const paths = descriptorIdPaths(descriptor, names)
    if (paths.length > 0) expected.set(endpoint, paths)
  }
  return expected
}

function valueAt(args: Readonly<Record<string, unknown>>, path: IdPath): unknown {
  let current: unknown = args
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** Build wire args for one identifier path, with markers on every routing object. */
function argsAt(path: IdPath, value: string): Record<string, unknown> {
  const root: Record<string, unknown> = { __rootSibling: 'keep' }
  let cursor = root
  for (const key of path.slice(0, -1)) {
    const next: Record<string, unknown> = { __sibling: 'keep' }
    cursor[key] = next
    cursor = next
  }
  cursor[path[path.length - 1]!] = value
  return root
}

/** Minimal wire arguments a generated Client sends for a descriptor with no id. */
function emptyWireArgs(descriptor: InvocationDescriptor): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const parameter of descriptor.parameters) args[parameter.wire] = {}
  return args
}

/** A subagent address naming both sides of the delegation on one instance. */
function subagentAddress(prefix: string): Record<string, unknown> {
  return {
    kind: 'subagent',
    sessionId: `${prefix}:s-1`,
    parentSessionId: `${prefix}:p-1`,
    childSessionId: `${prefix}:c-1`,
    mode: 'one-shot',
  }
}

describe('t100637 / descriptor vs identifier tables', () => {
  it('lists exactly the real endpoints that declare an instance-qualified id (25/25)', () => {
    const table = contractTableFromSource()
    const expected = expectedIdPaths(ANY_ID)

    // Reports the concrete mismatches instead of a bare count.
    const missing = [...expected.keys()].filter(endpoint => !table.has(endpoint))
    const stale = [...table.keys()].filter(endpoint => !expected.has(endpoint))
    expect({ missing, stale }).toEqual({ missing: [], stale: [] })
    expect(table.size, 'declared endpoints').toBe(25)
    expect(table.size).toBe(expected.size)

    for (const [endpoint, paths] of expected) {
      expect(table.get(endpoint), `${endpoint} declared paths`).toEqual(paths)
      expect(isFederatedEndpoint(endpoint)).toBe(true)
    }
  })

  it('strips the prefix at every declared path of every endpoint, mutating nothing', () => {
    const expected = expectedIdPaths(ANY_ID)
    let checked = 0
    for (const [endpoint, paths] of expected) {
      for (const path of paths) {
        const args = argsAt(path, 'alpha:local-1')
        const target = resolveFederationTarget(endpoint, args, id => id === 'alpha')
        const label = `${endpoint} via ${path.join('.')}`
        expect(target, label).toBeDefined()
        expect(target?.instanceId, label).toBe('alpha')
        expect(target?.endpoint, label).toBe(endpoint)
        expect(valueAt(target!.args, path), label).toBe('local-1')
        // The input record is never mutated.
        expect(valueAt(args, path), label).toBe('alpha:local-1')
        // Sibling objects on the route keep their identity and values.
        expect(target!.args.__rootSibling, label).toBe('keep')
        if (path[0] === 'request') {
          expect((target!.args.request as Record<string, unknown>).__sibling, label).toBe('keep')
        }
        checked += 1
      }
    }
    // 25 endpoints; the neighbour and address endpoints declare more than one
    // path each (26 session paths + 11 workspace paths).
    expect(checked).toBe(37)
  })

  it('keeps every real endpoint with no id field local for its well-formed wire args', () => {
    for (const descriptor of DESCRIPTORS) {
      if (descriptor.namespace !== 'session' && descriptor.namespace !== 'workspace') continue
      const endpoint = `${descriptor.namespace}/${descriptor.method}`
      if (descriptorIdPaths(descriptor, ANY_ID).length > 0) continue
      expect(isFederatedEndpoint(endpoint), endpoint).toBe(false)
      expect(resolveFederationTarget(endpoint, emptyWireArgs(descriptor), () => true), endpoint).toBeUndefined()
    }
  })

  it('declares every coexisting identifier the real descriptors can carry', () => {
    // These are descriptor facts: one real request can carry all of them at
    // once, and the browser qualifies every one with the owning instance.
    expect(descriptorIdPaths(descriptorOf('session/create')!, ANY_ID)).toEqual([
      ['request', 'workspaceId'],
      ['request', 'sessionId'],
    ])
    expect(descriptorIdPaths(descriptorOf('workspace/insertBefore')!, ANY_ID)).toEqual([
      ['request', 'workspaceId'],
      ['request', 'beforeWorkspaceId'],
    ])
    expect(descriptorIdPaths(descriptorOf('workspace/insertSessionBefore')!, ANY_ID)).toEqual([
      ['request', 'workspaceId'],
      ['request', 'sessionId'],
      ['request', 'beforeSessionId'],
    ])
    const addressEndpoints = ['session/events', 'session/follow', 'session/observeEvent', 'session/page']
    for (const endpoint of addressEndpoints) {
      expect(descriptorIdPaths(descriptorOf(endpoint)!, ANY_ID), endpoint).toEqual([
        ['request', 'address', 'sessionId'],
        ['request', 'address', 'parentSessionId'],
        ['request', 'address', 'childSessionId'],
      ])
    }
    // ...and the shipped contract table lists every one of them.
    const table = contractTableFromSource()
    for (const endpoint of [
      'session/create',
      'workspace/insertBefore',
      'workspace/insertSessionBefore',
      ...addressEndpoints,
    ]) {
      expect(table.get(endpoint), endpoint).toEqual(descriptorIdPaths(descriptorOf(endpoint)!, ANY_ID))
    }
  })

  it('strips a same-instance subagent address, parent and child together', () => {
    for (const endpoint of ['session/events', 'session/follow', 'session/observeEvent', 'session/page']) {
      const args = { request: { address: subagentAddress('alpha'), throughSeq: 3 } }
      const target = resolveFederationTarget(endpoint, args, id => id === 'alpha')
      expect(target, endpoint).toBeDefined()
      expect(target?.instanceId, endpoint).toBe('alpha')
      expect(target?.args, endpoint).toEqual({
        request: {
          address: {
            kind: 'subagent',
            sessionId: 's-1',
            parentSessionId: 'p-1',
            childSessionId: 'c-1',
            mode: 'one-shot',
          },
          throughSeq: 3,
        },
      })
      // The caller's record is untouched.
      expect(args.request.address.childSessionId, endpoint).toBe('alpha:c-1')
    }
    // A delegation-only address (no primary sessionId) routes on its pair too.
    const delegationOnly = resolveFederationTarget(
      'session/page',
      { request: { address: { kind: 'subagent', parentSessionId: 'alpha:p-1', childSessionId: 'alpha:c-1' } } },
      () => true,
    )
    expect(delegationOnly?.args).toEqual({
      request: { address: { kind: 'subagent', parentSessionId: 'p-1', childSessionId: 'c-1' } },
    })
  })

  it('refuses a subagent address whose parent and child live on different instances', () => {
    const args = {
      request: {
        address: { kind: 'subagent', parentSessionId: 'alpha:p-1', childSessionId: 'beta:c-1' },
      },
    }
    expect(resolveFederationTarget('session/page', args, () => true)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 1 — fake upstream Client + real relay + real Gateway + real ControlPlane
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly endpoint: string
  readonly args: readonly unknown[]
  readonly signal: AbortSignal | undefined
}

interface FakeClient {
  remote: Record<string, unknown>
  readonly unary: RecordedCall[]
  readonly streams: RecordedCall[]
  readonly errors: Map<string, RemoteError>
  readonly persistent: Set<string>
  readonly closed: Map<string, boolean>
  readonly disposeEffects: Map<string, number>
}

/**
 * A fake generated Client namespace root.
 *
 * Unary members answer with the same `{ ok, value }` envelope the generated
 * Client produces; stream members return an async iterable with a `dispose()`
 * that mirrors the real `ClientStreamHandle` contract (idempotent).
 */
function fakeClient(): FakeClient {
  const unary: RecordedCall[] = []
  const streams: RecordedCall[] = []
  const errors = new Map<string, RemoteError>()
  const persistent = new Set<string>()
  const closed = new Map<string, boolean>()
  const disposeEffects = new Map<string, number>()

  const unaryMethod = (endpoint: string) => (...args: unknown[]) => {
    unary.push({ endpoint, args, signal: undefined })
    const failure = errors.get(endpoint)
    if (failure !== undefined) return { ok: false, error: failure }
    return { ok: true, value: { endpoint, received: args[0] } }
  }

  const streamMethod = (endpoint: string) => (request: unknown, signal?: AbortSignal) => {
    const call: RecordedCall = { endpoint, args: [request], signal }
    streams.push(call)
    let release: (() => void) | undefined
    const wait = new Promise<void>((resolve) => { release = resolve })
    let disposed = false
    return {
      [Symbol.asyncIterator]: async function * () {
        try {
          yield { endpoint, received: request }
          if (persistent.has(endpoint)) await wait
        } finally {
          closed.set(endpoint, true)
          release?.()
        }
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        disposeEffects.set(endpoint, (disposeEffects.get(endpoint) ?? 0) + 1)
        release?.()
      },
    }
  }

  const session = {
    cancel: unaryMethod('session/cancel'),
    projections: unaryMethod('session/projections'),
    rename: unaryMethod('session/rename'),
    prompt: unaryMethod('session/prompt'),
    create: unaryMethod('session/create'),
    page: unaryMethod('session/page'),
    events: unaryMethod('session/events'),
    follow: streamMethod('session/follow'),
    observeEvent: streamMethod('session/observeEvent'),
  }
  const workspace = {
    rename: unaryMethod('workspace/rename'),
    insertBefore: unaryMethod('workspace/insertBefore'),
    insertSessionBefore: unaryMethod('workspace/insertSessionBefore'),
  }
  return {
    remote: { session, workspace },
    unary,
    streams,
    errors,
    persistent,
    closed,
    disposeEffects,
  }
}

/** How many times the ControlPlane forwarder entered one instance connection. */
interface ForwardCounts {
  unary: number
  stream: number
}

function forwardCounts(): Map<string, ForwardCounts> {
  return new Map([
    ['alpha', { unary: 0, stream: 0 }],
    ['beta', { unary: 0, stream: 0 }],
  ])
}

/** One connection whose `forward*` is the real relay over a fake Client. */
function relayConnection(id: string, fake: FakeClient, counts?: ForwardCounts): InstanceConnection {
  const relay = new RemoteRelay({
    instanceId: id,
    remote: () => fake.remote,
    descriptor: endpoint => descriptorOf(endpoint),
    mount: async () => {},
  })
  return {
    reachability: 'connected',
    error: undefined,
    listSessions: async () => [],
    createSession: async () => `${id}-session`,
    onSessionStatus: () => () => {},
    forwardUnary: async (endpoint, args, signal) => {
      if (counts !== undefined) counts.unary += 1
      return await relay.unary(endpoint, args, signal)
    },
    forwardStream: (endpoint, args, signal) => {
      if (counts !== undefined) counts.stream += 1
      return relay.stream(endpoint, args, signal)
    },
    dispose: async () => {},
  }
}

function connectionFactory(
  fakes: Map<string, FakeClient>,
  counts?: Map<string, ForwardCounts>,
): InstanceConnections {
  return new InstanceConnections(INSTANCES, {
    open: async (instance) => {
      const fake = fakes.get(instance.id)
      if (fake === undefined) throw new Error(`fixture: unexpected open(${instance.id})`)
      return relayConnection(instance.id, fake, counts?.get(instance.id))
    },
  })
}

function gatewayContext(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.reflect.provide('remoteAccess', { decide: () => ({ kind: 'deny', reason: 'resource-invalid' }) })
  return ctx
}

/**
 * Real Gateway + real ControlPlane over a supplied connection registry.
 *
 * The constructor's own `effect` would dial the configured hosts; the proxy
 * replaces only that hook so the test owns the connection registry.
 */
async function bench(connections: InstanceConnections, connect = true): Promise<{
  readonly ctx: Context
  readonly control: ControlPlane
  readonly gateway: TypertGateway
  readonly peer: Peer
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
  const control = new ControlPlane(facade, {
    instances: INSTANCES.map(({ id, name, host, port }) => ({ id, name, host, port })),
  })
  ;(control as unknown as { connections: InstanceConnections }).connections = connections
  disposers.push(async () => { await control.dispose() })
  if (connect) await connections.connect()
  return { ctx, control, gateway: ctx.typertGateway, peer: new Peer(ctx.root, { principal: { kind: 'owner' } }) }
}

async function firstItem(stream: AsyncIterable<unknown>): Promise<unknown> {
  for await (const value of stream) return value
  return undefined
}

function errorCode(error: unknown): string | undefined {
  const remote = remoteErrorOf(error)
  if (remote !== undefined) return remote.code
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

// ---------------------------------------------------------------------------
// 2 — three real link kinds, end to end
// ---------------------------------------------------------------------------

describe('t100637 / real Gateway → ControlPlane → relay → fake Client', () => {
  it('forwards unary reads (cancel, projections) with the prefix stripped in place', async () => {
    const alpha = fakeClient()
    const { gateway, peer } = await bench(connectionFactory(new Map([['alpha', alpha], ['beta', fakeClient()]])))

    const cancel = await gateway.invoke({
      peer,
      namespace: 'session',
      method: 'cancel',
      args: { request: { sessionId: 'alpha:s-1' } },
    })
    expect(cancel).toEqual({ endpoint: 'session/cancel', received: { sessionId: 's-1' } })

    const projections = await gateway.invoke({
      peer,
      namespace: 'session',
      method: 'projections',
      args: { request: { sessionId: 'alpha:s-1', kinds: ['state'], cursor: 'cursor-9' } },
    })
    expect(projections).toEqual({
      endpoint: 'session/projections',
      received: { sessionId: 's-1', kinds: ['state'], cursor: 'cursor-9' },
    })
    // `projections` declares cancellation, so the relay's signal is the second
    // positional argument; the business argument is unchanged.
    expect(alpha.unary.map(call => call.endpoint)).toEqual(['session/cancel', 'session/projections'])
    expect(alpha.unary[0]?.args).toHaveLength(1)
    expect(alpha.unary[1]?.args).toHaveLength(2)
    expect(alpha.unary[1]?.args[1]).toBeInstanceOf(AbortSignal)
  })

  it('forwards unary writes (rename, prompt, workspace rename) keeping sibling fields', async () => {
    const alpha = fakeClient()
    const { gateway, peer } = await bench(connectionFactory(new Map([['alpha', alpha], ['beta', fakeClient()]])))

    await gateway.invoke({
      peer,
      namespace: 'session',
      method: 'rename',
      args: { request: { sessionId: 'alpha:s-1', title: 'Renamed' } },
    })
    await gateway.invoke({
      peer,
      namespace: 'session',
      method: 'prompt',
      args: {
        request: {
          sessionId: 'alpha:s-1',
          content: [{ type: 'text', text: 'hello' }],
          attachments: ['file-1'],
          model: 'm-1',
        },
      },
    })
    await gateway.invoke({
      peer,
      namespace: 'workspace',
      method: 'rename',
      args: { request: { workspaceId: 'alpha:/repo', title: 'Workspace' } },
    })

    expect(alpha.unary[0]?.args[0]).toEqual({ sessionId: 's-1', title: 'Renamed' })
    expect(alpha.unary[1]?.args[0]).toEqual({
      sessionId: 's-1',
      content: [{ type: 'text', text: 'hello' }],
      attachments: ['file-1'],
      model: 'm-1',
    })
    expect(alpha.unary[2]?.args[0]).toEqual({ workspaceId: '/repo', title: 'Workspace' })
  })

  it('forwards streams (follow, observeEvent) keeping address and history siblings', async () => {
    const alpha = fakeClient()
    const { gateway, peer } = await bench(connectionFactory(new Map([['alpha', alpha], ['beta', fakeClient()]])))

    const follow = await gateway.stream({
      peer,
      namespace: 'session',
      method: 'follow',
      args: { request: { address: { kind: 'session', sessionId: 'alpha:s-1' }, activate: true } },
    })
    expect(await firstItem(follow)).toEqual({
      endpoint: 'session/follow',
      received: { address: { kind: 'session', sessionId: 's-1' }, activate: true },
    })

    const events = await gateway.stream({
      peer,
      namespace: 'session',
      method: 'observeEvent',
      args: {
        request: {
          address: { kind: 'session', sessionId: 'alpha:s-1' },
          throughSeq: 7,
          maxMessages: 10,
        },
      },
    })
    expect(await firstItem(events)).toEqual({
      endpoint: 'session/observeEvent',
      received: { address: { kind: 'session', sessionId: 's-1' }, throughSeq: 7, maxMessages: 10 },
    })

    expect(alpha.streams.map(call => call.endpoint)).toEqual(['session/follow', 'session/observeEvent'])
    expect(alpha.streams[0]?.args[0]).toEqual({ address: { kind: 'session', sessionId: 's-1' }, activate: true })
    expect(alpha.streams[1]?.args[0]).toEqual({
      address: { kind: 'session', sessionId: 's-1' },
      throughSeq: 7,
      maxMessages: 10,
    })
  })
})

// ---------------------------------------------------------------------------
// 3 — unreachable: never connected, and mounted-but-unreachable
// ---------------------------------------------------------------------------

function unreachableConnection(probes: { forward: number; stream: number }): InstanceConnection {
  return {
    reachability: 'unreachable',
    error: 'probe failed',
    listSessions: async () => { throw new Error('probe failed') },
    createSession: async () => { throw new Error('probe failed') },
    onSessionStatus: () => () => {},
    forwardUnary: async () => {
      probes.forward += 1
      throw new Error('fixture: forwardUnary must not run on an unreachable instance')
    },
    forwardStream: () => {
      probes.stream += 1
      throw new Error('fixture: forwardStream must not run on an unreachable instance')
    },
    dispose: async () => {},
  }
}

describe('t100637 / unreachable instances', () => {
  it('refuses an instance that never connected without opening a connection', async () => {
    let opens = 0
    const connections = new InstanceConnections(INSTANCES, {
      open: async () => {
        opens += 1
        throw new Error('fixture: no instance may be dialled')
      },
    })
    const { gateway, peer } = await bench(connections, false)

    const unary = await gateway.invoke({
      peer,
      namespace: 'session',
      method: 'cancel',
      args: { request: { sessionId: 'alpha:s-1' } },
    }).catch((caught: unknown) => caught)

    expect(errorCode(unary)).toBe('control-plane/instance-unreachable')
    expect(remoteErrorOf(unary)?.details).toMatchObject({ instanceId: 'alpha', endpoint: 'session/cancel' })
    expect(opens).toBe(0)

    const stream = await gateway.stream({
      peer,
      namespace: 'session',
      method: 'follow',
      args: { request: { address: { kind: 'session', sessionId: 'alpha:s-1' } } },
    }).catch((caught: unknown) => caught)

    expect(errorCode(stream)).toBe('control-plane/instance-unreachable')
    expect(remoteErrorOf(stream)?.details).toMatchObject({ instanceId: 'alpha', endpoint: 'session/follow' })
    expect(opens).toBe(0)
  })

  it('refuses a mounted-but-unreachable instance without a new connection or carrier call', async () => {
    const probes = { forward: 0, stream: 0 }
    let opens = 0
    const connections = new InstanceConnections(INSTANCES, {
      open: async () => {
        opens += 1
        return unreachableConnection(probes)
      },
    })
    const { gateway, peer } = await bench(connections)
    // Both configured instances mounted during connect(); the probe failed.
    expect(connections.states()).toMatchObject({
      alpha: { state: 'unreachable' },
      beta: { state: 'unreachable' },
    })
    const opensBefore = opens

    const error = await gateway.invoke({
      peer,
      namespace: 'session',
      method: 'cancel',
      args: { request: { sessionId: 'alpha:s-1' } },
    }).catch((caught: unknown) => caught)

    expect(errorCode(error)).toBe('control-plane/instance-unreachable')
    expect(remoteErrorOf(error)?.details).toEqual({ instanceId: 'alpha', endpoint: 'session/cancel' })
    expect(opens).toBe(opensBefore)
    expect(probes).toEqual({ forward: 0, stream: 0 })
  })
})

// ---------------------------------------------------------------------------
// 4 — abort
// ---------------------------------------------------------------------------

function abortableStream(): {
  readonly fake: FakeClient
  readonly opened: AbortSignal[]
  readonly state: { closed: boolean; effects: number }
} {
  const opened: AbortSignal[] = []
  const state = { closed: false, effects: 0 }
  let release: (() => void) | undefined
  const wait = new Promise<void>((resolve) => { release = resolve })
  const fake: FakeClient = {
    remote: {
      session: {
        follow: (_request: unknown, signal?: AbortSignal) => {
          if (signal !== undefined) opened.push(signal)
          let disposed = false
          return {
            [Symbol.asyncIterator]: async function * () {
              try {
                yield { type: 'baseline' }
                await wait
              } finally {
                state.closed = true
              }
            },
            dispose: () => {
              if (disposed) return
              disposed = true
              state.effects += 1
              release?.()
            },
          }
        },
      },
    },
    unary: [],
    streams: [],
    errors: new Map(),
    persistent: new Set(),
    closed: new Map(),
    disposeEffects: new Map(),
  }
  return { fake, opened, state }
}

describe('t100637 / stream cancellation', () => {
  it('aborts the upstream, runs the iterator finally, and tolerates repeated return()', async () => {
    const { fake, opened, state } = abortableStream()
    const relay = new RemoteRelay({
      instanceId: 'alpha',
      remote: () => fake.remote,
      descriptor: endpoint => descriptorOf(endpoint),
      mount: async () => {},
    })
    const control = new AbortController()
    const iterator = relay.stream(
      'session/follow',
      { request: { address: { kind: 'session', sessionId: 's-1' } } },
      control.signal,
    )[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: 'baseline' } })
    control.abort()
    // Resolves only when the iterator's finally ran; a hanging promise would
    // hit the test timeout instead.
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    expect(opened[0]?.aborted).toBe(true)
    expect(state.closed).toBe(true)
    expect(state.effects).toBe(1)

    // Repeated dispose is a no-op on the handle contract.
    await expect(iterator.return?.(undefined)).resolves.toMatchObject({ done: true })
    await expect(iterator.return?.(undefined)).resolves.toMatchObject({ done: true })
    expect(state.effects).toBe(1)
  })

  it('propagates downstream abort through the real Gateway to the upstream signal', async () => {
    const beta = fakeClient()
    beta.persistent.add('session/follow')
    const { gateway, peer } = await bench(connectionFactory(new Map([['alpha', beta], ['beta', fakeClient()]])))
    const control = new AbortController()

    const stream = await gateway.stream({
      peer,
      namespace: 'session',
      method: 'follow',
      args: { request: { address: { kind: 'session', sessionId: 'alpha:s-1' } } },
      signal: control.signal,
    })
    const iterator = stream[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: false })
    control.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })

    expect(beta.streams[0]?.signal?.aborted).toBe(true)
    expect(beta.closed.get('session/follow')).toBe(true)
    expect(beta.disposeEffects.get('session/follow')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 5 — business error pass-through
// ---------------------------------------------------------------------------

describe('t100637 / failure vocabulary', () => {
  it('delivers an upstream business code unchanged through the Gateway', async () => {
    const alpha = fakeClient()
    const business = new RemoteError('gateway/bad-request', 'upstream refused', {})
    alpha.errors.set('session/rename', business)
    const { gateway, peer } = await bench(connectionFactory(new Map([['alpha', alpha], ['beta', fakeClient()]])))

    const error = await gateway.invoke({
      peer,
      namespace: 'session',
      method: 'rename',
      args: { request: { sessionId: 'alpha:s-1', title: 'x' } },
    }).catch((caught: unknown) => caught)

    expect(error).toBe(business)
    expect(errorCode(error)).toBe('gateway/bad-request')
  })

  it('maps only gateway/internal to instance-unreachable, keeping the cause', async () => {
    const alpha = fakeClient()
    const carrier = new RemoteError('gateway/internal', 'client api: session/rename failed: fetch failed', {})
    alpha.errors.set('session/rename', carrier)
    const { gateway, peer } = await bench(connectionFactory(new Map([['alpha', alpha], ['beta', fakeClient()]])))

    const error = await gateway.invoke({
      peer,
      namespace: 'session',
      method: 'rename',
      args: { request: { sessionId: 'alpha:s-1', title: 'x' } },
    }).catch((caught: unknown) => caught)

    expect(errorCode(error)).toBe('control-plane/instance-unreachable')
    expect(remoteErrorOf(error)?.details).toEqual({ instanceId: 'alpha', endpoint: 'session/rename' })
    expect((error as Error).cause).toBe(carrier)
  })

  it('maps a stream carrier throw to instance-unreachable and releases the handle', async () => {
    const alpha = fakeClient()
    // The fake stream throws a plain carrier error after the first item.
    alpha.remote = {
      session: {
        follow: () => ({
          [Symbol.asyncIterator]: async function * () {
            throw new Error('socket closed')
          },
        }),
      },
    }
    const { gateway, peer } = await bench(connectionFactory(new Map([['alpha', alpha], ['beta', fakeClient()]])))

    const error = await (async () => {
      const stream = await gateway.stream({
        peer,
        namespace: 'session',
        method: 'follow',
        args: { request: { address: { kind: 'session', sessionId: 'alpha:s-1' } } },
      })
      for await (const _item of stream) {
        // never reached
      }
    })().catch((caught: unknown) => caught)

    expect(errorCode(error)).toBe('control-plane/instance-unreachable')
    expect(remoteErrorOf(error)?.details).toMatchObject({ instanceId: 'alpha', endpoint: 'session/follow' })
  })
})

// ---------------------------------------------------------------------------
// 6 — local calls never fall back to forwarding
// ---------------------------------------------------------------------------

describe('t100637 / local fallback', () => {
  it('does not forward an unprefixed call, a local session/create, or an unconfigured instance', async () => {
    const alpha = fakeClient()
    const { gateway, peer } = await bench(connectionFactory(new Map([['alpha', alpha], ['beta', fakeClient()]])))

    const unprefixed = await gateway.invoke({
      peer,
      namespace: 'session',
      method: 'cancel',
      args: { request: { sessionId: 's-1' } },
    }).catch((caught: unknown) => caught)
    const createLocal = await gateway.invoke({
      peer,
      namespace: 'session',
      method: 'create',
      args: { request: { workspaceId: '/repo' } },
    }).catch((caught: unknown) => caught)
    const unconfigured = await gateway.invoke({
      peer,
      namespace: 'session',
      method: 'cancel',
      args: { request: { sessionId: 'gamma:s-1' } },
    }).catch((caught: unknown) => caught)
    const listed = await gateway.invoke({
      peer,
      namespace: 'session',
      method: 'list',
      args: { _request: { cursor: 'alpha:1' } },
    }).catch((caught: unknown) => caught)

    for (const error of [unprefixed, createLocal, unconfigured, listed]) {
      expect(errorCode(error)).not.toBe('control-plane/instance-unreachable')
    }
    expect(alpha.unary).toHaveLength(0)
    expect(alpha.streams).toHaveLength(0)
  })

  it('does not forward a local stream call', async () => {
    const alpha = fakeClient()
    const { gateway, peer } = await bench(connectionFactory(new Map([['alpha', alpha], ['beta', fakeClient()]])))

    await gateway.stream({
      peer,
      namespace: 'session',
      method: 'follow',
      args: { request: { address: { kind: 'session', sessionId: 's-1' } } },
    }).catch(() => undefined)

    expect(alpha.streams).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 7 — lazy workspace mount
// ---------------------------------------------------------------------------

/** Browser-shaped Client root: real registry + real Gateway client over a fake carrier. */
async function clientRoot(): Promise<{ readonly ctx: Context; readonly sent: unknown[] }> {
  const ctx = new Context()
  contexts.push(ctx)
  const sent: unknown[] = []
  ctx.reflect.provide('connection', {
    interactions: 'none',
    isLoopback: true,
    rpc: {
      call: async (channel: string, endpoint: string, payload: unknown) => {
        sent.push({ channel, endpoint, payload })
        return { ok: true, value: { mounted: true } }
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
  return { ctx, sent }
}

type UpstreamConstructor = new (instance: ResolvedInstance, root: Context) => Upstream

interface MountableRemote {
  $mount: (contribution: TypertRemoteContribution) => Promise<() => Promise<void>>
}

describe('t100637 / lazy workspace mount', () => {
  it('mounts workspace once for concurrent first forwards and then forwards through it', async () => {
    const { ctx, sent } = await clientRoot()
    const remote = ctx.remote as unknown as MountableRemote
    expect((ctx.remote as unknown as Record<string, unknown>).workspace).toBeUndefined()
    let mounts = 0
    const original = remote.$mount.bind(remote)
    remote.$mount = async (contribution) => {
      mounts += 1
      return await original(contribution)
    }
    const upstream = new (Upstream as unknown as UpstreamConstructor)(ALPHA, ctx)

    const [one, two] = await Promise.all([
      upstream.forwardUnary(
        'workspace/rename',
        { request: { workspaceId: '/repo', title: 'one' } },
        new AbortController().signal,
      ),
      upstream.forwardUnary(
        'workspace/rename',
        { request: { workspaceId: '/repo', title: 'two' } },
        new AbortController().signal,
      ),
    ])

    expect(one).toEqual({ mounted: true })
    expect(two).toEqual({ mounted: true })
    expect(mounts).toBe(1)
    expect((ctx.remote as unknown as Record<string, unknown>).workspace).toBeDefined()
    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatchObject({ channel: '/api', endpoint: 'workspace/rename' })
    const payloads = sent.map(entry => (entry as { payload: { args: unknown } }).payload.args)
    expect(payloads).toEqual([
      { request: { workspaceId: '/repo', title: 'one' } },
      { request: { workspaceId: '/repo', title: 'two' } },
    ])
  })

  it('surfaces the first mount failure without reaching the carrier', async () => {
    const { ctx, sent } = await clientRoot()
    const remote = ctx.remote as unknown as MountableRemote
    remote.$mount = async () => { throw new Error('mount exploded') }
    const upstream = new (Upstream as unknown as UpstreamConstructor)(ALPHA, ctx)
    const signal = new AbortController().signal

    await expect(upstream.forwardUnary(
      'workspace/rename',
      { request: { workspaceId: '/repo', title: 'one' } },
      signal,
    )).rejects.toThrow('mount exploded')
    expect(sent).toHaveLength(0)
  })

  it('retries a failed lazy mount on the next call, single-flighted', async () => {
    const { ctx, sent } = await clientRoot()
    const remote = ctx.remote as unknown as MountableRemote
    const original = remote.$mount.bind(remote)
    let mounts = 0
    remote.$mount = async (contribution) => {
      mounts += 1
      if (mounts === 1) throw new Error('mount exploded')
      return await original(contribution)
    }
    const upstream = new (Upstream as unknown as UpstreamConstructor)(ALPHA, ctx)
    const signal = new AbortController().signal
    const call = (title: string): Promise<unknown> => upstream.forwardUnary(
      'workspace/rename',
      { request: { workspaceId: '/repo', title } },
      signal,
    )

    await expect(call('first')).rejects.toThrow('mount exploded')
    expect(sent).toHaveLength(0)
    expect((ctx.remote as unknown as Record<string, unknown>).workspace).toBeUndefined()

    // Two concurrent calls after the failure share exactly one retry.
    const [one, two] = await Promise.all([call('second'), call('third')])
    expect(one).toEqual({ mounted: true })
    expect(two).toEqual({ mounted: true })
    expect(mounts).toBe(2)
    expect((ctx.remote as unknown as Record<string, unknown>).workspace).toBeDefined()
    expect(sent).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 8 — endpoints with several coexisting instance-qualified identifiers
// ---------------------------------------------------------------------------

describe('t100637 / multi-identifier endpoints', () => {
  it('strips both workspaceId and sessionId on session/create', () => {
    const target = resolveFederationTarget(
      'session/create',
      { request: { workspaceId: 'alpha:/repo', sessionId: 'alpha:s-1', agentPreset: 'p' } },
      id => id === 'alpha',
    )
    expect(target?.instanceId).toBe('alpha')
    expect(target?.args).toEqual({
      request: { workspaceId: '/repo', sessionId: 's-1', agentPreset: 'p' },
    })
  })

  it('strips beforeWorkspaceId on workspace/insertBefore', () => {
    const target = resolveFederationTarget(
      'workspace/insertBefore',
      { request: { workspaceId: 'alpha:/repo', beforeWorkspaceId: 'alpha:/other' } },
      id => id === 'alpha',
    )
    expect(target?.instanceId).toBe('alpha')
    expect(target?.args).toEqual({
      request: { workspaceId: '/repo', beforeWorkspaceId: '/other' },
    })
  })

  it('strips sessionId and beforeSessionId on workspace/insertSessionBefore', () => {
    const target = resolveFederationTarget(
      'workspace/insertSessionBefore',
      { request: { workspaceId: 'alpha:/repo', sessionId: 'alpha:s-1', beforeSessionId: 'alpha:s-2' } },
      id => id === 'alpha',
    )
    expect(target?.instanceId).toBe('alpha')
    expect(target?.args).toEqual({
      request: { workspaceId: '/repo', sessionId: 's-1', beforeSessionId: 's-2' },
    })
  })

  it('leaves one unprefixed sibling id untouched beside stripped ones', () => {
    const target = resolveFederationTarget(
      'workspace/insertSessionBefore',
      { request: { workspaceId: 'alpha:/repo', sessionId: '/s-1', beforeSessionId: 'alpha:s-2' } },
      () => true,
    )
    expect(target?.args).toEqual({
      request: { workspaceId: '/repo', sessionId: '/s-1', beforeSessionId: 's-2' },
    })
  })

  it('routes on whichever declared id is qualified', () => {
    const onlyNeighbour = resolveFederationTarget(
      'workspace/insertSessionBefore',
      { request: { workspaceId: '/repo', beforeSessionId: 'alpha:s-2' } },
      id => id === 'alpha',
    )
    expect(onlyNeighbour?.args).toEqual({ request: { workspaceId: '/repo', beforeSessionId: 's-2' } })

    const onlySession = resolveFederationTarget(
      'session/create',
      { request: { sessionId: 'alpha:s-1' } },
      id => id === 'alpha',
    )
    expect(onlySession?.args).toEqual({ request: { sessionId: 's-1' } })
  })

  it('refuses a mixed-instance multi-id request instead of forwarding a leak', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['session/create', { request: { workspaceId: 'alpha:/repo', sessionId: 'beta:s-1' } }],
      ['workspace/insertBefore', { request: { workspaceId: 'alpha:/repo', beforeWorkspaceId: 'beta:/other' } }],
      ['workspace/insertSessionBefore', { request: { workspaceId: 'alpha:/repo', sessionId: 'beta:s-1' } }],
      ['workspace/insertSessionBefore', { request: { workspaceId: 'alpha:/repo', sessionId: 'alpha:s-1', beforeSessionId: 'beta:s-2' } }],
    ]
    for (const [endpoint, args] of cases) {
      expect(resolveFederationTarget(endpoint, args, () => true), endpoint).toBeUndefined()
    }
  })

  it('forwards same-instance multi-id writes end to end with no prefix left', async () => {
    const alpha = fakeClient()
    const counts = forwardCounts()
    const { gateway, peer } = await bench(
      connectionFactory(new Map([['alpha', alpha], ['beta', fakeClient()]]), counts),
    )

    const created = await gateway.invoke({
      peer,
      namespace: 'session',
      method: 'create',
      args: { request: { workspaceId: 'alpha:/repo', sessionId: 'alpha:s-1', agentPreset: 'p' } },
    })
    expect(created).toEqual({
      endpoint: 'session/create',
      received: { workspaceId: '/repo', sessionId: 's-1', agentPreset: 'p' },
    })

    const inserted = await gateway.invoke({
      peer,
      namespace: 'workspace',
      method: 'insertBefore',
      args: { request: { workspaceId: 'alpha:/repo', beforeWorkspaceId: 'alpha:/other' } },
    })
    expect(inserted).toEqual({
      endpoint: 'workspace/insertBefore',
      received: { workspaceId: '/repo', beforeWorkspaceId: '/other' },
    })

    const moved = await gateway.invoke({
      peer,
      namespace: 'workspace',
      method: 'insertSessionBefore',
      args: { request: { workspaceId: 'alpha:/repo', sessionId: 'alpha:s-1', beforeSessionId: 'alpha:s-2' } },
    })
    expect(moved).toEqual({
      endpoint: 'workspace/insertSessionBefore',
      received: { workspaceId: '/repo', sessionId: 's-1', beforeSessionId: 's-2' },
    })

    expect(counts.get('alpha')).toEqual({ unary: 3, stream: 0 })
    expect(counts.get('beta')).toEqual({ unary: 0, stream: 0 })
  })

  it('never calls a forwarder for a mixed-instance multi-id write', async () => {
    const alpha = fakeClient()
    const counts = forwardCounts()
    const { gateway, peer } = await bench(
      connectionFactory(new Map([['alpha', alpha], ['beta', fakeClient()]]), counts),
    )

    const error = await gateway.invoke({
      peer,
      namespace: 'session',
      method: 'create',
      args: { request: { workspaceId: 'alpha:/repo', sessionId: 'beta:s-1' } },
    }).catch((caught: unknown) => caught)

    // Falls through to local resolution: this Host mounts no session/create.
    expect(errorCode(error)).toBe('gateway/invocation-unavailable')
    expect(counts.get('alpha')).toEqual({ unary: 0, stream: 0 })
    expect(counts.get('beta')).toEqual({ unary: 0, stream: 0 })
    expect(alpha.unary).toHaveLength(0)
  })

  it('forwards a same-instance subagent address end to end', async () => {
    const alpha = fakeClient()
    const counts = forwardCounts()
    const { gateway, peer } = await bench(
      connectionFactory(new Map([['alpha', alpha], ['beta', fakeClient()]]), counts),
    )

    const value = await gateway.invoke({
      peer,
      namespace: 'session',
      method: 'page',
      args: { request: { address: subagentAddress('alpha'), throughSeq: 2 } },
    })
    expect(value).toEqual({
      endpoint: 'session/page',
      received: {
        address: {
          kind: 'subagent',
          sessionId: 's-1',
          parentSessionId: 'p-1',
          childSessionId: 'c-1',
          mode: 'one-shot',
        },
        throughSeq: 2,
      },
    })
    expect(counts.get('alpha')).toEqual({ unary: 1, stream: 0 })
    expect(counts.get('beta')).toEqual({ unary: 0, stream: 0 })
  })

  it('never forwards a cross-instance subagent address', async () => {
    const alpha = fakeClient()
    const counts = forwardCounts()
    const { gateway, peer } = await bench(
      connectionFactory(new Map([['alpha', alpha], ['beta', fakeClient()]]), counts),
    )

    const unary = await gateway.invoke({
      peer,
      namespace: 'session',
      method: 'page',
      args: { request: { address: { kind: 'subagent', parentSessionId: 'alpha:p-1', childSessionId: 'beta:c-1' } } },
    }).catch((caught: unknown) => caught)
    expect(errorCode(unary)).toBe('gateway/invocation-unavailable')

    const stream = await gateway.stream({
      peer,
      namespace: 'session',
      method: 'follow',
      args: { request: { address: { kind: 'subagent', parentSessionId: 'alpha:p-1', childSessionId: 'beta:c-1' } } },
    }).catch((caught: unknown) => caught)
    expect(errorCode(stream)).toBe('gateway/invocation-unavailable')

    expect(counts.get('alpha')).toEqual({ unary: 0, stream: 0 })
    expect(counts.get('beta')).toEqual({ unary: 0, stream: 0 })
    expect(alpha.unary).toHaveLength(0)
    expect(alpha.streams).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 9 — endpoint-only admission: no namespace-wide fallback
// ---------------------------------------------------------------------------

describe('t100637 / unknown endpoints', () => {
  const UNKNOWN: [string, string, Record<string, unknown>][] = [
    // A forged method inside a federated namespace: the old namespace fallback
    // would have forwarded it with the prefix stripped.
    ['session', 'foo', { request: { sessionId: 'alpha:s-1' } }],
    ['workspace', 'foo', { request: { workspaceId: 'alpha:/repo' } }],
    // A namespace that never federates at all.
    ['nope', 'foo', { request: { sessionId: 'alpha:s-1' } }],
    // A method that smuggles its own segment: the endpoint is no longer two.
    ['session', 'foo/bar', { request: { sessionId: 'alpha:s-1' } }],
  ]

  it('claims no unknown endpoint, so nothing can be forwarded', async () => {
    for (const [namespace, method] of UNKNOWN) {
      const endpoint = `${namespace}/${method}`
      expect(isFederatedEndpoint(endpoint), endpoint).toBe(false)
      expect(resolveFederationTarget(endpoint, { request: { sessionId: 'alpha:s-1' } }, () => true), endpoint)
        .toBeUndefined()
    }
  })

  it('answers an unknown unary endpoint locally with a forwarder count of zero', async () => {
    const alpha = fakeClient()
    const counts = forwardCounts()
    const { gateway, peer } = await bench(
      connectionFactory(new Map([['alpha', alpha], ['beta', fakeClient()]]), counts),
    )

    for (const [namespace, method, args] of UNKNOWN) {
      const endpoint = `${namespace}/${method}`
      const error = await gateway.invoke({ peer, namespace, method, args }).catch((caught: unknown) => caught)
      expect(errorCode(error), endpoint).toBe('gateway/invocation-unavailable')
      expect(errorCode(error), endpoint).not.toBe('control-plane/instance-unreachable')
    }
    expect(counts.get('alpha')).toEqual({ unary: 0, stream: 0 })
    expect(counts.get('beta')).toEqual({ unary: 0, stream: 0 })
  })

  it('answers an unknown stream endpoint locally with a forwarder count of zero', async () => {
    const alpha = fakeClient()
    const counts = forwardCounts()
    const { gateway, peer } = await bench(
      connectionFactory(new Map([['alpha', alpha], ['beta', fakeClient()]]), counts),
    )

    for (const [namespace, method, args] of UNKNOWN) {
      const endpoint = `${namespace}/${method}`
      const error = await gateway.stream({ peer, namespace, method, args }).catch((caught: unknown) => caught)
      expect(errorCode(error), endpoint).toBe('gateway/invocation-unavailable')
    }
    expect(counts.get('alpha')).toEqual({ unary: 0, stream: 0 })
    expect(counts.get('beta')).toEqual({ unary: 0, stream: 0 })
  })

  it('keeps a real but non-federated endpoint local even with a prefixed id', async () => {
    const alpha = fakeClient()
    const counts = forwardCounts()
    const { gateway, peer } = await bench(
      connectionFactory(new Map([['alpha', alpha], ['beta', fakeClient()]]), counts),
    )

    const error = await gateway.invoke({
      peer,
      namespace: 'session',
      method: 'list',
      args: { _request: { cursor: 'alpha:s-1' } },
    }).catch((caught: unknown) => caught)

    expect(errorCode(error)).toBe('gateway/invocation-unavailable')
    expect(counts.get('alpha')).toEqual({ unary: 0, stream: 0 })
  })
})
