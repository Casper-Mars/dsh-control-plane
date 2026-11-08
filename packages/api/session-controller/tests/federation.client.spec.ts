/** Federated (instance-qualified) Session keys: no local catalog row, key forwarded whole. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, onTestFinished } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  createClientTest, webApp, type TestClient,
} from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { ClientSessions } from '../src/client/sessions/service.ts'
import { isFederatedSessionId, qualifyFederatedSessionId } from '../src/client/federation.ts'
import type { SessionFollowRequest } from '../src/types.ts'
import { FOLLOW, err, sessionWorld } from './remote/session.client.ts'

const FEDERATED = SessionId('alpha:s-1')
const LOCAL = SessionId('local-s1')
const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-api-gateway']) })

async function bench(mock: RemoteMock, start: () => Promise<TestClient>) {
  mock.load(sessionWorld)
  const client = await start()
  const ctx = new Context()
  const svc = new ClientSessions(ctx, client.ctx.remote)
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return { ctx, mock, svc }
}

describe('isFederatedSessionId', () => {
  it.each([
    ['alpha:s-1', true],
    ['alpha:s-1:tail', true],
    ['s-1', false],
    ['', false],
    [':s-1', false],
    ['alpha:', false],
  ])('%j → %s', (id, expected) => {
    expect(isFederatedSessionId(id)).toBe(expected)
  })
})

describe('qualifyFederatedSessionId', () => {
  it.each([
    ['alpha:parent-1', 'child-1', 'alpha:child-1'],
    // A local id may itself contain a colon; only the first one is the instance.
    ['alpha:parent-1:tail', 'child-1', 'alpha:child-1'],
    ['parent-1', 'child-1', 'child-1'],
    ['', 'child-1', 'child-1'],
    [':parent-1', 'child-1', 'child-1'],
    ['alpha:', 'child-1', 'child-1'],
    ['alpha:parent-1', 'beta:child-1', 'beta:child-1'],
  ])('%j + %j → %j', (source, child, expected) => {
    expect(qualifyFederatedSessionId(source, child)).toBe(expected)
  })
})

describe('federated Session targets', () => {
  it('retains and opens a federated key that no local catalog row names', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const reference = b.svc.retain(FEDERATED, { source: 'mainView' })
    onTestFinished(() => { reference.release() })

    await reference.ready

    expect(reference.sessionId).toBe(FEDERATED)
    expect(reference.binding.session.getSnapshot().openState).toBe('open')
    // The client sends the complete key: splitting the instance prefix is the Gateway's job.
    expect(mock.log.requests(FOLLOW)).toEqual<SessionFollowRequest[]>([{
      address: { kind: 'session', sessionId: FEDERATED },
      activate: true,
      assistantStream: true,
      maxMessages: 500,
      turnWindow: { minMessages: 50, minTurns: 2 },
    }])
    // No catalog membership is invented (`ids` stays empty); the retained
    // identity row only backs main-Session resolution, which shell consumers
    // read from `byId`.
    expect(b.svc.list.getSnapshot().ids).toEqual([])
    expect(b.svc.list.getSnapshot().byId[FEDERATED]?.retainedBy).toEqual({ mainView: 1 })
  })

  it('carries the owner-reported Workspace path as the federated row cwd hint', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const reference = b.svc.retain(FEDERATED, { source: 'mainView', cwd: '/remote/test/workspace' })
    onTestFinished(() => { reference.release() })

    await reference.ready

    const list = b.svc.list.getSnapshot()
    // The hint rides the identity row only: the local catalog still names no
    // federated Session, so no local Workspace can adopt it.
    expect(list.ids).toEqual([])
    expect(list.byId[FEDERATED]?.cwd).toBe('/remote/test/workspace')
    expect(list.byId[FEDERATED]?.blank).toBe(false)
  })

  it('overwrites the federated cwd hint on every open', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const first = b.svc.retain(FEDERATED, { source: 'mainView', cwd: '/remote/a' })
    onTestFinished(() => { first.release() })
    await first.ready
    expect(b.svc.list.getSnapshot().byId[FEDERATED]?.cwd).toBe('/remote/a')

    // The identity row already exists, so only the hint pass below can republish
    // the changed path; the last notification must carry the new value.
    const seen: Array<string | undefined> = []
    const unsubscribe = b.svc.list.subscribe(() => {
      seen.push(b.svc.list.getSnapshot().byId[FEDERATED]?.cwd)
    })
    onTestFinished(unsubscribe)
    const second = b.svc.retain(FEDERATED, { source: 'mainView', cwd: '/remote/b' })
    onTestFinished(() => { second.release() })
    await second.ready

    expect(seen.length).toBeGreaterThan(0)
    expect(seen.at(-1)).toBe('/remote/b')
    expect(b.svc.list.getSnapshot().byId[FEDERATED]?.cwd).toBe('/remote/b')
    expect(b.svc.list.getSnapshot().ids).toEqual([])
  })

  it('clears the federated cwd hint when the next open carries none', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const first = b.svc.retain(FEDERATED, { source: 'mainView', cwd: '/remote/a' })
    onTestFinished(() => { first.release() })
    await first.ready
    expect(b.svc.list.getSnapshot().byId[FEDERATED]?.cwd).toBe('/remote/a')

    // No authority for a path in this pass: the old one must not survive as a
    // stale chip, and it must not be inherited from the previous row either.
    const second = b.svc.retain(FEDERATED, { source: 'mainView' })
    onTestFinished(() => { second.release() })
    await second.ready

    const list = b.svc.list.getSnapshot()
    expect(list.byId[FEDERATED]?.cwd).toBeUndefined()
    expect('cwd' in (list.byId[FEDERATED] ?? {})).toBe(false)
    expect(list.ids).toEqual([])
    expect(b.svc.retainInfo(FEDERATED).getSnapshot().retainedBy).toEqual({ mainView: 2 })
  })

  it('leaves a local catalog cwd alone whatever hint a caller passes', async ({ mock, start }) => {
    const b = await bench(mock, start)
    b.svc.handleSessionAdded({
      agentAvailable: true, sessionId: LOCAL, updatedAt: 1, running: false, blank: false, cwd: '/local/ws',
    })

    const first = b.svc.retain(LOCAL, { source: 'mainView', cwd: '/ignored/one' })
    onTestFinished(() => { first.release() })
    await first.ready
    expect(b.svc.list.getSnapshot().byId[LOCAL]?.cwd).toBe('/local/ws')

    const second = b.svc.retain(LOCAL, { source: 'mainView' })
    onTestFinished(() => { second.release() })
    await second.ready
    // Neither a hint nor its absence writes or clears anything local: the
    // catalog row owns `cwd`.
    expect(b.svc.list.getSnapshot().byId[LOCAL]?.cwd).toBe('/local/ws')
  })

  it('drops the federated identity row with its last reference', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const reference = b.svc.retain(FEDERATED, { source: 'mainView' })
    await reference.ready
    expect(b.svc.list.getSnapshot().byId[FEDERATED]?.retainedBy).toEqual({ mainView: 1 })

    reference.release()

    expect(b.svc.list.getSnapshot().byId[FEDERATED]).toBeUndefined()
  })

  it('forwards the whole federated key to projection reads', async ({ mock, start }) => {
    const b = await bench(mock, start)

    await b.svc.refreshProjections(FEDERATED)

    expect(mock.log.requests('session/projections')).toEqual([{ sessionId: FEDERATED }])
  })

  it('still refuses an absent local identity that is not federated', async ({ mock, start }) => {
    const b = await bench(mock, start)

    expect(() => b.svc.retain(LOCAL, { source: 'mainView' })).toThrow('unknown session')
    expect(() => b.svc.retain(SessionId('alpha:'), { source: 'mainView' })).toThrow('unknown session')
  })
})


describe('federated fork catalog boundary', () => {
  it('returns the fully qualified child and publishes no local catalog row', async ({ mock, start, remote }) => {
    const b = await bench(mock, start)
    remote.session.fork.mockResolvedValueOnce(ok({ sessionId: SessionId('child-1') }))
    const child = SessionId('alpha:child-1')

    // The owner answers with its bare child id; the Client has to hand back the
    // qualified key so every later RPC addresses the owning instance.
    await expect(b.svc.fork({ sessionId: FEDERATED })).resolves.toBe(child)

    const list = b.svc.list.getSnapshot()
    // t100638: `ids` is the local catalog and never names another instance.
    expect(list.ids).toEqual([])
    // Nothing local opened the child yet, so no identity row exists either —
    // the owning instance (through the control-plane tree) carries its row.
    expect(list.byId[child]).toBeUndefined()
  })

  it('publishes an opened federated fork child only under byId, never as a local blank', async ({ mock, start, remote }) => {
    const b = await bench(mock, start)
    remote.session.fork.mockResolvedValueOnce(ok({ sessionId: SessionId('child-1') }))
    const child = SessionId('alpha:child-1')

    await b.svc.fork({ sessionId: FEDERATED })
    const reference = b.svc.retain(child, { source: 'mainView' })
    onTestFinished(() => { reference.release() })
    await reference.ready

    const list = b.svc.list.getSnapshot()
    expect(list.ids).toEqual([])
    // The retained identity row backs main-Session resolution; its blankness is
    // remote-owned, so the shell can never reuse it as a local blank.
    expect(list.byId[child]?.blank).toBe(false)
    expect(list.byId[child]?.retainedBy).toEqual({ mainView: 1 })
  })

  it('publishes no row for the child a partially failed federated fork still created', async ({ mock, start, remote }) => {
    const b = await bench(mock, start)
    remote.session.fork.mockResolvedValueOnce(err(new RemoteError('session/workspace-attach-failed', 'forked but unattached', {
      sessionId: SessionId('child-2'), workspaceId: 'w1',
    })))

    await expect(b.svc.fork({ sessionId: FEDERATED })).rejects.toMatchObject({ name: 'SessionForkError' })

    const list = b.svc.list.getSnapshot()
    expect(list.ids).toEqual([])
    expect(list.byId[SessionId('alpha:child-2')]).toBeUndefined()
  })

  it('still catalogs a local fork child as a reusable blank', async ({ mock, start, remote }) => {
    const b = await bench(mock, start)
    remote.session.fork.mockResolvedValueOnce(ok({ sessionId: SessionId('child-local') }))

    await expect(b.svc.fork({ sessionId: LOCAL })).resolves.toBe(SessionId('child-local'))

    // No prefix: the established local behaviour keeps the provisional
    // placeholder so the child is addressable and reusable before its first
    // Host summary lands.
    const list = b.svc.list.getSnapshot()
    expect(list.ids).toEqual([SessionId('child-local')])
    expect(list.byId[SessionId('child-local')]?.blank).toBe(true)
  })

  it('keeps ids local even when a list frame names a federated identity', async ({ mock, start }) => {
    const b = await bench(mock, start)

    b.svc.handleSessionAdded({
      agentAvailable: true,
      sessionId: FEDERATED,
      updatedAt: 1,
      running: false,
      blank: true,
    })

    // Defence in depth for the t100638 invariant: whatever reaches the manager,
    // the projection never promotes a federated identity into the local catalog.
    const list = b.svc.list.getSnapshot()
    expect(list.ids).toEqual([])
    expect(list.byId[FEDERATED]).toBeUndefined()
  })
})
