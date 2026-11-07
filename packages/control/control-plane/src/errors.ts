/**
 * Failure vocabulary the control plane adds to the shared Remote errors.
 *
 * A federated call fails in two very different ways, and the browser has to
 * tell them apart: the owning instance answered and refused (its business code
 * survives untouched), or nothing reached it at all. Only the second case is
 * ours, and {@link instanceUnreachable} is its single constructor so every
 * throw site carries the same code and the same `instanceId`.
 * @module @deepseek-ai/dsh-control-plane/src/errors
 */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * The owning instance's outbound connection is not established, so the
     * call was never sent. `cause` keeps the carrier's own message in-process.
     */
    'control-plane/instance-unreachable': {
      /** Configured instance the call named. */
      readonly instanceId: string
      /** Remote endpoint that was not forwarded. */
      readonly endpoint: string
    }
  }
}

/**
 * Build the failure a call gets when its owning instance cannot be reached.
 * @param instanceId - configured instance the call named.
 * @param endpoint - Remote endpoint that was not forwarded.
 * @param cause - carrier or transport failure that proved the instance down.
 * @returns the tagged failure; callers throw it unchanged.
 */
export function instanceUnreachable(
  instanceId: string,
  endpoint: string,
  cause?: unknown,
): RemoteError<'control-plane/instance-unreachable'> {
  return new RemoteError(
    'control-plane/instance-unreachable',
    `control-plane: 实例 ${instanceId} 不可达，无法转发 ${endpoint}`,
    { instanceId, endpoint },
    cause === undefined ? undefined : { cause },
  )
}
