// @vitest-environment jsdom
/**
 * The `sidebar.instances` wiring: the section is registered once, its readers
 * unwrap the `{ ok, value }` Remote envelope, a refused frame leaves the
 * previous one in place, the retry control reaches `controlPlane/reconnect`,
 * and a plain dsh Client (no `remote.controlPlane` service) renders nothing and
 * reads nothing.
 *
 * Since S3-03 the tree frame carries reachability, so this bench serves one
 * `tree` read plus the `reconnect` call the retry button makes.
 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import type { InstanceGroupView } from '../src/client/InstanceGroups.tsx'
import { apply, inject } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

const t = makeTranslate({ ...commonEn, ...en })
const owners = new Set<Fiber>()

afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  try {
    for (const owner of owners) await owner.dispose()
  } finally {
    owners.clear()
  }
})

/** The shell frame the sidebar registers into: one `sidebar` hole. */
function SidebarFrame({ renderSlot }: PropsRenderSlots<'sidebar'>) {
  return renderSlot('sidebar', { collapsed: false, width: 300, drawer: false })
}

/** A test Client with the services ui-sidebar needs, and the `sidebar` hole declared. */
async function bench() {
  const root = new Context()
  let ctx: Context | undefined
  const owner = root.plugin((owned: Context) => { ctx = owned })
  owners.add(owner)
  await owner.await()
  if (ctx === undefined) throw new Error('the sidebar fixture owner did not activate')
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('shortcuts', { catalog: createSnapshotStore([]) } as never)
  ctx.provide('layout', { toggleSidebar: vi.fn(), selectPanel: vi.fn() } as never)
  ctx.provide('uiWorkspace', { startSession: vi.fn() } as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const slots = ctx.get('slots') as SlotRegistry
  slots.register(
    { name: 'root', children: { sidebar: { kind: 'single', scope: 'root' } } },
    SidebarFrame,
  )
  return { ctx, slots }
}

/** Render the registered instance section the way the renderer does. */
async function mountSection(slots: SlotRegistry, wide = true) {
  const entry = slots.entries('sidebar.instances')[0]
  if (entry === undefined) throw new Error('the instance section did not register')
  const Section = entry.component as ComponentType<{ t: typeof t; wide: boolean }>
  const view = render(<Section t={t} wide={wide} />)
  await act(async () => { await Promise.resolve() })
  return view
}

const TREE: readonly InstanceGroupView[] = [{
  instanceId: 'cto',
  label: 'CTO(cto)',
  state: 'connected',
  runningCount: 1,
  sessionCount: 1,
  workspaces: [{
    key: 'cto:/repo',
    path: '/repo',
    runningCount: 1,
    sessions: [{ key: 'cto:s1', sessionId: 's1', title: 'Fix the login flow', running: true, updatedAt: 0 }],
  }],
}]

const OFFLINE: readonly InstanceGroupView[] = [{
  instanceId: 'cto',
  label: 'CTO(cto)',
  state: 'unreachable',
  error: 'connect ECONNREFUSED',
  runningCount: 0,
  sessionCount: 0,
  workspaces: [],
}]

describe('sidebar.instances wiring', () => {
  it('registers once and reads the tree through the control-plane namespace', async () => {
    const b = await bench()
    const tree = vi.fn(async () => ({ ok: true as const, value: TREE }))
    const reconnect = vi.fn(async () => ({ ok: true as const, value: { state: 'connected' } }))
    b.ctx.provide('remote.controlPlane', { tree, reconnect } as never)
    const sidebar = b.ctx.plugin({ inject: [...inject], apply })
    await sidebar.await()
    try {
      expect(b.slots.entries('sidebar.instances')).toHaveLength(1)
      const view = await mountSection(b.slots)
      expect(tree).toHaveBeenCalledOnce()
      expect(view.getByRole('button', { name: 'CTO(cto), Connected, 1 sessions' })).toBeTruthy()
      expect(view.getByText('/repo')).toBeTruthy()
      expect(view.getByText('Fix the login flow')).toBeTruthy()
      expect(view.container.querySelector('[data-instance-state="connected"]')).not.toBeNull()
    } finally {
      await sidebar.dispose()
    }
  })

  it('keeps the previous frame when the envelope refuses the read', async () => {
    vi.useFakeTimers()
    const b = await bench()
    let refuse = false
    const tree = vi.fn(async () => (refuse
      ? { ok: false as const, error: { message: 'no' } }
      : { ok: true as const, value: TREE }))
    b.ctx.provide('remote.controlPlane', { tree, reconnect: vi.fn() } as never)
    const sidebar = b.ctx.plugin({ inject: [...inject], apply })
    await sidebar.await()
    try {
      const view = await mountSection(b.slots)
      expect(view.getByRole('button', { name: /CTO\(cto\), Connected/ })).toBeTruthy()

      refuse = true
      await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
      expect(tree).toHaveBeenCalledTimes(2)
      expect(view.getByRole('button', { name: /CTO\(cto\), Connected/ })).toBeTruthy()
      expect(view.getByText('Fix the login flow')).toBeTruthy()
    } finally {
      await sidebar.dispose()
    }
  })

  it('renders the offline group and routes the retry button to controlPlane/reconnect', async () => {
    const b = await bench()
    let frames = OFFLINE
    const tree = vi.fn(async () => ({ ok: true as const, value: frames }))
    const reconnect = vi.fn(async () => ({ ok: true as const, value: { state: 'connected' } }))
    b.ctx.provide('remote.controlPlane', { tree, reconnect } as never)
    const sidebar = b.ctx.plugin({ inject: [...inject], apply })
    await sidebar.await()
    try {
      const view = await mountSection(b.slots)
      expect(view.getByRole('button', { name: 'CTO(cto), Unreachable' })).toBeTruthy()
      expect(view.getByText('connect ECONNREFUSED')).toBeTruthy()

      frames = TREE
      fireEvent.click(view.getByRole('button', { name: 'Retry' }))
      await act(async () => { await Promise.resolve() })
      expect(reconnect).toHaveBeenCalledWith({ instanceId: 'cto' })
      expect(tree).toHaveBeenCalledTimes(2)
      expect(view.getByRole('button', { name: 'CTO(cto), Connected, 1 sessions' })).toBeTruthy()
    } finally {
      await sidebar.dispose()
    }
  })

  it('registers nothing visible on a plain dsh Client', async () => {
    const b = await bench()
    const sidebar = b.ctx.plugin({ inject: [...inject], apply })
    await sidebar.await()
    try {
      const view = await mountSection(b.slots)
      expect(view.container.querySelector('[data-dsh-instance-groups]')).toBeNull()
    } finally {
      await sidebar.dispose()
    }
  })
})
