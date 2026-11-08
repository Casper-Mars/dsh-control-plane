/**
 * Instance-qualified (federated) Session identities.
 *
 * A control plane multiplexes several Harness instances behind one Gateway, so
 * the browser names a Session owned by another instance as
 * `<instanceId>:<localSessionId>`. The Client keeps that key opaque: it never
 * splits the prefix nor resolves the instance (the Gateway's federation router
 * owns both), and it forwards the complete string to every Session RPC.
 *
 * @module @deepseek-ai/dsh-api-session-controller/client/federation
 */

/**
 * Whether one Session identity has the instance-qualified shape.
 *
 * Both segments must be non-empty, matching the Gateway's split at the first
 * colon. The answer only relaxes local-catalog membership guards: a local id
 * is unaffected because those guards run for absent identities only, and the
 * key itself is never rewritten.
 * @param id - Session identity as received from navigation or persistence.
 * @returns whether the identity is an instance-qualified key.
 */
export function isFederatedSessionId(id: string): boolean {
  const separator = id.indexOf(':')
  return separator > 0 && separator < id.length - 1
}

/**
 * Qualify an id an instance reported for one of its own Sessions.
 *
 * A forwarded RPC answers with the owner-local id: `session/fork` returns the
 * child's bare id even when the source was a federated key. Every follow-up
 * call must carry the same instance prefix, or the Gateway would resolve the
 * bare id against this Client's own Host — a different Session that may well
 * exist. A local source (no prefix) leaves the answer untouched.
 * @param source - Session identity the answering instance was asked about.
 * @param child - owner-local id the instance reported.
 * @returns the child id qualified with the source's instance, when it has one.
 */
export function qualifyFederatedSessionId(source: string, child: string): string {
  if (!isFederatedSessionId(source) || isFederatedSessionId(child)) return child
  const separator = source.indexOf(':')
  return `${source.slice(0, separator)}:${child}`
}
