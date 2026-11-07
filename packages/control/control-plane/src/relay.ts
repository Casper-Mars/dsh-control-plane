/**
 * Relay one federated Remote call onto an instance's own Client connection.
 *
 * The control plane forwards the *wire* call, not a translated one: it reuses
 * the generated Client contribution the upstream already mounted, so the
 * endpoint, its codecs, and its cancellation contract stay exactly the ones a
 * browser page would use. This module holds the two decisions that are ours:
 *
 * 1. which mounted descriptor an endpoint names, and
 * 2. what a failure means — an instance that never answered
 *    (`control-plane/instance-unreachable`) versus one that answered and
 *    refused (its own business code, passed through untouched).
 *
 * @module @deepseek-ai/dsh-control-plane/src/relay
 */

import {
  isTypertRemoteMethod,
  RemoteError,
  remoteErrorOf,
  type InvocationDescriptor,
  type TypertClientRemote,
  type TypertRemoteMethod,
} from '@deepseek-ai/dsh-typert-protocol'
import { instanceUnreachable } from './errors.ts'

/**
 * Whether a stream was cancelled.
 *
 * A function, not a property read: the `if (signal.aborted) return` before the
 * loop narrows the property to `false` for the rest of the body, but an abort
 * can land during any `await` inside it, so the check must stay honest.
 * @param signal - the inbound logical stream's lifetime.
 * @returns whether the caller has aborted.
 */
function aborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/** Whether a value is the async iterable a mounted stream method must return. */
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null
    && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
}

/** One forwarded stream's upstream handle, as this module reads it. */
interface UpstreamStreamHandle extends AsyncIterable<unknown> {
  /** Release the logical stream: cancels the upstream call and its carrier. */
  dispose?(): void
}

/** One generated unary direct method. */
type UnaryMethod = TypertRemoteMethod<object, unknown>

/** One generated stream direct method. */
type StreamMethod = TypertRemoteMethod<object, unknown, 'stream', unknown>

/** One generated direct method, unary or stream: the two carriers this relay serves. */
type RemoteMethod = UnaryMethod | StreamMethod

/** What the relay needs from the connection that owns it. */
export interface RelayOptions {
  /** Configured instance id, used in the failure the relay throws. */
  readonly instanceId: string
  /** The mounted Client Remote root, read lazily so it may arrive after construction. */
  readonly remote: () => unknown
  /** Descriptor of an endpoint already mounted, if any. */
  readonly descriptor: (endpoint: string) => InvocationDescriptor | undefined
  /** Mount one namespace on demand (the workspace namespace is lazy). */
  readonly mount: (namespace: string) => Promise<void>
  /** Called when a carrier failure proves the instance is not answering. */
  readonly unreachable?: ((cause: unknown) => void) | undefined
}

/**
 * Forward unary and stream calls to one instance's Client connection.
 *
 * The token never travels in the arguments: authentication belongs to the
 * connection (`Upstream.connect` installed the cookie on its carrier), so the
 * relay forwards only what the Gateway stripped the instance prefix from.
 */
export class RemoteRelay {
  constructor(private readonly options: RelayOptions) {}

  /**
   * Forward one unary call and unwrap the upstream result envelope.
   * @param endpoint - canonical Remote endpoint (`namespace/method`).
   * @param args - wire arguments with the instance prefix already stripped.
   * @param signal - cancellation of the inbound call.
   * @returns the upstream business value.
   * @throws RemoteError carrying the upstream business code, or
   *   `control-plane/instance-unreachable` when nothing answered.
   */
  async unary(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const descriptor = await this.resolve(endpoint, false)
    const result = await descriptor.invoke(this.options.remote() as TypertClientRemote, args, signal)
    if (result.ok) return result.value
    const failure = result.error
    // A cancellation is the caller's own abort travelling back; it is not a
    // reachability fact about the instance.
    if (failure.code === 'gateway/cancelled') throw failure
    // `gateway/internal` is the Client carrier's unclassified failure: the
    // upstream never produced a business answer, so this is our failure to map.
    if (failure.code === 'gateway/internal') {
      this.options.unreachable?.(failure)
      throw instanceUnreachable(this.options.instanceId, endpoint, failure)
    }
    throw failure
  }

  /**
   * Forward one stream call.
   * @param endpoint - canonical Remote endpoint (`namespace/method`).
   * @param args - wire arguments with the instance prefix already stripped.
   * @param signal - cancellation of the inbound logical stream.
   * @returns the upstream items, cancelled with `signal` and released on early
   *   return.
   */
  stream(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): AsyncIterable<unknown> {
    return this.pump(endpoint, args, signal)
  }

  /**
   * The generator behind {@link stream}: it owns the upstream handle's
   * lifetime so no path — abort, consumer return, upstream error — leaks an
   * iterator or a timer.
   */
  private async *pump(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): AsyncGenerator {
    const descriptor = await this.resolve(endpoint, true)
    const opened: unknown = descriptor.invoke(this.options.remote() as TypertClientRemote, args, signal)
    if (!isAsyncIterable(opened)) {
      throw new RemoteError('gateway/result-invalid', `control-plane: ${endpoint} 未返回可迭代的上游流`, {
        endpoint,
        field: 'result',
      })
    }
    const handle = opened as UpstreamStreamHandle
    // Idempotent in the Client handle; calling it twice is the intended way to
    // combine "the caller aborted" with "this generator is finishing".
    const release = (): void => { handle.dispose?.() }
    if (signal.aborted) {
      release()
      return
    }
    // Abort must reach the upstream while `next()` is pending, not only on the
    // next pull, so the listener releases the handle directly.
    signal.addEventListener('abort', release, { once: true })
    try {
      for await (const item of handle) yield item
    } catch (error) {
      // A consumer that aborted already stopped listening; the upstream was
      // cancelled by the same signal and there is nothing left to report.
      if (aborted(signal)) return
      const remote = remoteErrorOf(error)
      if (remote !== undefined) {
        if (remote.code === 'gateway/cancelled') return
        if (remote.code !== 'gateway/internal') throw remote
      }
      // Physical carrier failures (closed socket, no generation) are first
      // reachability facts, not business answers.
      this.options.unreachable?.(error)
      throw instanceUnreachable(this.options.instanceId, endpoint, error)
    } finally {
      signal.removeEventListener('abort', release)
      release()
    }
  }

  /**
   * Resolve one endpoint's mounted descriptor, mounting its namespace once.
   * @param endpoint - canonical Remote endpoint (`namespace/method`).
   * @param stream - whether the caller opens the stream carrier.
   * @returns the generated direct method this relay invokes.
   * @throws RemoteError `gateway/method-unavailable` when the upstream mounts
   *   no invocable method for the endpoint.
   */
  private async resolve(endpoint: string, stream: true): Promise<StreamMethod>
  private async resolve(endpoint: string, stream: false): Promise<UnaryMethod>
  private async resolve(endpoint: string, stream: boolean): Promise<RemoteMethod> {
    const namespace = endpoint.split('/')[0] ?? ''
    let descriptor = this.options.descriptor(endpoint)
    if (descriptor === undefined) {
      await this.options.mount(namespace)
      descriptor = this.options.descriptor(endpoint)
    }
    if (descriptor === undefined || !isTypertRemoteMethod(descriptor)) {
      throw new RemoteError(
        'gateway/method-unavailable',
        `control-plane: 实例 ${this.options.instanceId} 未挂载可转发的端点 ${endpoint}`,
        { endpoint },
      )
    }
    // A scoped descriptor resolves its lookup argument from a Client Context
    // the control plane does not own, so it cannot be replayed from the wire.
    if (descriptor.scope !== undefined) {
      throw new RemoteError(
        'gateway/method-unavailable',
        `control-plane: 端点 ${endpoint} 依赖 Client Context 投影，无法跨实例转发`,
        { endpoint },
      )
    }
    if ((descriptor.mode === undefined) === stream) {
      throw new RemoteError(
        'gateway/signature-invalid',
        `control-plane: 端点 ${endpoint} 的调用形态与转发通道不符`,
        { endpoint },
      )
    }
    return descriptor
  }
}
