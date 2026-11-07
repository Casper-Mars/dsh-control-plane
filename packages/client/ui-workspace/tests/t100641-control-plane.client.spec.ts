/**
 * t100641 — the control plane registers no command that targets the local
 * catalog.
 *
 * A control plane owns remote instances: `session.new` would create a Session
 * in the empty local controller and `workspace.add` would open a directory
 * picker for a local Workspace this Client cannot serve. Both are skipped at
 * their registration site (not registered-then-refused), while every other
 * command — including the settings entry registered by ui-settings-general on
 * the same registry — keeps its registration.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ShortcutCommand, ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import { ShortcutRegistry } from '../../shortcuts/src/client/registry.ts'
import { createWorkspaceShortcutControls, installWorkspaceShortcuts } from '../src/client/shortcuts.ts'
import { en, zh } from '../src/client/locales.ts'

const sid = (value: string) => value as SessionId

/** `/opt/settings` used by ui-settings-general; registered on the same registry. */
const SETTINGS: ShortcutCommand = {
  id: 'settings.open' as ShortcutCommandId,
  label: () => 'Open settings',
  aliases: ['settings', 'preferences'],
  defaults: {
    'desktop:macos': { code: 'Comma', modifiers: ['primary'] },
    'desktop:windows': { code: 'Comma', modifiers: ['primary'] },
    'desktop:linux': { code: 'Comma', modifiers: ['primary'] },
    'web:macos': { code: 'Comma', modifiers: ['primary', 'alt'] },
    'web:windows': { code: 'Comma', modifiers: ['primary', 'alt'] },
  },
  regions: ['page', 'editable', 'terminal'],
  modals: ['settings'],
  resolve: () => ({ status: 'handled', run: () => {} }),
}

/** Boot the workspace commands over a Client that may also compose a control plane. */
async function bench(controlPlane: boolean) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const registry = new ShortcutRegistry('desktop', 'macos')
  const commands = new Map<string, ShortcutCommand>()
  ctx.provide('shortcuts', {
    register: (command: ShortcutCommand) => {
      commands.set(command.id, command)
      return registry.register(command)
    },
    catalog: registry.catalog,
  })
  const list = createSnapshotStore<SessionListState>({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
  ctx.provide('sessions', { list, binding: () => undefined })
  ctx.provide('layout', { panelInfo: createSnapshotStore<PanelInfo>({ activePanelId: null }) })
  ctx.provide('slots', { entries: () => [], subscribe: () => () => {} })
  const locale = new LocaleRuntime(ctx)
  locale.register('workspace', { en, zh })
  locale.setLocale('en')
  ctx.provide('locale', locale)
  // Mounted the way the Host's own settings plugin would on this Client.
  ctx.effect(() => ctx.shortcuts.register(SETTINGS), 'test: settings command')
  if (controlPlane) ctx.provide('remote.controlPlane', {})
  const navigation = { startSession: vi.fn(), forkSession: vi.fn(async () => sid('fork')) }
  const fiber = ctx.plugin((scoped) => {
    installWorkspaceShortcuts(scoped, navigation, createWorkspaceShortcutControls(),
      () => {}, () => {})
  })
  await fiber.await()
  return { ctx, commands, navigation, catalog: () => registry.catalog.getSnapshot().map(row => row.id) }
}

afterEach(() => { vi.restoreAllMocks() })

describe('control-plane workspace commands', () => {
  it('never registers the local-session and local-workspace commands', async () => {
    const b = await bench(true)
    expect(b.commands.has('session.new')).toBe(false)
    expect(b.commands.has('workspace.add')).toBe(false)
    expect(b.catalog()).toEqual([
      'settings.open', 'session.search', 'session.rename', 'session.fork', 'session.archive',
    ])
  })

  it('keeps the settings entry and every ordinary dsh command', async () => {
    const plane = await bench(true)
    const plain = await bench(false)
    expect(plain.commands.has('settings.open')).toBe(true)
    expect(plane.commands.has('settings.open')).toBe(true)
    expect(plain.catalog()).toEqual([
      'settings.open', 'session.new', 'session.search', 'workspace.add',
      'session.rename', 'session.fork', 'session.archive',
    ])
    // The gate only removes the local-only ids; nothing else moves.
    expect(plane.catalog()).toEqual(plain.catalog().filter(id => id !== 'session.new' && id !== 'workspace.add'))
  })
})
