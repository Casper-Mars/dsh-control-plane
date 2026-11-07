/**
 * Live control-plane frames for the sidebar's `controlPlane/events` stream.
 *
 * The sidebar used to learn about running sessions, added/removed rows, and
 * reachability only from its own tree poll. This hub turns the hosts's existing
 * `onSessionStatus` / `onSessionChange` fan-out and the reachability read into
 * pushed frames, so a running turn shows up within one event instead of one
 * poll, while the client keeps a slow fallback poll for whatever a dropped
 * connection lost.
 *
 * Delivery is per subscriber and never blocks the publisher: every subscriber
 * owns a bounded queue, so one stalled browser cannot hold a status update back
 * from the others. A full queue drops the oldest *non-tree* frame first —
 * `status` and `change` are the frames that go stale — and never a `tree`
 * frame, which is the only one that replaces the whole view.
 * @module @deepseek-ai/dsh-control-plane/src/events
 */

import type {
  ControlPlaneEvent, InstanceNode, InstanceStateFrame, InstanceStateReport, SessionChange,
} from './types.ts'

export type { ControlPlaneEvent, InstanceStateFrame } from './types.ts'

/** Queued frames one subscriber may hold before the oldest non-tree frame is dropped. */
export const DEFAULT_QUEUE_LIMIT = 256

/** One queued frame plus the publication sequence that produced it. */
interface QueuedEvent {
  readonly sequence: number
  readonly event: ControlPlaneEvent
}

/** One live stream consumer: its backlog, wake-up, and abort state. */
interface Subscription {
  readonly queue: QueuedEvent[]
  /** Resolves the generator's wait when a frame arrives or the stream ends. */
  notify: (() => void) | undefined
  /** Set by abort or {@link ControlPlaneEventHub.close}; the generator then ends. */
  done: boolean
}

/** Queue depth per live subscription. */
export interface SubscriptionDiagnostic {
  /** Frames waiting for that subscriber. */
  readonly queued: number
}

/**
 * Compare two reachability reports and return the instances that changed.
 *
 * A change is either a different state (`connecting` → `connected`, `connected`
 * → `unreachable`, …) or a different failure message on an otherwise unchanged
 * state. Instances are reported in configuration order so a frame does not
 * depend on object key order.
 * @param before - reachability read before the triggering operation.
 * @param after - reachability read after it.
 * @param order - instance ids in configuration order.
 * @returns one entry per changed instance; empty when nothing moved.
 */
export function diffInstanceStates(
  before: Readonly<Record<string, InstanceStateReport>>,
  after: Readonly<Record<string, InstanceStateReport>>,
  order: readonly string[],
): readonly InstanceStateFrame[] {
  const changed: InstanceStateFrame[] = []
  for (const instanceId of order) {
    const previous = before[instanceId]
    const next = after[instanceId]
    if (next === undefined) continue
    if (previous !== undefined && previous.state === next.state && previous.error === next.error) continue
    changed.push({
      instanceId,
      state: next.state,
      ...(next.error === undefined ? {} : { error: next.error }),
    })
  }
  return changed
}

/**
 * Fan-out of {@link ControlPlaneEvent} frames to every live stream subscriber.
 *
 * Each subscription gets its own queue. {@link publish} only appends and wakes
 * the waiting generator, so a slow consumer costs memory (bounded by
 * {@link DEFAULT_QUEUE_LIMIT}) and never latency for the others.
 */
export class ControlPlaneEventHub {
  /** Live consumers, in subscription order. */
  private readonly subscriptions = new Set<Subscription>()

  /** Monotonic publication counter, used to drop frames a fresh snapshot already covers. */
  private sequence = 0

  /** Set by {@link close}; a closed hub never revives, not even for a new subscriber. */
  private closed = false

  /**
   * @param queueLimit - frames one subscriber may queue before the oldest
   *   non-tree frame is dropped. Values below 2 are raised to 2 so a queued
   *   `tree` always has a slot beside the newest event.
   */
  constructor(readonly queueLimit: number = DEFAULT_QUEUE_LIMIT) {
    if (this.queueLimit < 2) this.queueLimit = 2
  }

  /** Number of live subscriptions, for diagnostics and lifecycle tests. */
  get subscriberCount(): number {
    return this.subscriptions.size
  }

  /** Queue depth of every live subscription, for diagnostics and lifecycle tests. */
  pendingCounts(): readonly SubscriptionDiagnostic[] {
    return [...this.subscriptions].map(subscription => ({ queued: subscription.queue.length }))
  }

  /**
   * Subscribe to the live frames.
   *
   * The first frame is always a `tree` composed by `snapshot`; frames published
   * while that snapshot is still being composed queue up and follow it. Frames
   * published before the snapshot resolved cannot be newer than the snapshot,
   * so queued `tree` frames from that window are discarded instead of replayed
   * on top of a fresher view.
   * @param snapshot - composes the initial (and reconnect) tree frame.
   * @param signal - ends the subscription; the queue is dropped, not drained.
   * @returns the initial tree followed by the frames published while it lives.
   */
  subscribe(snapshot: () => Promise<readonly InstanceNode[]>, signal: AbortSignal): AsyncIterable<ControlPlaneEvent> {
    return this.stream(snapshot, signal)
  }

  /** Publish one session running-state change. */
  publishStatus(key: string, running: boolean): void {
    this.publish({ kind: 'status', key, running })
  }

  /** Publish one session add/update/remove change. */
  publishChange(key: string, change: SessionChange): void {
    this.publish({ kind: 'change', key, change })
  }

  /** Publish the instances whose reachability changed. */
  publishStates(states: readonly InstanceStateFrame[]): void {
    if (states.length === 0) return
    this.publish({ kind: 'states', states })
  }

  /** Publish a complete replacement tree. */
  publishTree(tree: readonly InstanceNode[]): void {
    this.publish({ kind: 'tree', tree })
  }

  /**
   * End every live subscription and drop its backlog; a disposed hub stays
   * empty and later subscribers end immediately instead of waiting for a
   * frame the hub will never publish.
   */
  close(): void {
    this.closed = true
    for (const subscription of [...this.subscriptions]) this.finish(subscription)
    this.subscriptions.clear()
  }

  /**
   * Append one frame to every subscriber, evicting the oldest non-tree frame
   * when a queue is full. A subscriber that is already finished is skipped.
   * @param event - frame to deliver.
   */
  private publish(event: ControlPlaneEvent): void {
    if (this.closed || this.subscriptions.size === 0) return
    this.sequence += 1
    const queued: QueuedEvent = { sequence: this.sequence, event }
    for (const subscription of this.subscriptions) {
      if (subscription.done) continue
      if (subscription.queue.length >= this.queueLimit) this.evict(subscription)
      subscription.queue.push(queued)
      const notify = subscription.notify
      subscription.notify = undefined
      notify?.()
    }
  }

  /**
   * Drop the oldest frame that is not a `tree`. When a queue is somehow all
   * trees, the oldest tree goes: a later full tree still supersedes it.
   * @param subscription - subscriber whose queue overflowed.
   */
  private evict(subscription: Subscription): void {
    const index = subscription.queue.findIndex(entry => entry.event.kind !== 'tree')
    subscription.queue.splice(index < 0 ? 0 : index, 1)
  }

  /**
   * Drive one subscription's frames.
   * @param snapshot - composes the initial tree.
   * @param signal - ends the stream.
   * @returns the initial tree, then published frames in order.
   */
  private async *stream(
    snapshot: () => Promise<readonly InstanceNode[]>,
    signal: AbortSignal,
  ): AsyncIterable<ControlPlaneEvent> {
    // A closed hub has nothing to say to a late subscriber; ending here keeps
    // the caller from waiting on a stream that can never produce a frame.
    if (this.closed) return
    const subscription: Subscription = { queue: [], notify: undefined, done: false }
    const wake = (): void => {
      const notify = subscription.notify
      subscription.notify = undefined
      notify?.()
    }
    // Cleanup must not wait for the generator: an abort may arrive while the
    // initial snapshot is still composing, and the subscriber has to leave the
    // hub (and its listener be dropped) at that moment, not when the snapshot
    // finally settles. `finish` is idempotent, and the `finally` below repeats
    // both steps for every other exit path.
    const abort = (): void => {
      signal.removeEventListener('abort', abort)
      this.finish(subscription)
      wake()
    }
    this.subscriptions.add(subscription)
    // An abort that happened before subscribing never fires the listener.
    if (signal.aborted) {
      this.finish(subscription)
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const tree = await snapshot()
      // Frames published before this snapshot resolved predate the view it
      // produced; replaying a queued tree would move the client backwards.
      const baseline = this.sequence
      for (let index = subscription.queue.length - 1; index >= 0; index -= 1) {
        const entry = subscription.queue[index]
        if (entry !== undefined && entry.sequence <= baseline && entry.event.kind === 'tree') {
          subscription.queue.splice(index, 1)
        }
      }
      if (subscription.done) return
      yield { kind: 'tree', tree }
      while (!subscription.done) {
        const next = subscription.queue.shift()
        if (next === undefined) {
          await new Promise<void>((resolve) => { subscription.notify = resolve })
          continue
        }
        yield next.event
      }
    } finally {
      signal.removeEventListener('abort', abort)
      this.finish(subscription)
    }
  }

  /**
   * Mark one subscription finished and drop everything it had queued.
   * @param subscription - subscription to end.
   */
  private finish(subscription: Subscription): void {
    subscription.done = true
    subscription.queue.length = 0
    this.subscriptions.delete(subscription)
    // Wake a generator parked on `notify`: `close()` ends live streams, and a
    // consumer awaiting the next frame must observe that end instead of
    // hanging on a promise no publisher will ever resolve.
    const notify = subscription.notify
    subscription.notify = undefined
    notify?.()
  }
}
