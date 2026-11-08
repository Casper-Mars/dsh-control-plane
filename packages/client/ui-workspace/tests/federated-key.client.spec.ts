/**
 * Local copy of the federated-key shape rule.
 *
 * The client bundle purity gate forbids importing this value from
 * `@deepseek-ai/dsh-api-session-controller/client`, so the rule is restated in
 * `src/client/federated-key.ts`. These cases mirror the canonical suite in
 * `packages/api/session-controller/tests/federation.client.spec.ts`: any drift
 * between the two copies would let a local id through the catalog guard (or
 * reject a valid instance-qualified key) on the browser side only.
 */

import { describe, expect, it } from 'vitest'
import { isFederatedSessionId } from '../src/client/federated-key.ts'

describe('isFederatedSessionId (workspace copy)', () => {
  it.each([
    ['alpha:s-1', true],
    ['alpha:s-1:tail', true],
    ['s-1', false],
    ['', false],
    [':s-1', false],
    ['alpha:', false],
  ])('%j → %s', (id, expected) => {
    expect(isFederatedSessionId(id)).toBe(expected)
  })

  it('splits at the first colon only, so a key keeps every later colon', () => {
    const id = 'alpha:beta:gamma'
    const separator = id.indexOf(':')
    expect(separator).toBe(5)
    expect(isFederatedSessionId(id)).toBe(true)
  })
})
