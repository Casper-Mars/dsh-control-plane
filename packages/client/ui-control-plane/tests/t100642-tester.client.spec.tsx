// @vitest-environment jsdom
/**
 * t100642 — 独立测试者复验（客户端侧）。
 *
 * 与开发者的 `t100642-events.client.spec.tsx` 无关：这里的每个用例只针对
 * 本次修复的一条运行时事实，并且都用可推进的假时钟观察，而不是复用对方的断言。
 *
 * 覆盖：
 * 1. `refreshTree` 失败不重置 30s 兜底节奏（失败后下一次轮询仍在挂载后的 30s）。
 * 2. 卸载/abort 后没有残留的退避 timer 与去抖 timer，也不会再订阅或再读树。
 */
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InstanceGroups, type InstanceGroupView, type InstanceGroupsEvent, type InstanceSessionView,
} from '../src/client/InstanceGroups.tsx'
import { en } from '@deepseek-ai/dsh-client-ui-sidebar/src/client/locales.ts'

const t = makeTranslate({ ...commonEn, ...en })

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** 排掉已解决的 promise 链（React 的 act 包裹）。 */
async function settle(rounds = 6): Promise<void> {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve()
  })
}

/** 推进假时钟并排空它唤醒的 promise。 */
async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

/** 一条会话行。 */
function session(key: string, running = false): InstanceSessionView {
  return { key, sessionId: key.slice(key.indexOf(':') + 1), running, updatedAt: 1_000 }
}

/** 一个连通实例、一个工作区、若干会话。 */
function group(sessions: readonly InstanceSessionView[]): InstanceGroupView {
  const runningCount = sessions.filter(row => row.running).length
  return {
    instanceId: 'alpha',
    label: 'Alpha(alpha)',
    state: 'connected',
    runningCount,
    sessionCount: sessions.length,
    workspaces: [{ key: 'alpha:/w', path: '/workspace', sessions, runningCount }],
  }
}

/** 一棵只含一条会话的树。 */
function tree(): readonly InstanceGroupView[] {
  return [group([session('alpha:s-1')])]
}

/** 可控帧源：流保持打开，直到测试主动结束它或卸载 abort。 */
interface EventSource {
  readonly stream: (signal: AbortSignal) => AsyncIterable<InstanceGroupsEvent>
  /** 每次订阅收到的 signal，按顺序。 */
  readonly signals: AbortSignal[]
  /** 订阅次数。 */
  readonly attempts: number
  push(frame: InstanceGroupsEvent): void
  end(): void
}

/**
 * 一个只在测试推动时才产帧的事件源。
 * @returns 帧源与其观测值。
 */
function eventSource(): EventSource {
  const queue: InstanceGroupsEvent[] = []
  const signals: AbortSignal[] = []
  let wake: (() => void) | undefined
  let ended = false
  let attempts = 0

  const notify = (): void => {
    const resolve = wake
    wake = undefined
    resolve?.()
  }

  const stream = (signal: AbortSignal): AsyncIterable<InstanceGroupsEvent> => {
    attempts += 1
    signals.push(signal)
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
  }
}

describe('t100642-tester / refreshTree 失败不重置 30s 兜底', () => {
  it('一次失败的 change 刷新之后，兜底轮询仍按挂载时刻的 30s 节奏触发', async () => {
    vi.useFakeTimers()
    const fetchTree = vi.fn(async () => tree())
    const refreshTree = vi.fn(async (): Promise<readonly InstanceGroupView[]> => {
      throw new Error('fixture: 读树失败')
    })
    const source = eventSource()
    render(
      <InstanceGroups
        fetchTree={fetchTree} refreshTree={refreshTree} retry={vi.fn(async () => {})} events={source.stream} t={t}
      />,
    )
    await settle()
    expect(fetchTree).toHaveBeenCalledTimes(1)

    // 走到 20s：兜底还没到点。
    await advance(20_000)
    expect(fetchTree).toHaveBeenCalledTimes(1)

    // change 帧打开 300ms 去抖窗口，读到一半失败。
    source.push({ kind: 'change', key: 'alpha:s-2', change: 'added' })
    await advance(300)
    expect(refreshTree).toHaveBeenCalledTimes(1)

    // 失败不重启计时器：9.7s 后（挂载后第 30s）兜底照常触发。
    await advance(9_700)
    expect(fetchTree).toHaveBeenCalledTimes(2)
    // 若失败把 interval 重置成“失败时刻 + 30s”，这里会没有任何新读取。
    await advance(300)
    expect(fetchTree).toHaveBeenCalledTimes(2)
  })

  it('失败期间保留上一棵树，不用空态覆盖', async () => {
    vi.useFakeTimers()
    const refreshTree = vi.fn(async (): Promise<readonly InstanceGroupView[]> => {
      throw new Error('fixture: 读树失败')
    })
    const source = eventSource()
    const { container } = render(
      <InstanceGroups
        fetchTree={vi.fn(async () => tree())} refreshTree={refreshTree} retry={vi.fn(async () => {})}
        events={source.stream} t={t}
      />,
    )
    await settle()

    source.push({ kind: 'change', key: 'alpha:s-2', change: 'added' })
    await advance(300)
    expect(refreshTree).toHaveBeenCalledTimes(1)
    // 旧行的 key 还在：失败没有把视图清空成“无实例”。
    expect(container.querySelector('[data-session-key="alpha:s-1"]')).not.toBeNull()
  })
})

describe('t100642-tester / 卸载与 abort 后的 timer 清理', () => {
  it('卸载清掉退避 timer 与去抖 timer，之后不再订阅、不再读树', async () => {
    vi.useFakeTimers()
    const refreshTree = vi.fn(async () => tree())
    const source = eventSource()
    const { unmount } = render(
      <InstanceGroups
        fetchTree={vi.fn(async () => tree())} refreshTree={refreshTree} retry={vi.fn(async () => {})}
        events={source.stream} t={t}
      />,
    )
    await settle()
    expect(source.attempts).toBe(1)

    // 一个 change 帧打开 300ms 去抖窗口。
    source.push({ kind: 'change', key: 'alpha:s-2', change: 'added' })
    await settle()
    // 流结束 → 进入指数退避等待（一个待执行的 setTimeout）。
    source.end()
    await settle()
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    unmount()

    // 卸载必须把退避 timer、去抖 timer、30s 兜底 interval 一起清掉。
    expect(vi.getTimerCount()).toBe(0)
    expect(source.signals[0]?.aborted).toBe(true)

    // 时间继续走：不会重连、不会再读树。
    await advance(60_000)
    expect(source.attempts).toBe(1)
    expect(refreshTree).not.toHaveBeenCalled()
  })

  it('退避等待中途卸载也能立即停住（不等退避到点）', async () => {
    vi.useFakeTimers()
    const source = eventSource()
    const { unmount } = render(
      <InstanceGroups fetchTree={vi.fn(async () => tree())} retry={vi.fn(async () => {})} events={source.stream} t={t} />,
    )
    await settle()

    source.end()
    await settle()
    // 退避已在等待中（未到点）。
    await advance(500)
    expect(source.attempts).toBe(1)
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
    await advance(120_000)
    expect(source.attempts).toBe(1)
  })
})
