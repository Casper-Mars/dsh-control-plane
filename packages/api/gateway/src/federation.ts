/**
 * Federation routing for Remote calls that name another Harness instance.
 *
 * A control plane multiplexes several instances into one UI. The browser then
 * speaks one Gateway, so session and workspace identifiers it sends carry an
 * `<instanceId>:` prefix. This module decides — from the endpoint and the one
 * identifier parameter that endpoint owns — whether a call belongs to a
 * configured peer instance. It performs no I/O: the Gateway hands the resolved
 * target to the registered {@link FederationForwarder}.
 * @module @deepseek-ai/dsh-api-gateway/src/federation
 */

/** One Remote call handed to the Harness instance that owns the resource. */
export interface FederationTarget {
  /** Configured instance id, taken from the identifier prefix. */
  readonly instanceId: string
  /** Original Remote endpoint, unchanged. */
  readonly endpoint: string
  /** Named wire arguments with the instance prefix stripped from the identifier. */
  readonly args: Readonly<Record<string, unknown>>
}

/**
 * Transport a control plane installs to reach other instances.
 *
 * The Gateway calls one of these methods only after
 * {@link FederationRouter.hasInstance} accepted the target's instance. Each
 * method receives the invocation's cancellation signal so the forwarder ends
 * its outbound call with the inbound one.
 */
export interface FederationForwarder {
  /**
   * Forward one unary call.
   * @param target - owning instance, endpoint, and prefix-free arguments.
   * @param signal - cancellation of the inbound call.
   * @returns the business result, without a carrier envelope.
   */
  unary(target: FederationTarget, signal: AbortSignal): Promise<unknown>

  /**
   * Forward one stream call.
   * @param target - owning instance, endpoint, and prefix-free arguments.
   * @param signal - cancellation of the inbound logical stream.
   * @returns the remote instance's stream items.
   */
  stream(target: FederationTarget, signal: AbortSignal): AsyncIterable<unknown>
}

/** Pluggable decision source the Gateway consults before local dispatch. */
export interface FederationRouter {
  /** Delivers calls belonging to another instance. */
  readonly forwarder: FederationForwarder
  /**
   * Whether one instance is configured and may own calls.
   * @param instanceId - prefix taken from the identifier argument.
   * @returns whether this router accepts that instance.
   */
  hasInstance(instanceId: string): boolean
}

/**
 * One argument route from the wire-argument root to the identifier value.
 *
 * Generated Clients do not spread a request object across the top level: a
 * descriptor parameter named `request` is sent under that wire name, so
 * `session/cancel` arrives as `{ request: { sessionId } }`. The path therefore
 * names every key in between, and stripping the prefix writes back at the same
 * depth so the upstream Client's own codecs keep seeing the shape they expect.
 */
type IdentifierPath = readonly string[]

/**
 * The identifier routes each endpoint owns.
 *
 * This is the complete inventory of federated endpoints: an endpoint absent
 * here is never forwarded, so a future endpoint must be added deliberately
 * rather than inheriting a namespace-wide guess. Endpoints that carry several
 * identifier fields list every path they can populate — `session/create` names
 * both the Workspace it joins and the blank Session it reuses — and
 * {@link resolveFederationTarget} strips every one that is present.
 */
const IDENTIFIER_PATHS_BY_ENDPOINT: ReadonlyMap<string, readonly IdentifierPath[]> = new Map([
  // `session/*` — one `request` object, or `request.address` for history.
  ['session/attachment', [['request', 'sessionId']]],
  ['session/cancel', [['request', 'sessionId']]],
  ['session/events', [['request', 'address', 'sessionId']]],
  ['session/follow', [['request', 'address', 'sessionId']]],
  ['session/fork', [['request', 'sessionId']]],
  ['session/observeEvent', [['request', 'address', 'sessionId']]],
  ['session/observeProjections', [['request', 'sessionId']]],
  ['session/observeState', [['request', 'sessionId']]],
  ['session/page', [['request', 'address', 'sessionId']]],
  ['session/projections', [['request', 'sessionId']]],
  ['session/prompt', [['request', 'sessionId']]],
  ['session/rename', [['request', 'sessionId']]],
  ['session/selectModel', [['request', 'sessionId']]],
  ['session/state', [['request', 'sessionId']]],
  ['session/updateQueue', [['request', 'sessionId']]],
  ['session/wait', [['request', 'sessionId']]],
  // A create names the Workspace it joins when it has one, and only then the
  // blank Session it reuses; both are qualified by the owning instance.
  ['session/create', [['request', 'workspaceId'], ['request', 'sessionId']]],
  // `workspace/*` — mutations name the Workspace, session actions name the Session.
  ['workspace/archiveSession', [['request', 'sessionId']]],
  ['workspace/unarchiveSession', [['request', 'sessionId']]],
  ['workspace/pinSession', [['request', 'sessionId']]],
  ['workspace/unpinSession', [['request', 'sessionId']]],
  ['workspace/delete', [['request', 'workspaceId']]],
  ['workspace/insertBefore', [['request', 'workspaceId']]],
  ['workspace/insertSessionBefore', [['request', 'workspaceId'], ['request', 'sessionId']]],
  ['workspace/rename', [['request', 'workspaceId']]],
  // Agent-scoped catalogs and commands — the generated wire names the Agent
  // directly (`agentId`), not through a `request` wrapper.
  ['commands/execute', [['agentId']]],
  ['commands/list', [['agentId']]],
  ['fileReferences/list', [['agentId']]],
  ['sessionReferenceResolver/candidates', [['agentId']]],
  // Skill catalog wraps the Session identity in a request object.
  ['skills/list', [['request', 'sessionId']]],
  // Workspace file previews and Office rendering name the Session whose
  // workspace resolves the path; the generated wire is the flat
  // `workspaceFileScopeId`, not a `request` wrapper.
  ['workspaceFiles/changes', [['workspaceFileScopeId']]],
  ['workspaceFiles/list', [['workspaceFileScopeId']]],
  ['workspaceFiles/read', [['workspaceFileScopeId']]],
  ['workspaceFiles/readBytes', [['workspaceFileScopeId']]],
  ['workspaceFiles/stat', [['workspaceFileScopeId']]],
  ['officeToPdf/render', [['workspaceFileScopeId']]],
])

/**
 * The remaining instance-qualified identifiers an endpoint can carry beside
 * the primary id in {@link IDENTIFIER_PATHS_BY_ENDPOINT}.
 *
 * Reordering names the neighbour it moves before, and a subagent address names
 * both the parent and the child session. The browser qualifies every one of
 * them with the owning instance, so all of them have to be stripped before the
 * call reaches that instance.
 */
const EXTRA_IDENTIFIER_PATHS_BY_ENDPOINT: ReadonlyMap<string, readonly IdentifierPath[]> = new Map([
  ['workspace/insertBefore', [['request', 'beforeWorkspaceId']]],
  ['workspace/insertSessionBefore', [['request', 'beforeSessionId']]],
  ['session/events', [
    ['request', 'address', 'parentSessionId'],
    ['request', 'address', 'childSessionId'],
  ]],
  ['session/follow', [
    ['request', 'address', 'parentSessionId'],
    ['request', 'address', 'childSessionId'],
  ]],
  ['session/observeEvent', [
    ['request', 'address', 'parentSessionId'],
    ['request', 'address', 'childSessionId'],
  ]],
  ['session/page', [
    ['request', 'address', 'parentSessionId'],
    ['request', 'address', 'childSessionId'],
  ]],
])

/**
 * The identifier routes one federated endpoint owns.
 *
 * Carrier admission sees only the endpoint, so presence in this table is the
 * whole question the claims layer can answer. An endpoint with no entry is
 * local: there is no namespace-wide fallback.
 * @param endpoint - canonical Remote endpoint (`namespace/method`).
 * @returns candidate routes, or `undefined` for a local endpoint.
 */
function identifierPaths(endpoint: string): readonly IdentifierPath[] | undefined {
  const primary = IDENTIFIER_PATHS_BY_ENDPOINT.get(endpoint)
  if (primary === undefined) return undefined
  const extra = EXTRA_IDENTIFIER_PATHS_BY_ENDPOINT.get(endpoint)
  return extra === undefined ? primary : [...primary, ...extra]
}

/**
 * Read the value at one argument route.
 * @param args - named wire arguments exactly as received.
 * @param path - keys from the argument root to the identifier.
 * @returns the value, or undefined when the route is absent or not an object chain.
 */
function readIdentifier(args: Readonly<Record<string, unknown>>, path: IdentifierPath): unknown {
  let current: unknown = args
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/**
 * Write one value at an argument route, cloning only the objects on that route
 * so every sibling argument keeps its identity.
 * @param args - named wire arguments exactly as received.
 * @param path - keys from the argument root to the identifier.
 * @param value - replacement identifier without the instance prefix.
 * @returns a new argument record; the input is never mutated.
 */
function writeIdentifier(
  args: Readonly<Record<string, unknown>>,
  path: IdentifierPath,
  value: string,
): Readonly<Record<string, unknown>> {
  const [head, ...rest] = path as [string, ...string[]]
  if (rest.length === 0) return { ...args, [head]: value }
  const nested = readIdentifier(args, [head])
  // The route was read successfully, so the chain is an object here; the
  // guard keeps the write total for a caller that mutates args concurrently.
  if (typeof nested !== 'object' || nested === null) return { ...args, [head]: value }
  return {
    ...args,
    [head]: writeIdentifier(nested as Readonly<Record<string, unknown>>, rest, value),
  }
}

/**
 * Whether a Gateway could ever forward this endpoint to another instance.
 *
 * This is an endpoint-only claim: no arguments are available yet, so a call
 * on a claimed endpoint may still be dispatched locally when its identifier
 * has no configured instance prefix.
 * @param endpoint - canonical Remote endpoint (`namespace/method`).
 * @returns whether the endpoint is declared in the federation identifier
 *   table.
 */
export function isFederatedEndpoint(endpoint: string): boolean {
  return identifierPaths(endpoint) !== undefined
}

/**
 * Split one instance-qualified identifier at its first colon.
 * @param value - identifier as the browser sent it (`<instanceId>:<localId>`).
 * @returns both parts, or undefined when the value carries no usable prefix.
 */
function splitInstancePrefix(value: string): { instanceId: string; localId: string } | undefined {
  const separator = value.indexOf(':')
  if (separator <= 0 || separator === value.length - 1) return undefined
  return { instanceId: value.slice(0, separator), localId: value.slice(separator + 1) }
}

/**
 * Resolve one call to a federated target when, and only when, every routing
 * condition holds. Any other value falls through to the unchanged local path.
 *
 * Conditions:
 * 1. the endpoint is declared in {@link IDENTIFIER_PATHS_BY_ENDPOINT};
 * 2. at least one declared identifier field the endpoint can populate holds a
 *    string with an `<instanceId>:<localId>` prefix;
 * 3. every prefixed identifier names the **same** instance — a request that
 *    spans two instances cannot be delivered to either one;
 * 4. `hasInstance` accepts that instance.
 *
 * When the conditions hold, every prefixed identifier is stripped in place;
 * sibling fields (including an unprefixed identifier) keep their values.
 *
 * @param endpoint - canonical Remote endpoint (`namespace/method`).
 * @param args - named wire arguments exactly as received, in the shape the
 *   generated Client produced (`request` stays wrapped).
 * @param hasInstance - whether an instance id is configured for federation.
 * @returns the target with every identifier prefix stripped at its own route,
 *   or `undefined` to keep the call local.
 */
export function resolveFederationTarget(
  endpoint: string,
  args: Readonly<Record<string, unknown>>,
  hasInstance: (instanceId: string) => boolean,
): FederationTarget | undefined {
  const paths = identifierPaths(endpoint)
  if (paths === undefined) return undefined
  // Every declared field that is present and carries a usable prefix names an
  // owner. An absent optional field simply contributes none.
  const prefixed: { path: IdentifierPath; instanceId: string; localId: string }[] = []
  for (const path of paths) {
    const value = readIdentifier(args, path)
    if (typeof value !== 'string') continue
    const split = splitInstancePrefix(value)
    if (split === undefined) continue
    prefixed.push({ path, ...split })
  }
  const first = prefixed[0]
  if (first === undefined) return undefined
  const instanceId = first.instanceId
  // One request has one owner: two different prefixes mean the call cannot be
  // forwarded whole, so it stays local instead of leaking ids upstream.
  if (prefixed.some(entry => entry.instanceId !== instanceId)) return undefined
  if (!hasInstance(instanceId)) return undefined
  let stripped: Readonly<Record<string, unknown>> = args
  for (const entry of prefixed) stripped = writeIdentifier(stripped, entry.path, entry.localId)
  return { instanceId, endpoint, args: stripped }
}
