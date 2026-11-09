/** Registers the control-plane instance section into the sidebar's instances slot. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
// Type-only: pulls the sidebar locale namespace merge (`TranslateNS<'sidebar'>`).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session root standard-props merge.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import {
  instanceGroupsSlot, mainSessionId, type InstanceGroupView, type InstanceGroupsEvent, type SessionListSource,
} from './InstanceGroups.tsx'

/** One generated Remote result envelope. */
type RemoteFrame<T> = { ok: true; value: T } | { ok: false; error: unknown }

/** The control-plane Remote namespace this Client may compose. */
interface ControlPlaneRemote {
  tree: () => Promise<RemoteFrame<readonly InstanceGroupView[]>>
  reconnect: (request: { readonly instanceId: string }) => Promise<RemoteFrame<unknown>>
  /**
   * Live sidebar frames. Optional: a Host from before this endpoint has no
   * `events`, and the section then keeps its fallback poll as the only path.
   */
  events?: (signal?: AbortSignal) => AsyncIterable<InstanceGroupsEvent>
}

/**
 * Resolve the control-plane Remote namespace, when this Client is composed as
 * one.
 *
 * A Remote namespace is its own Cordis service (key `remote.<namespace>`), not
 * a property of a `remote` object; the lookup stays lazy because the namespace
 * may mount after this apply.
 * @param ctx - client root context.
 * @returns the namespace face, or undefined on a plain dsh Client.
 */
function controlPlaneRemote(ctx: ClientContext): ControlPlaneRemote | undefined {
  const remote = ctx.get('remote.controlPlane') as ControlPlaneRemote | undefined
  return remote
}

/** Stable empty frames: a plain dsh Client re-reads "no control plane" every poll. */
const NO_GROUPS: readonly InstanceGroupView[] = []

/** An event stream that ends immediately, for a namespace that is not there. */
const NO_EVENTS: AsyncIterable<InstanceGroupsEvent> = {
  async *[Symbol.asyncIterator]() {
    // No control plane: the section stays on the fallback poll.
  },
}

interface WorkspaceNavigation {
  /**
   * Opens a Session; the control-plane rows pass a complete federated key and
   * the Workspace path they grouped it under (the only `cwd` evidence a remote
   * Session has on this Client).
   */
  openSession(target: string, hint?: { readonly cwd?: string | undefined }): void
}

/**
 * Snapshot source for the instance section's current-Session marker.
 *
 * Binding through `ctx.inject` keeps the source optional yet reactive: it
 * attaches when the service mounts and reports "no current Session" again when
 * the service goes away.
 * @param ctx - client root context.
 * @returns the observable the rows subscribe to for their current marker.
 */
function currentSessionSource(ctx: ClientContext): ObservableSnapshot<string | undefined> {
  const store = createSnapshotStore<string | undefined>(undefined)
  ctx.inject(['sessions'], (scope) => {
    const list = (scope.get('sessions') as { list?: SessionListSource } | undefined)?.list
    if (list === undefined) return
    const sync = (): void => { store.set(mainSessionId(list.getSnapshot())) }
    sync()
    scope.effect(() => {
      const unsubscribe = list.subscribe(sync)
      return () => {
        unsubscribe()
        store.set(undefined)
      }
    }, 'ui-control-plane: current session')
  })
  return { getSnapshot: () => store.getSnapshot(), subscribe: listener => store.subscribe(listener) }
}

/** The slice of the Session Controller face the instance section creates through. */
interface SessionCreateFace {
  create(opts: { workspaceId?: string }): Promise<string>
}

/**
 * Bind the optional Session Controller's `create` call for the instance
 * section.
 *
 * Like {@link currentSessionSource}, the service is not a hard dependency: the
 * face resolves when the service mounts and is forgotten when it goes away; a
 * call made while it is absent fails with a readable message.
 * @param ctx - client root context.
 * @returns a create function taking one complete federated Workspace key.
 */
function sessionCreate(ctx: ClientContext): (workspaceId: string) => Promise<string> {
  let sessions: SessionCreateFace | undefined
  ctx.inject(['sessions'], (scope) => {
    const face = scope.get('sessions') as SessionCreateFace | undefined
    sessions = face
    scope.effect(() => () => {
      if (sessions === face) sessions = undefined
    }, 'ui-control-plane: session create')
  })
  return async (workspaceId) => {
    const face = sessions
    if (face === undefined || typeof face.create !== 'function') {
      throw new Error('sessions service is unavailable')
    }
    return await face.create({ workspaceId })
  }
}

/** Services required by the control-plane sidebar section. */
export const inject = ['slots', 'uiWorkspace']

/** Registers the instance section into the sidebar.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const workspaceNavigation = ctx.get('uiWorkspace') as unknown as WorkspaceNavigation
  // 控制面组合进来时才渲染实例分组；普通 dsh 里这个命名空间不存在，读取返回同一个
  // 空帧，组件不渲染、也不产生任何 Remote 调用。
  // 读取失败时抛错（而不是返回空树），组件据此保留上一帧。实例状态由 tree 帧自带，
  // 不再单独轮询 instances，避免两次读取给出不一致的在线状态。
  const readTree = async (): Promise<readonly InstanceGroupView[]> => {
    const controlPlane = controlPlaneRemote(ctx)
    if (controlPlane === undefined) return NO_GROUPS
    const result = await controlPlane.tree()
    if (!result.ok) throw result.error
    return result.value
  }
  const createSession = sessionCreate(ctx)
  // The namespace can mount after this apply, so the stream re-resolves it per
  // connection instead of capturing one face. Present only when the Client is
  // composed as a control plane; a plain dsh Client never subscribes.
  const readEvents = (signal: AbortSignal): AsyncIterable<InstanceGroupsEvent> => {
    const controlPlane = controlPlaneRemote(ctx)
    if (controlPlane?.events === undefined) return NO_EVENTS
    return controlPlane.events(signal)
  }
  const controlPlaneComposed = controlPlaneRemote(ctx)?.events !== undefined
  ctx.slots.inject('sidebar.instances', () => ctx.slots.register({
    name: 'sidebar.instances',
    // The sidebar owns the dictionary this section reads; ui-sidebar is in the
    // inject list, so the namespace is registered before this slot mounts.
    locale: 'sidebar',
  }, instanceGroupsSlot({
    fetchTree: readTree,
    // 新建成功后立即重读，而不是等下一次 6s 轮询。
    refreshTree: readTree,
    // 工作区行携带的是真实的 `<instanceId>:<workspaceId>`；联邦路由剥前缀转发，
    // 远端按 id 查注册表（路径会 workspace/not-found），返回裸 sessionId，
    // 前缀由实例分区在导航前拼回。
    createSession,
    retry: async (instanceId) => {
      const controlPlane = controlPlaneRemote(ctx)
      if (controlPlane === undefined) return
      // 失败是一个值（state/error），随后重读 tree 就能看到原因；这里不抛。
      await controlPlane.reconnect({ instanceId })
    },
    // 行点击直接交给 Workspace UI：键是 `<instanceId>:<localSessionId>`，
    // 由网关的联邦路由拆分，控制面侧不做任何前缀处理。
    openSession: (key, cwd) => { workspaceNavigation.openSession(key, cwd === undefined ? undefined : { cwd }) },
    currentSession: currentSessionSource(ctx),
    ...(controlPlaneComposed ? { events: readEvents } : {}),
  })))
}
