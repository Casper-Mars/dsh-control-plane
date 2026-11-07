// @vitest-environment jsdom
/**
 * t100642 — the sidebar's live event consumer.
 *
 * These tests drive the section with a controllable frame source instead of a
 * socket, so each acceptance point is observable on its own:
 *
 * - a `status` frame flips one row's dot without any tree read;
 * - two `change` frames inside the 300ms window collapse into one read;
 * - a `states` frame repaints reachability immediately;
 * - a stream that ends reconnects with backoff and applies the new first tree;
 * - unmounting aborts the subscription;
 * - without an `events` reader the fallback still polls every 30s (and not at
 *   the old 6s cadence).
 */
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InstanceGroups, type InstanceGroupView, type InstanceGroupsEvent, type InstanceSessionView,
} from '../src/client/InstanceGroups.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate({ ...commonEn, ...en })

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** Flush the already-resolved promises inside act. */
async function settle(rounds = 4): Promise<void> {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve()
  })
}

/** Advance fake timers and flush the promises they resolve. */
async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

/** One session row. */
function session(key: string, running = false): InstanceSessionView {
  const sessionId = key.slice(key.indexOf(':') + 1)
  return { key, sessionId, running, updatedAt: 1_000, title: sessionId }
}

/** One connected instance with one workspace holding `sessions`. */
function group(sessions: readonly InstanceSessionView[]): InstanceGroupView {
  const runningCount = sessions.filter(row => row.running).length
  return {
    instanceId: 'alpha',
    label: 'Alpha(alpha)',
    state: 'connected',
    runningCount,
    sessionCount: sessions.length,
    workspaces: [{
      key: 'alpha:/w',
      path: '/workspace',
      sessions,
      runningCount,
    }],
  }
}

/** One tree with a single session, running or not. */
function tree(running: boolean): readonly InstanceGroupView[] {
  return [group([session('alpha:s-1', running)])]
}

/** Queue depth / abort bookkeeping of one controllable frame source. */
interface EventSource {
  /** Stream factory the section subscribes through. */
  readonly stream: (signal: AbortSignal) => AsyncIterable<InstanceGroupsEvent>
  /** Signals every subscription attempt received, in order. */
  readonly signals: AbortSignal[]
  /** Subscription attempts so far. */
  readonly attempts: number
  /** Deliver one frame. */
  push(frame: InstanceGroupsEvent): void
  /** End the current stream cleanly. */
  end(): void
  /** Fail the current stream. */
  fail(error: unknown): void
}

/**
 * A frame source whose stream stays open until the test ends it, fails it, or
 * aborts the subscriber. Frames pushed between subscriptions wait for the next
 * subscriber, which mirrors a Host that starts a fresh stream with a tree.
 * @returns the source and its observers.
 */
function eventSource(): EventSource {
  const queue: InstanceGroupsEvent[] = []
  const signals: AbortSignal[] = []
  let wake: (() => void) | undefined
  let ended = false
  let failure: unknown
  let attempts = 0

  const notify = (): void => {
    const resolve = wake
    wake = undefined
    resolve?.()
  }

  const stream = (signal: AbortSignal): AsyncIterable<InstanceGroupsEvent> => {
    attempts += 1
    signals.push(signal)
    // Each connection is a fresh stream: an earlier clean end does not apply.
    ended = false
    let closed = false
    const onAbort = (): void => {
      closed = true
      notify()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (!closed) {
            const item = queue.shift()
            if (item !== undefined) {
              yield item
              continue
            }
            if (failure !== undefined) {
              const error = failure
              failure = undefined
              throw error
            }
            if (ended) return
            await new Promise<void>((resolve) => { wake = resolve })
            wake = undefined
          }
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      },
    }
  }

  return {
    stream,
    signals,
    get attempts(): number { return attempts },
    push(frame: InstanceGroupsEvent): void {
      queue.push(frame)
      notify()
    },
    end(): void {
      ended = true
      notify()
    },
    fail(error: unknown): void {
      failure = error
      notify()
    },
  }
}

/** A fetch reader that always resolves the given tree and counts its calls. */
function reader(value: readonly InstanceGroupView[]): ReturnType<typeof vi.fn<() => Promise<readonly InstanceGroupView[]>>> {
  return vi.fn(async () => value)
}

/** The dot state inside one session row. */
function rowDot(container: HTMLElement, key: string): string | null {
  return container.querySelector(`[data-session-key="${key}"] [data-state]`)?.getAttribute('data-state') ?? null
}

describe('t100642 / status frames', () => {
  it('flips one running row in place without reading the tree again', async () => {
    vi.useFakeTimers()
    const fetchTree = reader(tree(false))
    const source = eventSource()
    const { container } = render(
      <InstanceGroups fetchTree={fetchTree} retry={vi.fn(async () => {})} events={source.stream} t={t} />,
    )
    await settle()
    expect(fetchTree).toHaveBeenCalledTimes(1)
    expect(rowDot(container, 'alpha:s-1')).toBe('idle')

    source.push({ kind: 'status', key: 'alpha:s-1', running: true })
    await settle()

    expect(rowDot(container, 'alpha:s-1')).toBe('ongoing')
    expect(fetchTree).toHaveBeenCalledTimes(1)
    // The fallback poll is still armed; nothing fired at the old 6s cadence.
    await advance(6000)
    expect(fetchTree).toHaveBeenCalledTimes(1)
  })

  it('ignores a status frame for an unknown key', async () => {
    vi.useFakeTimers()
    const fetchTree = reader(tree(false))
    const source = eventSource()
    const { container } = render(
      <InstanceGroups fetchTree={fetchTree} retry={vi.fn(async () => {})} events={source.stream} t={t} />,
    )
    await settle()

    source.push({ kind: 'status', key: 'beta:s-9', running: true })
    await settle()
    expect(rowDot(container, 'alpha:s-1')).toBe('idle')
    expect(fetchTree).toHaveBeenCalledTimes(1)
  })
})

describe('t100642 / change frames', () => {
  it('coalesces a burst into one refresh after the 300ms window', async () => {
    vi.useFakeTimers()
    const fetchTree = vi.fn(async () => tree(false))
    const refreshTree = vi.fn(async () => [group([session('alpha:s-1'), session('alpha:s-2')])])
    const source = eventSource()
    render(
      <InstanceGroups
        fetchTree={fetchTree} refreshTree={refreshTree} retry={vi.fn(async () => {})} events={source.stream} t={t}
      />,
    )
    await settle()
    expect(fetchTree).toHaveBeenCalledTimes(1)
    expect(refreshTree).not.toHaveBeenCalled()

    source.push({ kind: 'change', key: 'alpha:s-2', change: 'added' })
    await advance(100)
    source.push({ kind: 'change', key: 'alpha:s-2', change: 'updated' })
    await advance(100)
    expect(refreshTree).not.toHaveBeenCalled()

    await advance(100)
    expect(refreshTree).toHaveBeenCalledTimes(1)
    expect(screen.getByText('s-2')).toBeTruthy()
  })

  it('refreshes again only after a new window opens', async () => {
    vi.useFakeTimers()
    const refreshTree = vi.fn(async () => tree(false))
    const source = eventSource()
    render(
      <InstanceGroups
        fetchTree={reader(tree(false))} refreshTree={refreshTree} retry={vi.fn(async () => {})} events={source.stream}
        t={t}
      />,
    )
    await settle()

    source.push({ kind: 'change', key: 'alpha:s-2', change: 'added' })
    await advance(300)
    expect(refreshTree).toHaveBeenCalledTimes(1)

    source.push({ kind: 'change', key: 'alpha:s-3', change: 'added' })
    await advance(300)
    expect(refreshTree).toHaveBeenCalledTimes(2)
  })
})

describe('t100642 / states frames', () => {
  it('repaints reachability without reading the tree', async () => {
    vi.useFakeTimers()
    const fetchTree = reader(tree(false))
    const source = eventSource()
    const { container } = render(
      <InstanceGroups fetchTree={fetchTree} retry={vi.fn(async () => {})} events={source.stream} t={t} />,
    )
    await settle()
    expect(container.querySelector('[data-instance-state="connected"]')).not.toBeNull()

    source.push({ kind: 'states', states: [{ instanceId: 'alpha', state: 'unreachable', error: 'down' }] })
    await settle()

    const header = container.querySelector('[data-instance-state="unreachable"]')
    expect(header).not.toBeNull()
    expect(header?.textContent).toContain('Offline')
    expect(container.querySelector('[data-instance-offline]')?.textContent).toContain('down')
    expect(fetchTree).toHaveBeenCalledTimes(1)
  })
})

describe('t100642 / reconnection', () => {
  it('reconnects with backoff and applies the first tree of the new stream', async () => {
    vi.useFakeTimers()
    const fetchTree = reader(tree(false))
    const source = eventSource()
    const { container } = render(
      <InstanceGroups fetchTree={fetchTree} retry={vi.fn(async () => {})} events={source.stream} t={t} />,
    )
    await settle()
    expect(source.attempts).toBe(1)

    source.push({ kind: 'tree', tree: [group([session('alpha:s-1'), session('alpha:s-2')])] })
    await settle()
    expect(screen.getByText('s-2')).toBeTruthy()

    source.end()
    await settle()
    expect(source.attempts).toBe(1)

    // Backoff starts at 1s (half-to-full jitter): one second always reconnects.
    await advance(1000)
    expect(source.attempts).toBe(2)

    source.push({ kind: 'tree', tree: [group([session('alpha:s-9')])] })
    await settle()
    expect(screen.getByText('s-9')).toBeTruthy()
    expect(container.querySelector('[data-session-key="alpha:s-1"]')).toBeNull()
  })

  it('keeps backing off after a throwing stream and still recovers', async () => {
    vi.useFakeTimers()
    const source = eventSource()
    render(
      <InstanceGroups fetchTree={reader(tree(false))} retry={vi.fn(async () => {})} events={source.stream} t={t} />,
    )
    await settle()

    source.push({ kind: 'tree', tree: tree(true) })
    await settle()
    // A frame arrived, so the next failure starts over at the first delay.
    source.fail(new Error('carrier lost'))
    await settle()
    await advance(1000)
    expect(source.attempts).toBe(2)

    source.fail(new Error('carrier lost again'))
    await settle()
    // No frame since the last subscribe: the delay doubles to 2s.
    await advance(1000)
    expect(source.attempts).toBe(2)
    await advance(1000)
    expect(source.attempts).toBe(3)
  })

  it('aborts the subscription on unmount', async () => {
    vi.useFakeTimers()
    const source = eventSource()
    const { unmount } = render(
      <InstanceGroups fetchTree={reader(tree(false))} retry={vi.fn(async () => {})} events={source.stream} t={t} />,
    )
    await settle()

    const signal = source.signals[0]
    expect(signal?.aborted).toBe(false)
    unmount()
    expect(signal?.aborted).toBe(true)
    // A frame arriving after unmount changes nothing and starts no read.
    source.push({ kind: 'status', key: 'alpha:s-1', running: true })
    await settle()
    expect(document.querySelector('[data-dsh-instance-groups]')).toBeNull()
  })
})

describe('t100642 / fallback polling', () => {
  it('polls at 30s when no event reader is wired', async () => {
    vi.useFakeTimers()
    const fetchTree = reader(tree(false))
    render(<InstanceGroups fetchTree={fetchTree} retry={vi.fn(async () => {})} t={t} />)
    await settle()
    expect(fetchTree).toHaveBeenCalledTimes(1)

    await advance(6000)
    expect(fetchTree).toHaveBeenCalledTimes(1)

    await advance(24_000)
    expect(fetchTree).toHaveBeenCalledTimes(2)
  })

  it('keeps the 30s poll running beside a live stream', async () => {
    vi.useFakeTimers()
    const fetchTree = reader(tree(false))
    const source = eventSource()
    render(
      <InstanceGroups fetchTree={fetchTree} retry={vi.fn(async () => {})} events={source.stream} t={t} />,
    )
    await settle()
    expect(fetchTree).toHaveBeenCalledTimes(1)

    await advance(29_000)
    expect(fetchTree).toHaveBeenCalledTimes(1)
    await advance(1000)
    expect(fetchTree).toHaveBeenCalledTimes(2)
  })
})
