/**
 * Instance-qualified (federated) Session identities.
 *
 * A control plane multiplexes several Harness instances behind one Gateway, so
 * the browser names a Session owned by another instance as
 * `<instanceId>:<localSessionId>`. The Client keeps that key opaque: it never
 * splits the prefix nor resolves the instance (the Gateway's federation router
 * owns both), and it forwards the complete string to every Session RPC.
 *
 * The predicate is package-local because the client bundle purity gate forbids
 * cross-plugin value imports: `@deepseek-ai/dsh-api-session-controller/client`
 * is a module-table row, so its runtime values cannot be shared. The shape
 * rule is therefore restated here and must stay identical to
 * `packages/api/session-controller/src/client/federation.ts`.
 *
 * @module @deepseek-ai/dsh-client-ui-workspace/client/federated-key
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
