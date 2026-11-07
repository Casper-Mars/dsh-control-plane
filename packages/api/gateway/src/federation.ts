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
 * The argument key each federated namespace owns. Only these keys are read:
 * an arbitrary argument containing a colon must never select a route.
 */
const FEDERATED_KEY_BY_NAMESPACE: ReadonlyMap<string, string> = new Map([
  ['session', 'sessionId'],
  ['workspace', 'workspaceId'],
])

/**
 * The argument key an endpoint owns when it belongs to a federated namespace.
 *
 * A federated endpoint is exactly `<namespace>/<method>` with `session` or
 * `workspace` as its namespace. Carrier admission sees only the endpoint, so
 * this shape is the whole question the claims layer can answer.
 * @param endpoint - canonical Remote endpoint (`namespace/method`).
 * @returns the identifier argument key, or `undefined` for a local endpoint.
 */
function federatedArgumentKey(endpoint: string): string | undefined {
  const segments = endpoint.split('/')
  // Direct in-process callers can name any namespace/method pair; a
  // federated endpoint is exactly the two-segment form the carriers produce.
  if (segments.length !== 2) return undefined
  const [namespace, method] = segments as [string, string]
  if (namespace === '' || method === '') return undefined
  return FEDERATED_KEY_BY_NAMESPACE.get(namespace)
}

/**
 * Whether a Gateway could ever forward this endpoint to another instance.
 *
 * This is an endpoint-only claim: no arguments are available yet, so a call
 * on a claimed endpoint may still be dispatched locally when its identifier
 * has no configured instance prefix.
 * @param endpoint - canonical Remote endpoint (`namespace/method`).
 * @returns whether the endpoint is a two-segment federated namespace.
 */
export function isFederatedEndpoint(endpoint: string): boolean {
  return federatedArgumentKey(endpoint) !== undefined
}

/**
 * Resolve one call to a federated target when, and only when, every routing
 * condition holds. Any other value falls through to the unchanged local path.
 *
 * Conditions:
 * 1. the endpoint is exactly `<namespace>/<method>` and the namespace is
 *    `session` or `workspace`;
 * 2. the namespace's own identifier argument is a string;
 * 3. it splits at its **first** colon into two non-empty parts;
 * 4. `hasInstance` accepts the prefix.
 *
 * @param endpoint - canonical Remote endpoint (`namespace/method`).
 * @param args - named wire arguments exactly as received.
 * @param hasInstance - whether an instance id is configured for federation.
 * @returns the target with the identifier prefix stripped, or `undefined` to
 *   keep the call local.
 */
export function resolveFederationTarget(
  endpoint: string,
  args: Readonly<Record<string, unknown>>,
  hasInstance: (instanceId: string) => boolean,
): FederationTarget | undefined {
  const key = federatedArgumentKey(endpoint)
  if (key === undefined) return undefined
  const identifier = args[key]
  if (typeof identifier !== 'string') return undefined
  const separator = identifier.indexOf(':')
  if (separator <= 0 || separator === identifier.length - 1) return undefined
  const instanceId = identifier.slice(0, separator)
  const localId = identifier.slice(separator + 1)
  // The syntactic checks above already guarantee both parts, but the explicit
  // tests keep the routing contract readable and future-proof.
  if (instanceId.length === 0 || localId.length === 0) return undefined
  if (!hasInstance(instanceId)) return undefined
  return {
    instanceId,
    endpoint,
    args: { ...args, [key]: localId },
  }
}
