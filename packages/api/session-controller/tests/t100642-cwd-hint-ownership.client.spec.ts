/**
 * t100642 adversarial coverage: federated `cwd` hint ownership.
 *
 * The regression: a federated blank Session opened from a Workspace's "+" got
 * its hint written by `mainView`, then the Sidebar's own view reopened the same
 * key without a hint and erased it, leaving the hero composer inert. These
 * cases pin the ownership rule independently of the fix's own happy path:
 * only the source that supplied a hint may clear it, a different source may
 * take ownership, and losing ownership must never strand a stale clear.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, onTestFinished } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import {
  createClientTest, webApp, type TestClient,
} from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { ClientSessions } from '../src/client/sessions/service.ts'
import { sessionWorld } from './remote/session.client.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** The real second consumer: ui-sidebar-right's independent Session view. */
    sidebarView: unknown
    /** A second Workspace-authoritative owner, for ownership-transfer cases. */
    t100642Owner: unknown
  }
}

const FEDERATED = SessionId('alpha:blank-1')
const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-api-gateway']) })

async function bench(mock: RemoteMock, start: () => Promise<TestClient>) {
  mock.load(sessionWorld)
  const client = await start()
  const ctx = new Context()
  const svc = new ClientSessions(ctx, client.ctx.remote)
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return { ctx, mock, svc }
}

function cwdOf(svc: ClientSessions): string | undefined {
  return svc.list.getSnapshot().byId[FEDERATED]?.cwd
}

describe('federated cwd hint ownership', () => {
  it('keeps the hint when the Sidebar view opens the key without one', async ({ mock, start }) => {
    const b = await bench(mock, start)
    // The Workspace "+" path: mainView supplies the remote path.
    const main = b.svc.retain(FEDERATED, { source: 'mainView', cwd: '/remote/ws' })
    onTestFinished(() => { main.release() })
    await main.ready
    expect(cwdOf(b.svc)).toBe('/remote/ws')

    // ui-sidebar-right retains the same key for its own view with no cwd; that
    // is the exact sequence that used to blank the hero composer.
    const sidebar = b.svc.retain(FEDERATED, { source: 'sidebarView' })
    onTestFinished(() => { sidebar.release() })
    await sidebar.ready
    expect(cwdOf(b.svc)).toBe('/remote/ws')

    // A third, unrelated consumer must not clear it either.
    const operation = b.svc.retain(FEDERATED, { source: 'controllerOperation' })
    onTestFinished(() => { operation.release() })
    await operation.ready
    expect(cwdOf(b.svc)).toBe('/remote/ws')
  })

  it('keeps the hint for a later independent open after the owner released', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const main = b.svc.retain(FEDERATED, { source: 'mainView', cwd: '/remote/ws' })
    await main.ready
    expect(cwdOf(b.svc)).toBe('/remote/ws')

    // Navigating away drops mainView entirely. The later Sidebar open is then
    // the only reference: it still must not resurrect the old "clear" rule.
    main.release()
    const sidebar = b.svc.retain(FEDERATED, { source: 'sidebarView' })
    onTestFinished(() => { sidebar.release() })
    await sidebar.ready
    expect(cwdOf(b.svc)).toBe('/remote/ws')
    // Releasing a reference never clears on its own (no release-time cleanup).
    sidebar.release()
    const after = b.svc.retain(FEDERATED, { source: 'gateway' })
    onTestFinished(() => { after.release() })
    await after.ready
    expect(cwdOf(b.svc)).toBe('/remote/ws')
  })

  it('transfers ownership when another source supplies a different hint', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const main = b.svc.retain(FEDERATED, { source: 'mainView', cwd: '/remote/a' })
    onTestFinished(() => { main.release() })
    await main.ready
    expect(cwdOf(b.svc)).toBe('/remote/a')

    // Newest hint wins and takes ownership with it.
    const other = b.svc.retain(FEDERATED, { source: 't100642Owner', cwd: '/remote/b' })
    onTestFinished(() => { other.release() })
    await other.ready
    expect(cwdOf(b.svc)).toBe('/remote/b')

    // The previous owner no longer has clearing authority: its hintless open
    // must not erase the path the new owner published.
    const stale = b.svc.retain(FEDERATED, { source: 'mainView' })
    onTestFinished(() => { stale.release() })
    await stale.ready
    expect(cwdOf(b.svc)).toBe('/remote/b')

    // The new owner keeps it until it restates a hintless open itself.
    const ownerClear = b.svc.retain(FEDERATED, { source: 't100642Owner' })
    onTestFinished(() => { ownerClear.release() })
    await ownerClear.ready
    expect(cwdOf(b.svc)).toBeUndefined()
  })

  it('re-writing the same hint twice keeps ownership and survives release', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const first = b.svc.retain(FEDERATED, { source: 'mainView', cwd: '/remote/same' })
    onTestFinished(() => { first.release() })
    await first.ready
    const second = b.svc.retain(FEDERATED, { source: 'mainView', cwd: '/remote/same' })
    await second.ready
    expect(cwdOf(b.svc)).toBe('/remote/same')

    // Release must not clear, and the owner stays the owner afterwards.
    second.release()
    const sidebar = b.svc.retain(FEDERATED, { source: 'sidebarView' })
    onTestFinished(() => { sidebar.release() })
    await sidebar.ready
    expect(cwdOf(b.svc)).toBe('/remote/same')

    // Ownership still belongs to the restating source.
    const clear = b.svc.retain(FEDERATED, { source: 'mainView' })
    onTestFinished(() => { clear.release() })
    await clear.ready
    expect(cwdOf(b.svc)).toBeUndefined()
  })

  it('treats an empty hint as ownership-scoped: only the owner may clear with it', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const main = b.svc.retain(FEDERATED, { source: 'mainView', cwd: '/remote/ws' })
    onTestFinished(() => { main.release() })
    await main.ready

    // `cwd: ''` is the "no hint" form for every caller. A non-owner passing it
    // carries no authority and must not clear.
    const sidebar = b.svc.retain(FEDERATED, { source: 'sidebarView', cwd: '' })
    onTestFinished(() => { sidebar.release() })
    await sidebar.ready
    expect(cwdOf(b.svc)).toBe('/remote/ws')

    // The owner passing the empty form is a real clear.
    const owner = b.svc.retain(FEDERATED, { source: 'mainView', cwd: '' })
    onTestFinished(() => { owner.release() })
    await owner.ready
    expect(cwdOf(b.svc)).toBeUndefined()
  })

  it('keeps hintless opens inside using() from clearing the hint', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const main = b.svc.retain(FEDERATED, { source: 'mainView', cwd: '/remote/ws' })
    onTestFinished(() => { main.release() })
    await main.ready

    // `using` is the scoped form every catalog-style consumer takes; it must be
    // just as powerless to erase another source's hint.
    await b.svc.using(FEDERATED, { source: 'controllerOperation' }, async () => {
      expect(cwdOf(b.svc)).toBe('/remote/ws')
    })
    expect(cwdOf(b.svc)).toBe('/remote/ws')
  })

  it('leaves a local catalog cwd untouched by any hint or clear attempt', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const LOCAL = SessionId('local-blank')
    b.svc.handleSessionAdded({
      agentAvailable: true, sessionId: LOCAL, updatedAt: 1, running: false, blank: true, cwd: '/local/ws',
    })

    const first = b.svc.retain(LOCAL, { source: 'mainView', cwd: '/remote/ignored' })
    onTestFinished(() => { first.release() })
    await first.ready
    const sidebar = b.svc.retain(LOCAL, { source: 'sidebarView' })
    onTestFinished(() => { sidebar.release() })
    await sidebar.ready
    const clearing = b.svc.retain(LOCAL, { source: 'mainView' })
    onTestFinished(() => { clearing.release() })
    await clearing.ready

    // The hint maps are federated-only: the local catalog row is the authority.
    expect(b.svc.list.getSnapshot().byId[LOCAL]?.cwd).toBe('/local/ws')
  })
})
