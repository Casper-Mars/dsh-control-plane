/**
 * t100642 — 独立测试者验证（运行时语义、背压、快照竞态、真实 stream 路径）。
 *
 * 本文件不重用开发者的 `t100642-events.spec.ts`：断言从公开行为出发，
 * 只依赖 `ControlPlaneEventHub` / `ControlPlane.events()` / `typertGateway.stream`
 * 的对外契约，并且每个用例都覆盖验收标准里的一条运行时事实。
 *
 * 覆盖：
 * 1. 宿主事件语义：首帧 tree == snapshot；status/change 的 key 与内容；
 *    states 只含变化实例且按配置顺序；启动失败进基线，拨号失败 / 重连成功 /
 *    探活失败都出 states + tree。
 * 2. 背压与隔离：慢订阅者不阻塞快订阅者；队列满丢最旧非 tree，绝不丢 tree；
 *    abort 后订阅者清零、监听器移除、队列清空。
 * 3. 快照竞态：snapshot 未完成时发布的事件在首帧之后仍送达；旧 tree 不回放；
 *    快照未完成时 abort 立即清零订阅者且首个产出是 done。
 * 4. 真实 stream 路径：通过 `typertGateway.stream` 订阅 `controlPlane/events`，
 *    首帧 + 后续 status 帧到达，abort 以 gateway/cancelled 结束流。
 * 5. 修复复验：运行中 dispose 关流（已订阅结束、新订阅立即结束、连接与刷新循环停止）。
 */
import { Context } from '@deepseek-ai/cordis'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService, { type TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedInstance } from '../src/config.ts'
import { InstanceConnections, type InstanceConnection, type OpenUpstream } from '../src/connections.ts'
import { ControlPlaneEventHub, diffInstanceStates } from '../src/events.ts'
import { ControlPlane } from '../src/index.ts'
import type {
  ControlPlaneEvent, InstanceNode, InstanceStateFrame, SessionRow, UpstreamState,
} from '../src/types.ts'

const INSTANCES: readonly ResolvedInstance[] = [
  { id: 'alpha', name: 'Alpha', host: '127.0.0.1', port: 1, baseUrl: 'http://127.0.0.1:1' },
]

/** 一条会话行。 */
function row(sessionId: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return { sessionId, updatedAt: 1, running: false, ...overrides }
}

/** 一棵只含一个实例、一条会话的树（hub 用例使用）。 */
function treeOf(running = false): readonly InstanceNode[] {
  return [{
    instanceId: 'alpha',
    label: 'Alpha(alpha)',
    state: 'connected',
    runningCount: running ? 1 : 0,
    sessionCount: 1,
    workspaces: [{
      key: 'alpha:/w',
      path: '/w',
      runningCount: running ? 1 : 0,
      latestUpdatedAt: 1,
      sessions: [{
        key: 'alpha:s-1',
        sessionId: 's-1',
        instanceId: 'alpha',
        running,
        updatedAt: 1,
      }],
    }],
  }]
}

/** 取一帧；流提前结束就显式失败，避免断言落在 undefined 上。 */
async function nextFrame(iterator: AsyncIterator<ControlPlaneEvent>): Promise<ControlPlaneEvent> {
  const result = await iterator.next()
  if (result.done === true) throw new Error('fixture: 事件流提前结束')
  return result.value
}

/** 排空当前已入队的帧（不等待新事件）。 */
async function drain(iterator: AsyncIterator<ControlPlaneEvent>, limit: number): Promise<ControlPlaneEvent[]> {
  const frames: ControlPlaneEvent[] = []
  for (let index = 0; index < limit; index += 1) frames.push(await nextFrame(iterator))
  return frames
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 1 — 宿主事件语义（hub 层）
// ---------------------------------------------------------------------------
describe('t100642-tester / 首帧语义', () => {
  it('订阅首帧是 tree，且内容就是 snapshot 的返回值', async () => {
    const hub = new ControlPlaneEventHub()
    const controller = new AbortController()
    let calls = 0
    const snapshot = async (): Promise<readonly InstanceNode[]> => {
      calls += 1
      return treeOf()
    }
    const iterator = hub.subscribe(snapshot, controller.signal)[Symbol.asyncIterator]()

    const first = await nextFrame(iterator)
    expect(calls).toBe(1)
    expect(first.kind).toBe('tree')
    if (first.kind !== 'tree') throw new Error('unreachable')
    // snapshot 就是这个 fixture：首帧必须与它的返回值逐字段相等。
    await expect(snapshot()).resolves.toEqual(first.tree)
    controller.abort()
  })

  it('status / change 帧携带完整 federated key 与原样内容', async () => {
    const hub = new ControlPlaneEventHub()
    const controller = new AbortController()
    const iterator = hub.subscribe(async () => treeOf(), controller.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)

    hub.publishStatus('beta:session-42', false)
    hub.publishChange('beta:session-42', 'removed')

    expect(await nextFrame(iterator)).toEqual({ kind: 'status', key: 'beta:session-42', running: false })
    expect(await nextFrame(iterator)).toEqual({ kind: 'change', key: 'beta:session-42', change: 'removed' })
    controller.abort()
  })
})

// ---------------------------------------------------------------------------
// 2 — 背压与隔离
// ---------------------------------------------------------------------------
describe('t100642-tester / 背压与隔离', () => {
  it('一个从不推进的订阅者不影响另一个订阅者收到全部 status', async () => {
    const hub = new ControlPlaneEventHub(4)
    const slowController = new AbortController()
    const fastController = new AbortController()
    const slow = hub.subscribe(async () => treeOf(), slowController.signal)[Symbol.asyncIterator]()
    const fast = hub.subscribe(async () => treeOf(), fastController.signal)[Symbol.asyncIterator]()
    await nextFrame(slow)
    await nextFrame(fast)

    const keys: string[] = []
    for (let index = 0; index < 12; index += 1) {
      const key = `alpha:s-${String(index)}`
      hub.publishStatus(key, true)
      const frame = await nextFrame(fast)
      expect(frame.kind).toBe('status')
      if (frame.kind === 'status') keys.push(frame.key)
    }
    expect(keys).toHaveLength(12)

    // 慢订阅者一帧都没取，队列被上限约束住，不会无限增长。
    const counts = hub.pendingCounts()
    expect(counts).toHaveLength(2)
    expect(counts[0]).toEqual({ queued: 4 })

    slowController.abort()
    fastController.abort()
  })

  it('队列满时丢最旧的非 tree 帧，tree 帧始终保留', async () => {
    const hub = new ControlPlaneEventHub(3)
    const controller = new AbortController()
    const iterator = hub.subscribe(async () => treeOf(), controller.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)

    hub.publishStatus('alpha:s-1', true)
    hub.publishStatus('alpha:s-2', true)
    hub.publishStatus('alpha:s-3', true)
    // 队列已满：tree 入队时挤掉最旧的 status（s-1）。
    hub.publishTree(treeOf(true))
    // 再来一条 status：挤掉 s-2，tree 仍在。
    hub.publishStatus('alpha:s-4', true)

    const frames = await drain(iterator, 3)
    expect(frames[0]).toEqual({ kind: 'status', key: 'alpha:s-3', running: true })
    expect(frames[1]?.kind).toBe('tree')
    expect(frames[2]).toEqual({ kind: 'status', key: 'alpha:s-4', running: true })
    // 被挤掉的旧帧没有回放。
    const keys = frames.flatMap(frame => frame.kind === 'status' ? [frame.key] : [])
    expect(keys).not.toContain('alpha:s-1')
    expect(keys).not.toContain('alpha:s-2')
    controller.abort()
  })

  it('队列里全是 tree 时按最旧丢弃，后续 tree 仍能覆盖', async () => {
    const hub = new ControlPlaneEventHub(2)
    const controller = new AbortController()
    const iterator = hub.subscribe(async () => treeOf(), controller.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)

    hub.publishTree(treeOf(false))
    hub.publishTree(treeOf(true))
    hub.publishTree(treeOf(false))

    const first = await nextFrame(iterator)
    expect(first.kind).toBe('tree')
    if (first.kind !== 'tree') throw new Error('unreachable')
    // 队列保留的是后两棵（最新状态为 running=true 的那棵还在）。
    expect(first.tree[0]?.runningCount).toBe(1)
    controller.abort()
  })

  it('abort 后订阅者清零、abort 监听器被移除、队列清空', async () => {
    const hub = new ControlPlaneEventHub()
    const controller = new AbortController()
    const addSpy = vi.spyOn(controller.signal, 'addEventListener')
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')
    const iterator = hub.subscribe(async () => treeOf(), controller.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)
    expect(hub.subscriberCount).toBe(1)
    expect(addSpy.mock.calls.some(([type]) => type === 'abort')).toBe(true)

    hub.publishStatus('alpha:s-1', true)
    expect(hub.pendingCounts()).toEqual([{ queued: 1 }])

    controller.abort()
    expect(hub.subscriberCount).toBe(0)
    expect(hub.pendingCounts()).toEqual([])
    expect(removeSpy.mock.calls.some(([type]) => type === 'abort')).toBe(true)
    expect((await iterator.next()).done).toBe(true)
  })

  it('close() 结束后来的订阅者拿不到帧，也不会复活旧订阅', async () => {
    const hub = new ControlPlaneEventHub()
    const controller = new AbortController()
    const iterator = hub.subscribe(async () => treeOf(), controller.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)

    hub.close()
    expect((await iterator.next()).done).toBe(true)
    hub.publishStatus('alpha:s-1', true)
    expect(hub.subscriberCount).toBe(0)
    expect(hub.pendingCounts()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3 — 快照竞态
// ---------------------------------------------------------------------------
describe('t100642-tester / 快照竞态', () => {
  it('snapshot 未完成时发布的 status/change 在首帧之后仍送达，旧 tree 不回放', async () => {
    const hub = new ControlPlaneEventHub()
    const controller = new AbortController()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    const iterator = hub.subscribe(async () => {
      await gate
      return treeOf(true)
    }, controller.signal)[Symbol.asyncIterator]()

    // 让生成器真正进入 snapshot 等待。
    const pending = nextFrame(iterator)
    await Promise.resolve()

    // 快照期间发布两棵旧树 + 一条 status + 一条 change。
    hub.publishTree(treeOf(false))
    hub.publishTree(treeOf(false))
    hub.publishStatus('alpha:s-2', true)
    hub.publishChange('alpha:s-3', 'added')
    release()

    const first = await pending
    expect(first.kind).toBe('tree')
    if (first.kind !== 'tree') throw new Error('unreachable')
    // 首帧是 snapshot 的结果（running=true），不是排队里的旧树。
    expect(first.tree[0]?.runningCount).toBe(1)

    expect(await nextFrame(iterator)).toEqual({ kind: 'status', key: 'alpha:s-2', running: true })
    expect(await nextFrame(iterator)).toEqual({ kind: 'change', key: 'alpha:s-3', change: 'added' })
    controller.abort()
  })

  it('snapshot 完成后发布的新 tree 正常送达（不被基线误删）', async () => {
    const hub = new ControlPlaneEventHub()
    const controller = new AbortController()
    const iterator = hub.subscribe(async () => treeOf(false), controller.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)

    hub.publishTree(treeOf(true))
    const tree = await nextFrame(iterator)
    expect(tree.kind).toBe('tree')
    if (tree.kind !== 'tree') throw new Error('unreachable')
    expect(tree.tree[0]?.runningCount).toBe(1)
    controller.abort()
  })

  it('快照未完成时 abort：订阅者立即清零，首个产出是 done 而不是排队帧', async () => {
    const hub = new ControlPlaneEventHub()
    const controller = new AbortController()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    const iterator = hub.subscribe(async () => {
      await gate
      return treeOf()
    }, controller.signal)[Symbol.asyncIterator]()

    // 让生成器真正停在 snapshot 里，再在快照窗口内 abort。
    const pending = iterator.next()
    await Promise.resolve()
    hub.publishStatus('alpha:s-1', true)

    controller.abort()
    // 清理不能等快照结算：abort 的瞬间订阅者就离开 hub，队列一并丢弃。
    expect(hub.subscriberCount).toBe(0)
    expect(hub.pendingCounts()).toEqual([])

    release()
    // abort 之前入队的 status 不得被吐出；第一个结果必须是流结束。
    expect(await pending).toEqual({ done: true, value: undefined })

    // abort 之后 publish 也不得复活订阅或重新入队。
    hub.publishStatus('alpha:s-2', true)
    expect(hub.subscriberCount).toBe(0)
    expect(hub.pendingCounts()).toEqual([])
    expect((await iterator.next()).done).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4 — diffInstanceStates 的顺序契约（宿主 states 帧的排序依据）
// ---------------------------------------------------------------------------
describe('t100642-tester / states 顺序', () => {
  it('按配置顺序输出，与 after 对象的键顺序无关', () => {
    const before: Record<string, { state: UpstreamState; error?: string }> = {
      alpha: { state: 'connected' },
      beta: { state: 'connected' },
      gamma: { state: 'connected' },
    }
    // after 的键顺序刻意打乱（gamma, beta, alpha），配置顺序是 beta, gamma, alpha。
    const after: Record<string, { state: UpstreamState; error?: string }> = {
      gamma: { state: 'connected' },
      beta: { state: 'unreachable', error: 'refused' },
      alpha: { state: 'unreachable', error: 'timeout' },
    }
    const frames: readonly InstanceStateFrame[] = diffInstanceStates(before, after, ['beta', 'gamma', 'alpha'])
    expect(frames.map(frame => frame.instanceId)).toEqual(['beta', 'alpha'])
    expect(frames).toEqual([
      { instanceId: 'beta', state: 'unreachable', error: 'refused' },
      { instanceId: 'alpha', state: 'unreachable', error: 'timeout' },
    ])
  })

  it('未变化的实例不出现在帧里', () => {
    const before = { alpha: { state: 'connected' as UpstreamState }, beta: { state: 'connecting' as UpstreamState } }
    const frames = diffInstanceStates(before, {
      alpha: { state: 'connected' },
      beta: { state: 'connecting' },
    }, ['alpha', 'beta'])
    expect(frames).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5 — ControlPlane.events() 运行时语义（启动失败 → 恢复 → 探活失败）
// ---------------------------------------------------------------------------

/** 假 upstream 的可变状态。 */
interface FakeState {
  rows: readonly SessionRow[]
  reachability: UpstreamState
  error: string | undefined
  failWith: string | undefined
  disposed: boolean
}

/** 一个探活失败就抛 `failWith`、否则列出 `rows` 的假连接。 */
function fakeUpstream(state: FakeState): InstanceConnection {
  return {
    get reachability(): UpstreamState { return state.reachability },
    get error(): string | undefined { return state.error },
    async listSessions(): Promise<SessionRow[]> {
      if (state.failWith !== undefined) {
        state.reachability = 'unreachable'
        state.error = state.failWith
        throw new Error(state.failWith)
      }
      state.reachability = 'connected'
      state.error = undefined
      return [...state.rows]
    },
    createSession: async (): Promise<string> => 'session-new',
    onSessionStatus: (): (() => void) => () => {},
    async dispose(): Promise<void> { state.disposed = true },
  }
}

/** 一个可指定配置顺序的 bench。 */
function bench(open: OpenUpstream, instances: readonly ResolvedInstance[] = INSTANCES): {
  readonly control: ControlPlane
  readonly connections: InstanceConnections
} {
  const root = new Context()
  const ctx: Context = new Proxy(root, {
    get(target, property, receiver) {
      if (property === 'effect') return () => () => Promise.resolve()
      return Reflect.get(target, property, receiver) as unknown
    },
  })
  const control = new ControlPlane(ctx, {
    instances: instances.map(({ id, name, host, port }) => ({ id, name, host, port })),
  })
  const connections = new InstanceConnections(instances, { open })
  Object.assign(control, { connections })
  return { control, connections }
}

describe('t100642-tester / ControlPlane.events 运行时语义', () => {
  it('首帧内容等于 snapshot()，status/change 的 key 正确', async () => {
    vi.useFakeTimers()
    const state: FakeState = {
      rows: [row('s-1', { updatedAt: 10 })],
      reachability: 'connected',
      error: undefined,
      failWith: undefined,
      disposed: false,
    }
    const { control, connections } = bench(async () => fakeUpstream(state))
    await connections.connect()

    const controller = new AbortController()
    const iterator = control.events(controller.signal)[Symbol.asyncIterator]()
    const first = await nextFrame(iterator)
    expect(first.kind).toBe('tree')
    if (first.kind !== 'tree') throw new Error('unreachable')

    // 同一份状态再读一次 snapshot：首帧必须与它逐字段相等。
    const snapshot = await control.snapshot()
    expect(first.tree).toEqual(snapshot)
    expect(first.tree[0]?.instanceId).toBe('alpha')
    expect(first.tree[0]?.workspaces[0]?.sessions[0]?.key).toBe('alpha:s-1')

    // 一轮 diff：s-1 开始运行，s-2 新增。
    state.rows = [row('s-1', { updatedAt: 10, running: true }), row('s-2', { updatedAt: 20 })]
    await control.snapshot()
    expect(await nextFrame(iterator)).toEqual({ kind: 'status', key: 'alpha:s-1', running: true })
    expect(await nextFrame(iterator)).toEqual({ kind: 'change', key: 'alpha:s-2', change: 'added' })

    // 重复上报同一 running 状态不得再产生 status 帧。
    await control.snapshot()
    state.rows = [row('s-1', { updatedAt: 10, running: true }), row('s-2', { updatedAt: 30 })]
    await control.snapshot()
    // s-2 的 updatedAt 变化只产生 change(updated)，没有多余的 status。
    expect(await nextFrame(iterator)).toEqual({ kind: 'change', key: 'alpha:s-2', change: 'updated' })

    controller.abort()
    await control.dispose()
  })

  it('启动失败进入基线，重连成功与探活失败都发 states 帧（不依赖 snapshot）', async () => {
    vi.useFakeTimers()
    const instances: readonly ResolvedInstance[] = [
      { id: 'beta', name: 'Beta', host: '127.0.0.1', port: 2, baseUrl: 'http://127.0.0.1:2' },
      { id: 'alpha', name: 'Alpha', host: '127.0.0.1', port: 1, baseUrl: 'http://127.0.0.1:1' },
      { id: 'gamma', name: 'Gamma', host: '127.0.0.1', port: 3, baseUrl: 'http://127.0.0.1:3' },
    ]
    const states = new Map<string, FakeState>([
      ['beta', { rows: [row('s-b')], reachability: 'connected', error: undefined, failWith: undefined, disposed: false }],
      ['alpha', { rows: [row('s-a')], reachability: 'connected', error: undefined, failWith: undefined, disposed: false }],
      ['gamma', { rows: [row('s-g')], reachability: 'connected', error: undefined, failWith: undefined, disposed: false }],
    ])
    // alpha 启动时拨号就失败（open 抛错），beta/gamma 正常。
    const failingOpen = new Set(['alpha'])
    const { control, connections } = bench(async (instance) => {
      const state = states.get(instance.id)
      if (state === undefined) throw new Error(`fixture: 未预期的 ${instance.id}`)
      if (failingOpen.has(instance.id)) throw new Error(`${instance.id} refused`)
      return fakeUpstream(state)
    }, instances)

    // 启动发生在订阅之前：首帧 tree 就是这份启动结果的基线。
    await connections.connect()

    const controller = new AbortController()
    const iterator = control.events(controller.signal)[Symbol.asyncIterator]()
    const first = await nextFrame(iterator)
    expect(first.kind).toBe('tree')
    if (first.kind !== 'tree') throw new Error('unreachable')
    // 启动失败（alpha）已经写在首帧里：它不需要再发一条 states。
    expect(first.tree.map(node => `${node.instanceId}:${node.state}`)).toEqual([
      'beta:connected', 'alpha:unreachable', 'gamma:connected',
    ])
    expect(first.tree.find(node => node.instanceId === 'alpha')?.sessionCount).toBe(0)

    // ① 拨号失败：beta 已连通，重新拨号时 open 抛错 → connected → unreachable。
    failingOpen.add('beta')
    await control.reconnect({ instanceId: 'beta' })
    expect(await nextFrame(iterator)).toEqual({
      kind: 'states',
      states: [{ instanceId: 'beta', state: 'unreachable', error: 'beta refused' }],
    })
    const down = await nextFrame(iterator)
    expect(down.kind).toBe('tree')
    if (down.kind !== 'tree') throw new Error('unreachable')
    expect(down.tree.find(node => node.instanceId === 'beta')?.sessionCount).toBe(0)

    // ② 恢复：显式 reconnect，不依赖有 5s/实例限频的 recover()。
    failingOpen.delete('beta')
    await control.reconnect({ instanceId: 'beta' })
    expect(await nextFrame(iterator)).toEqual({
      kind: 'states',
      states: [{ instanceId: 'beta', state: 'connected' }],
    })
    const back = await nextFrame(iterator)
    expect(back.kind).toBe('tree')
    if (back.kind !== 'tree') throw new Error('unreachable')
    expect(back.tree.find(node => node.instanceId === 'beta')?.sessionCount).toBe(1)

    // ③ 探活失败：gamma 挂载成功但 listSessions 抛错，真实可达性从 connected 掉到 unreachable。
    const gamma = states.get('gamma')
    if (gamma === undefined) throw new Error('fixture: gamma 缺失')
    gamma.failWith = 'probe timeout'
    await control.reconnect({ instanceId: 'gamma' })
    expect(await nextFrame(iterator)).toEqual({
      kind: 'states',
      states: [{ instanceId: 'gamma', state: 'unreachable', error: 'probe timeout' }],
    })
    const gone = await nextFrame(iterator)
    expect(gone.kind).toBe('tree')
    if (gone.kind !== 'tree') throw new Error('unreachable')
    expect(gone.tree.find(node => node.instanceId === 'gamma')?.sessionCount).toBe(0)

    controller.abort()
    await control.dispose()
  })

  it('states 帧只在可达性真的变化时出现（稳定状态不刷帧）', async () => {
    vi.useFakeTimers()
    const state: FakeState = {
      rows: [row('s-1')],
      reachability: 'connected',
      error: undefined,
      failWith: undefined,
      disposed: false,
    }
    const { control, connections } = bench(async () => fakeUpstream(state))
    await connections.connect()

    const controller = new AbortController()
    const iterator = control.events(controller.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)

    // 两轮探活都成功：没有 states，也没有 tree。
    await control.snapshot()
    await control.snapshot()
    state.rows = [row('s-1', { updatedAt: 5 })]
    await control.snapshot()
    expect(await nextFrame(iterator)).toEqual({ kind: 'change', key: 'alpha:s-1', change: 'updated' })

    controller.abort()
    await control.dispose()
  })
})

// ---------------------------------------------------------------------------
// 6 — 真实 stream 路径：typertGateway.stream('controlPlane/events')
// ---------------------------------------------------------------------------
describe('t100642-tester / 真实 typertGateway.stream 路径', () => {
  const contexts: Context[] = []
  const disposers: (() => Promise<void>)[] = []

  afterEach(async () => {
    for (const dispose of disposers.splice(0).reverse()) await dispose()
    for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  })

  /**
   * 真实 Registry + 真实 Gateway + 真实 ControlPlane（只替换拨号 effect）。
   * @param state - 假 upstream 的可变状态。
   * @returns 真实 gateway 与 control。
   */
  async function gatewayBench(state: FakeState): Promise<{
    readonly ctx: Context
    readonly control: ControlPlane
    readonly gateway: TypertGateway
    readonly peer: Peer
  }> {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(TypertRegistry)
    // Gateway 硬依赖 remoteAccess（static inject = ['typert', 'remoteAccess']）；
    // 不挂它 gateway 永不启动，补真实插件而不是放宽依赖。
    await ctx.plugin(RemoteAccessService)
    await ctx.plugin(TypertGatewayService)
    const facade = new Proxy(ctx, {
      get(target, property, receiver) {
        if (property === 'effect') return () => () => {}
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    const control = new ControlPlane(facade, {
      instances: INSTANCES.map(({ id, name, host, port }) => ({ id, name, host, port })),
    })
    const connections = new InstanceConnections(INSTANCES, { open: async () => fakeUpstream(state) })
    Object.assign(control, { connections })
    disposers.push(async () => { await control.dispose() })
    await connections.connect()
    return { ctx, control, gateway: ctx.typertGateway, peer: new Peer(ctx.root, { principal: { kind: 'owner' } }) }
  }

  it('订阅 controlPlane/events：首帧 tree，随后 status 帧到达，abort 终止流', async () => {
    vi.useFakeTimers()
    const state: FakeState = {
      rows: [row('s-1', { updatedAt: 10 })],
      reachability: 'connected',
      error: undefined,
      failWith: undefined,
      disposed: false,
    }
    const { gateway, peer } = await gatewayBench(state)
    const abort = new AbortController()
    const stream = await gateway.stream({
      peer,
      namespace: 'controlPlane',
      method: 'events',
      args: {},
      signal: abort.signal,
    })
    const iterator = stream[Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first.done).toBe(false)
    const tree = first.value as ControlPlaneEvent
    expect(tree.kind).toBe('tree')
    if (tree.kind !== 'tree') throw new Error('unreachable')
    expect(tree.tree[0]?.sessionCount).toBe(1)
    expect(tree.tree[0]?.state).toBe('connected')

    // 让控制面自己的 2s 刷新循环发现“开始运行”，不手工调用 snapshot。
    state.rows = [row('s-1', { updatedAt: 10, running: true })]
    await vi.advanceTimersByTimeAsync(2000)
    const second = await iterator.next()
    expect(second.done).toBe(false)
    expect(second.value).toEqual({ kind: 'status', key: 'alpha:s-1', running: true })

    // abort 后流结束：本地 stream 把自己的取消以 gateway/cancelled 报告（静默 done 只属于
    // 联邦转发路径），且不再产帧。
    abort.abort()
    await expect(iterator.next()).rejects.toMatchObject({ code: 'gateway/cancelled' })
  })
})

// ---------------------------------------------------------------------------
// 7 — 修复复验：卸载关流、无残留 timer（独立于开发者的用例）
// ---------------------------------------------------------------------------
describe('t100642-tester / 修复复验：dispose 关流', () => {
  it('运行中 dispose()：已订阅流收到结束，之后的新订阅立即结束，连接与刷新循环都停掉', async () => {
    vi.useFakeTimers()
    const state: FakeState = {
      rows: [row('s-1')],
      reachability: 'connected',
      error: undefined,
      failWith: undefined,
      disposed: false,
    }
    const { control, connections } = bench(async () => fakeUpstream(state))
    await connections.connect()

    const controller = new AbortController()
    const iterator = control.events(controller.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)

    await control.dispose()

    // 消费方停在 yield 处：下一次 pull 直接拿到 done，而不是再等一帧。
    expect((await iterator.next()).done).toBe(true)
    // 之后的新订阅立即结束（hub 已关闭且 disposed 短路），不会复活后台循环。
    const late = new AbortController()
    expect((await control.events(late.signal)[Symbol.asyncIterator]().next()).done).toBe(true)
    // 连接被关闭。
    expect(state.disposed).toBe(true)
    // 2s 刷新循环随 dispose 停止：没有残留的待执行 timer。
    expect(vi.getTimerCount()).toBe(0)

    late.abort()
  })

  it('dispose() 唤醒正在等下一帧的消费方', async () => {
    const state: FakeState = {
      rows: [row('s-1')],
      reachability: 'connected',
      error: undefined,
      failWith: undefined,
      disposed: false,
    }
    const { control, connections } = bench(async () => fakeUpstream(state))
    await connections.connect()

    const controller = new AbortController()
    const iterator = control.events(controller.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)

    // 真实客户端的常态：for await 之后始终有一次挂起的 pull。
    const parked = iterator.next()
    // 让它真正跑到“队列空、等下一帧”的位置（而不是还没恢复执行）。
    for (let round = 0; round < 4; round += 1) await Promise.resolve()
    await control.dispose()

    const outcome = await Promise.race([
      parked.then(result => (result.done === true ? 'ended' : 'frame')),
      new Promise<string>((resolve) => { setTimeout(() => { resolve('hung') }, 100) }),
    ])
    expect(outcome).toBe('ended')

    controller.abort()
  })
})
