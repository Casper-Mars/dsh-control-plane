/** Federated (instance-qualified) Session keys: no local catalog row, key forwarded whole. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, onTestFinished } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import {
  createClientTest, webApp, type TestClient,
} from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { ClientSessions } from '../src/client/sessions/service.ts'
import { isFederatedSessionId } from '../src/client/federation.ts'
import type { SessionFollowRequest } from '../src/types.ts'
import { FOLLOW, sessionWorld } from './remote/session.client.ts'

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
