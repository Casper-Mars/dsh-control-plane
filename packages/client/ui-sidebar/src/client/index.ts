/** Registers the sidebar shell and global panel navigation. */
import type {} from '@deepseek-ai/dsh-client-product-analytics/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session root standard-props merge.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SidebarPanelMetadata, SidebarRootInjected, SidebarSectionInjected } from './contract/slots.ts'
import { createPanelPins } from './panel-pins.ts'
import { HeaderLeadingControls } from './HeaderLeadingControls.tsx'
import { SidebarRoot } from './SidebarRoot.tsx'
import {
  instanceGroupsSlot, mainSessionId, type InstanceGroupView, type SessionListSource,
} from './InstanceGroups.tsx'
import { PanelIcon } from './PanelIcon.tsx'
import { en, ja, es, fr, de, ru, pt, zh, type SidebarKey } from './locales.ts'

export type {
  SidebarBrandMarkOwnerProps, SidebarBrandNameOwnerProps, SidebarFooterActionOwnerProps,
  SidebarPanelActionEntry, SidebarPanelActionsOwnerProps, SidebarPanelIconOwnerProps, SidebarPanelMetadata,
  SidebarRootComponentProps, SidebarRootInjected, SidebarSectionOwnerProps, SidebarSettingsOwnerProps,
  SectionScroller, SidebarSectionHookContext, SidebarSectionInjected, UseSectionScroller,
} from './contract/slots.ts'
export type { SidebarKey } from './locales.ts'

/** The section occupant receives the scroller hook from each render's hookContext. */
const SIDEBAR_SECTION_INJECT: SidebarSectionInjected = {
  hooks: { sectionScroller: (_standard, { useSectionScroller }) => useSectionScroller },
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sidebar controls and global panel copy. */
    sidebar: SidebarKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'sidebar'

/** One generated Remote result envelope. */
type RemoteFrame<T> = { ok: true; value: T } | { ok: false; error: unknown }

/** The control-plane Remote namespace this Client may compose. */
interface ControlPlaneRemote {
  tree: () => Promise<RemoteFrame<readonly InstanceGroupView[]>>
  reconnect: (request: { readonly instanceId: string }) => Promise<RemoteFrame<unknown>>
}

/**
 * Resolve the control-plane Remote namespace, when this Client is composed as
 * one.
 *
 * Two things are easy to get wrong here:
 * 1. A Remote namespace is its own Cordis service (key `remote.<namespace>`),
 *    not a property of a `remote` object; `ctx.remote` also throws
 *    "cannot get property \"remote\" without inject" because this plugin does
 *    not declare that service. Hence the service key through `ctx.get`.
 * 2. Generated Remote methods return the `{ ok, value }` envelope, which the
 *    reader must unwrap itself.
 *
 * The namespace mounts when the Host advertises it, which can be after this
 * apply, so the lookup stays lazy (per read) instead of gating registration.
 * @param ctx - client root context.
 * @returns the namespace face, or undefined on a plain dsh Client.
 */
function controlPlaneRemote(ctx: ClientContext): ControlPlaneRemote | undefined {
  // The service key is dynamic, so `ctx.get` falls back to its `any` overload:
  // this one narrowing assertion is the single boundary naming the face.
  const remote = ctx.get('remote.controlPlane') as ControlPlaneRemote | undefined
  return remote
}

/**
 * Stable empty frames: a plain dsh Client re-reads "no control plane" every
 * poll, and identical references let React skip the render.
 */
const NO_GROUPS: readonly InstanceGroupView[] = []

interface WorkspaceNavigation {
  startSession(workspaceId?: Parameters<SidebarRootInjected['startSession']>[0]): void
  /** Opens a Session; the control-plane rows pass a complete federated key. */
  openSession(target: string): void
}

/**
 * Snapshot source for the instance section's current-Session marker.
 *
 * The `sessions` service is deliberately not a hard dependency of the sidebar
 * plugin: a Client that composes the sidebar without the Session UI must still
 * boot, and the section registers its rows only under a control plane. Binding
 * through `ctx.inject` keeps the source optional yet reactive — it attaches
 * when the service mounts, re-derives on every list change, and reports "no
 * current Session" again when the service goes away.
 * @param ctx - client root context.
 * @returns the observable the rows subscribe to for their current marker.
 */
function currentSessionSource(ctx: ClientContext): ObservableSnapshot<string | undefined> {
  const store = createSnapshotStore<string | undefined>(undefined)
  ctx.inject(['sessions'], (scope) => {
    // Dynamic service key: the Session Controller's type merge is available
    // through the type-only import above, but this package reads two fields.
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
    }, 'ui-sidebar: current session')
  })
  // Arrow wrappers, not the store's own methods: the source outlives this
  // call and must not depend on a receiver.
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
 * Like {@link currentSessionSource}, the service is not a hard dependency: a
 * Client that composes the sidebar without the Session UI must still boot. The
 * face resolves when the service mounts and is forgotten when it goes away; a
 * call made while it is absent fails with a readable message instead of a
 * TypeError.
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
    }, 'ui-sidebar: session create')
  })
  return async (workspaceId) => {
    const face = sessions
    // A fixture may provide a partial face (the list reader alone); a missing
    // create is reported like a missing service, not a TypeError.
    if (face === undefined || typeof face.create !== 'function') {
      throw new Error('sessions service is unavailable')
    }
    return await face.create({ workspaceId })
  }
}

/** Services required by the sidebar plugin. */
export const inject = ['slots', 'layout', 'uiWorkspace', 'locale', 'shortcuts']

/** Registers the sidebar shell and its service callbacks.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const workspaceNavigation = ctx.get('uiWorkspace') as unknown as WorkspaceNavigation
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-sidebar: dictionaries')
  const panels = createSnapshotStore<readonly SidebarPanelMetadata[]>([])
  const syncPanels = (): void => {
    const next = ctx.slots.entriesOfSlot('sidebar.panellist').map(({ options }) => {
      // The list registration requires an id; StoredEntry erases the slot kind.
      const id = options.id as MainPanelId
      return { id, order: options.order ?? 0, label: resolveSlotLabel(options.label) ?? id }
    }).sort((a, b) => a.order - b.order)
    const previous = panels.getSnapshot()
    if (previous.length === next.length && previous.every((panel, index) => {
      const candidate = next[index] as SidebarPanelMetadata
      return panel.id === candidate.id && panel.order === candidate.order && panel.label === candidate.label
    })) return
    panels.set(next)
  }
  ctx.effect(() => ctx.slots.subscribe('sidebar.panellist', syncPanels), 'ui-sidebar: panel entries')
  ctx.effect(() => ctx.locale.subscribe(syncPanels), 'ui-sidebar: panel labels')
  const panelPins = createPanelPins()
  const entryActions = {
    getSnapshot: () => ctx.slots.entriesOfSlot('sidebar.panellist.actions').length > 0,
    subscribe: (listener: () => void) => ctx.slots.subscribe('sidebar.panellist.actions', listener),
  }

  const injectProps = (): SidebarRootInjected => ({
    // The shell's New Session button rides the Workspace UI's shared action
    // (current Session Workspace, then recent Workspace).
    startSession: (workspaceId) => { workspaceNavigation.startSession(workspaceId) },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
    selectPanel: (id) => { ctx.layout.selectPanel(id) },
    setPinned: panelPins.setPinned,
    trackEntryClick: (attributes) => { ctx.get('productAnalytics')?.track('sidebar_menu_click', attributes) },
    // 控制面组合下宿主不承担 agent 职责：隐藏"新建会话"和本地工作区浏览器。
    controlPlane: ctx.get('remote.controlPlane') !== undefined,
    hooks: { panels, shortcuts: ctx.shortcuts.catalog, entryPins: panelPins.unpinned, entryActions },
  })
  ctx.slots.inject('sidebar', function* () {
    yield ctx.slots.registerFactory({
      name: 'sidebar.panel.icon', scope: 'root',
      children: { 'sidebar.panellist': { kind: 'list', scope: 'root' } },
    }, PanelIcon)
    yield ctx.slots.register({
      name: 'sidebar',
      locale: NS,
      children: {
        'sidebar.brand.mark': { kind: 'single', scope: 'root' },
        'sidebar.brand.name': { kind: 'single', scope: 'root' },
        'sidebar.toggle.badge': { kind: 'single', scope: 'root' },
        'sidebar.panellist.actions': { kind: 'list', scope: 'root' },
        'sidebar.workspaces': { kind: 'single', scope: 'root', inject: SIDEBAR_SECTION_INJECT },
        'sidebar.settings': { kind: 'single', scope: 'root' },
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
        'sidebar.instances': { kind: 'single', scope: 'root' },
      },
      inject: injectProps,
    }, SidebarRoot)
  })
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
  ctx.slots.inject('sidebar.instances', () => ctx.slots.register({
    name: 'sidebar.instances',
    locale: NS,
  }, instanceGroupsSlot({
    fetchTree: readTree,
    // 新建成功后立即重读，而不是等下一次 6s 轮询。
    refreshTree: readTree,
    // 工作区键本身就是 `<instanceId>:<cwd>`；联邦路由剥前缀转发，返回的是
    // 该实例的裸 sessionId，前缀由实例分区在导航前拼回。
    createSession,
    retry: async (instanceId) => {
      const controlPlane = controlPlaneRemote(ctx)
      if (controlPlane === undefined) return
      // 失败是一个值（state/error），随后重读 tree 就能看到原因；这里不抛。
      await controlPlane.reconnect({ instanceId })
    },
    // 行点击直接交给 Workspace UI：键是 `<instanceId>:<localSessionId>`，
    // 由网关的联邦路由拆分，控制面侧不做任何前缀处理。
    openSession: (key) => { workspaceNavigation.openSession(key) },
    currentSession: currentSessionSource(ctx),
  })))
  // macOS desktop hides the collapsed sidebar entirely, so the open/New
  // Session controls move into the frame's window-chrome seat beside the
  // traffic lights; the occupant reuses the shell's injected actions, and
  // the AppFrame mounts the seat only while the column is fully hidden.
  ctx.slots.inject('shell.leading', () => ctx.slots.register({
    name: 'shell.leading',
    locale: NS,
    inject: injectProps,
  }, HeaderLeadingControls))
  syncPanels()
}
