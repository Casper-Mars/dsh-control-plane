// @vitest-environment jsdom
/**
 * t100641 tester — the command gate across the three packages that register
 * control-plane-sensitive commands, on ONE real ShortcutRegistry.
 *
 * Composition under test:
 *  - ui-workspace installs `session.new`, `session.search`, `workspace.add`,
 *    `session.rename`, `session.fork`, `session.archive`;
 *  - ui-open-in-app registers `workspace.openLocal`;
 *  - ui-settings-general registers `settings.open` (through the real plugin,
 *    with the sidebar hole it waits on declared by the test root).
 *
 * The control plane must lose exactly the three local-only ids — never
 * register-then-refuse — while `settings.open` survives and still opens the
 * shell through a dispatched ⌘, gesture. A plain dsh Client keeps the whole
 * baseline set.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { MenuRegistry } from '@deepseek-ai/dsh-client-ui-context-menu/src/client/registry.ts'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ShortcutCommand, ShortcutCommandId, ShortcutGesture } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import { apply as openInAppApply, inject as openInAppInject } from '../../ui-open-in-app/src/client/index.ts'
import { apply as settingsApply, inject as settingsInject } from '../../ui-settings-general/src/client/index.ts'
import { SettingsRoot } from '../../ui-settings-general/src/client/SettingsRoot.tsx'
import { ShortcutRegistry } from '../../shortcuts/src/client/registry.ts'
import { createWorkspaceShortcutControls, installWorkspaceShortcuts } from '../src/client/shortcuts.ts'
import { en, zh } from '../src/client/locales.ts'

const sid = (value: string) => value as SessionId

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async original => ({
  ...await original<typeof import('@deepseek-ai/dsh-client-ui-primitives')>(),
  isMobileDevice: vi.fn(() => false),
}))

/** The baseline a plain dsh Client has always offered. */
const PLAIN_BASELINE = [
  'settings.open', 'workspace.openLocal', 'session.new', 'session.search', 'workspace.add',
  'session.rename', 'session.fork', 'session.archive',
].sort()

/** Exactly the ids a control plane must not register. */
const LOCAL_ONLY = ['session.new', 'workspace.add', 'workspace.openLocal']

const gesture = (code: string, modifiers: { meta?: boolean; alt?: boolean } = {}): ShortcutGesture => ({
  code,
  control: false,
  alt: modifiers.alt === true,
  shift: false,
  meta: modifiers.meta === true,
  repeat: false,
  composing: false,
  defaultPrevented: false,
})

const context = { region: 'page' as const, modal: null, target: null }

/** The Session Remote slice the path controls call. */
const remoteSession = {
  workspacePathApplications: vi.fn(async () => ({ ok: true as const, value: [] })),
  canOpenWorkspacePath: vi.fn(async () => ({ ok: true as const, value: true })),
  openWorkspacePath: vi.fn(async () => ({ ok: true as const, value: { opened: true as const } })),
}

/**
 * Boot all three command owners over one Client, with the sidebar settings hole
 * declared so the real settings plugin reaches its registration branch.
 * @param controlPlane - whether the Client composes the control-plane Remote.
 */
async function bench(controlPlane: boolean) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'sidebar.settings': { kind: 'single', scope: 'root' },
      'sidebar.workspaces.session.menu.item': { kind: 'list', scope: 'root' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
      'sidebar.right.tab.files.actions': { kind: 'list', scope: 'session' },
      'sidebar.right.tab.document.actions': { kind: 'list', scope: 'session' },
      'sidebar.right.tab.document.unpreviewable': { kind: 'list', scope: 'session' },
      'deliverables.file.actions': { kind: 'list', scope: 'session' },
      'deliverables.review.file.actions': { kind: 'list', scope: 'session' },
      'shell.overlay': { kind: 'list', scope: 'root' },
      'contextMenu.icon': { kind: 'keyed', scope: 'root', inline: true },
    },
  } as never, () => null)

  const registry = new ShortcutRegistry('desktop', 'macos')
  const commands = new Map<string, ShortcutCommand>()
  const shortcuts = {
    register: (command: ShortcutCommand) => {
      commands.set(command.id, command)
      return registry.register(command)
    },
    catalog: registry.catalog,
  }
  ctx.provide('shortcuts', shortcuts)

  const list = createSnapshotStore<SessionListState>({
    ids: [], byId: {}, phase: 'ready', projectionsBySession: {},
  })
  ctx.provide('sessions', { list, binding: () => undefined } as never)
  ctx.provide('layout', { panelInfo: createSnapshotStore<PanelInfo>({ activePanelId: null }) } as never)
  const notify = vi.fn()
  const menus = new MenuRegistry(notify)
  ctx.effect(() => () => { menus.dispose() })
  ctx.provide('contextMenus', {
    register: menus.register.bind(menus), resolve: menus.resolve.bind(menus), open: vi.fn(), notify,
  } as never)
  ctx.provide('fileActions', {} as never)
  ctx.provide('sidebarRight', {} as never)
  ctx.provide('sidebarRightTabs', {} as never)
  ctx.provide('remote.workspaceFiles', {} as never)
  ctx.provide('remote.session', remoteSession as never)
  ctx.provide('remote.settings', {} as never)
  ctx.provide('remote', {
    $host: { isLoopback: false },
    $on: () => () => {},
    session: remoteSession,
  } as never)

  const locale = new LocaleRuntime(ctx)
  locale.register('workspace', { en, zh })
  locale.setLocale('en')
  ctx.provide('locale', locale)

  const connection = {
    state: createSnapshotStore({ status: 'ready' }),
    reconnect: vi.fn(),
  }
  ctx.provide('connection', connection as never)
  ctx.provide('configForms', {
    developerTools: { enabled: createSnapshotStore(true), setEnabled: vi.fn() },
    get: () => ({ getSnapshot: () => ({ value: { enabled: true } }), subscribe: () => () => {} }),
    describe: () => ({ ensure: async () => {} }),
  } as never)
  ctx.provide('modules', {
    entries: { dismissRelease: vi.fn(), releaseChange: createSnapshotStore(undefined) },
  } as never)
  // The Host grants settings access immediately in this bench; the real
  // plugin registers the shell seat and its command from inside this callback.
  ctx.provide('remoteAccess', {
    whenAccess: (_route: string, run: () => unknown) => { run(); return () => {} },
  } as never)
  if (controlPlane) ctx.provide('remote.controlPlane', {} as never)

  const navigation = { startSession: vi.fn(), forkSession: vi.fn(async () => sid('fork')) }
  const controls = createWorkspaceShortcutControls()
  const settingsFiber = ctx.plugin({ inject: [...settingsInject], apply: settingsApply })
  const openInAppFiber = ctx.plugin({ inject: [...openInAppInject], apply: openInAppApply })
  const workspaceFiber = ctx.plugin((scoped) => {
    installWorkspaceShortcuts(scoped, navigation, controls, () => {}, () => {})
  })
  await Promise.all([settingsFiber.await(), openInAppFiber.await(), workspaceFiber.await()])

  const settingsSeat = () => ctx.slots.entries('sidebar.settings')[0]
  return {
    ctx,
    registry,
    commands,
    navigation,
    controls,
    remoteSession,
    settingsSeat,
    catalog: () => registry.catalog.getSnapshot().map(row => row.id),
    dispatch: (input: ShortcutGesture, consume = () => {}) => registry.dispatch(input, context, consume),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('control-plane command catalog', () => {
  it('registers no session.new, workspace.add, or workspace.openLocal — at all', async () => {
    const b = await bench(true)
    for (const id of LOCAL_ONLY) {
      expect(b.commands.has(id), id).toBe(false)
      expect(b.catalog(), id).not.toContain(id)
    }
  })

  it('keeps settings.open and the ordinary dsh commands', async () => {
    const b = await bench(true)
    expect(b.commands.has('settings.open')).toBe(true)
    expect(b.catalog()).toEqual([
      'settings.open', 'session.search', 'session.rename', 'session.fork', 'session.archive',
    ])
  })

  it('a plain dsh Client keeps the whole baseline set', async () => {
    const b = await bench(false)
    expect([...b.catalog()].sort()).toEqual(PLAIN_BASELINE)
    for (const id of LOCAL_ONLY) expect(b.commands.has(id), id).toBe(true)
  })

  it('the gate removes exactly the three local-only ids and nothing else', async () => {
    const plane = await bench(true)
    const plain = await bench(false)
    const removed = [...plain.catalog()].filter(id => !plane.catalog().includes(id))
    expect(removed.sort()).toEqual([...LOCAL_ONLY].sort())
    // No id was added by the gate either.
    expect(plane.catalog().filter(id => !plain.catalog().includes(id))).toEqual([])
  })
})

describe('control-plane command execution', () => {
  it('passes the local gestures through instead of blocking a registered shell', async () => {
    const b = await bench(true)
    // ⌘N, ⌘O, and ⌘⌥O all reach the page untouched.
    expect(b.dispatch(gesture('KeyN', { meta: true })).status).toBe('pass')
    expect(b.dispatch(gesture('KeyO', { meta: true })).status).toBe('pass')
    expect(b.dispatch(gesture('KeyO', { meta: true, alt: true })).status).toBe('pass')
    // Menu invocations of the absent ids are no-ops, not refusals.
    b.registry.invoke('session.new' as ShortcutCommandId, { ...context, source: 'menu' })
    b.registry.invoke('workspace.add' as ShortcutCommandId, { ...context, source: 'menu' })
    b.registry.invoke('workspace.openLocal' as ShortcutCommandId, { ...context, source: 'menu' })
    expect(b.navigation.startSession).not.toHaveBeenCalled()
    expect(b.controls.state.getSnapshot().addRequested).toBe(false)
    await Promise.resolve()
    expect(b.remoteSession.openWorkspacePath).not.toHaveBeenCalled()
  })

  it('opens the settings shell through the surviving ⌘, command', async () => {
    const b = await bench(true)
    const seat = b.settingsSeat()
    expect(seat).toBeDefined()
    // The real plugin still occupies the sidebar hole with its shell root.
    expect(seat!.component).toBe(SettingsRoot)
    const shell = (seat!.store as { create: () => { getSnapshot: () => { open: boolean } } }).create()
    expect(shell.getSnapshot().open).toBe(false)

    const consume = vi.fn()
    const result = b.dispatch(gesture('Comma', { meta: true }), consume)
    expect(result).toEqual({ status: 'handled', commandId: 'settings.open' })
    expect(consume).toHaveBeenCalledOnce()
    expect(shell.getSnapshot().open).toBe(true)
  })

  it('a plain dsh Client still executes the local-only commands', async () => {
    const b = await bench(false)
    expect(b.dispatch(gesture('KeyN', { meta: true })).status).toBe('handled')
    expect(b.navigation.startSession).toHaveBeenCalledOnce()
  })
})
