/**
 * t100638 tester — federated (instance-qualified) Session keys at the
 * Client → Gateway seam.
 *
 * The Developer suite pins the happy path. These cases are the independent
 * runtime checks the review asked for: shape boundaries including ones the
 * Developer table omits, a key that survives every RPC whole, the two-sided
 * agreement between `isFederatedSessionId` and the Gateway's split, and the
 * list/blank invariants that keep the shell from mistaking a remote Session
 * for a locally reusable blank.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, onTestFinished } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import {
  createClientTest, webApp, type TestClient,
} from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { resolveFederationTarget } from '@deepseek-ai/dsh-api-gateway'
import { ClientSessions } from '../src/client/sessions/service.ts'
import { isFederatedSessionId } from '../src/client/federation.ts'
import type { SessionFollowRequest } from '../src/types.ts'
import { FOLLOW, sessionWorld } from './remote/session.client.ts'

const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-api-gateway']) })

const sid = (id: string): SessionId => SessionId(id)

async function bench(mock: RemoteMock, start: () => Promise<TestClient>) {
  mock.load(sessionWorld)
  const client = await start()
  const ctx = new Context()
  const svc = new ClientSessions(ctx, client.ctx.remote)
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return { ctx, mock, svc }
}

/** The Gateway sees the generated Client's named arguments, which wrap the one `request` parameter. */
function wire(
  mock: RemoteMock,
  endpoint: string,
  accept: (instanceId: string) => boolean = () => true,
) {
  const request = mock.log.requests(endpoint)[0]
  if (request === undefined) throw new Error(`no ${endpoint} request was recorded`)
  return resolveFederationTarget(endpoint, { request }, accept)
}

describe('isFederatedSessionId shape boundary', () => {
  it.each([
    // A non-empty instance and a non-empty local id, split at the FIRST colon.
    ['alpha:s-1', true],
    ['a:b:c', true],
    ['a::b', true],
    // Whitespace is part of the segment; neither side is trimmed.
    ['a: b', true],
    [' alpha:s-1', true],
    ['alpha:s-1 ', true],
    ['alpha: ', true],
    // One empty side is not a federated key.
    [':x', false],
    ['x:', false],
    [':', false],
    ['', false],
    ['local-s1', false],
    ['  ', false],
  ])('%j → %s', (id, expected) => {
    expect(isFederatedSessionId(id)).toBe(expected)
  })

  it('agrees with the Gateway split on every boundary sample', () => {
    const samples = [
      'alpha:s-1', 'a:b:c', 'a::b', 'a: b', ' alpha:s-1', 'alpha:s-1 ', 'alpha: ',
      ':x', 'x:', ':', '', 'local-s1', '  ',
    ]
    for (const sample of samples) {
      const target = resolveFederationTarget(
        'session/projections',
        { request: { sessionId: sample } },
        () => true,
      )
      expect(target !== undefined, `gateway/router disagreement for ${JSON.stringify(sample)}`)
        .toBe(isFederatedSessionId(sample))
      if (target !== undefined) {
        const separator = sample.indexOf(':')
        expect(target.instanceId).toBe(sample.slice(0, separator))
        expect((target.args.request as { sessionId: string }).sessionId)
          .toBe(sample.slice(separator + 1))
      }
    }
  })
})

describe('complete federated chain (Client side)', () => {
  it('retains a key with no local row and sends the whole key in its first RPC', async ({ mock, start }) => {
    const b = await bench(mock, start)

    const reference = b.svc.retain(sid('alpha:s-1'), { source: 'mainView' })
    onTestFinished(() => { reference.release() })
    await reference.ready

    // The opening RPC is the history follow, and it names the complete key.
    const first = mock.log.requests()[0]
    expect(first).toEqual({
      address: { kind: 'session', sessionId: sid('alpha:s-1') },
      activate: true,
      assistantStream: true,
      maxMessages: 500,
      turnWindow: { minMessages: 50, minTurns: 2 },
    })
    const target = wire(mock, FOLLOW, id => id === 'alpha')
    expect(target?.instanceId).toBe('alpha')
    const request = target?.args.request as SessionFollowRequest
    expect(request.address).toEqual({ kind: 'session', sessionId: sid('s-1') })
    expect(request.activate).toBe(true)
    expect(request.assistantStream).toBe(true)
    expect(request.maxMessages).toBe(500)
    expect(request.turnWindow).toEqual({ minMessages: 50, minTurns: 2 })
  })

  it('passes a multi-colon key through unsplit and lets the Gateway cut at the first colon', async ({ mock, start }) => {
    const b = await bench(mock, start)

    const reference = b.svc.retain(sid('a:b:c'), { source: 'mainView' })
    onTestFinished(() => { reference.release() })
    await reference.ready

    expect((mock.log.requests(FOLLOW)[0] as SessionFollowRequest).address)
      .toEqual({ kind: 'session', sessionId: sid('a:b:c') })
    const target = wire(mock, FOLLOW)
    expect(target?.instanceId).toBe('a')
    expect(((target?.args.request as SessionFollowRequest).address))
      .toEqual({ kind: 'session', sessionId: sid('b:c') })
  })

  it('forwards the whole key to projection reads too', async ({ mock, start }) => {
    const b = await bench(mock, start)

    await b.svc.refreshProjections(sid('alpha:s-1'))

    expect(mock.log.requests('session/projections')).toEqual([{ sessionId: sid('alpha:s-1') }])
    const target = resolveFederationTarget(
      'session/projections',
      { request: mock.log.requests('session/projections')[0] },
      id => id === 'alpha',
    )
    expect(target).toEqual({
      instanceId: 'alpha',
      endpoint: 'session/projections',
      args: { request: { sessionId: sid('s-1') } },
    })
  })
})

describe('local behaviour unchanged', () => {
  it('opens a catalogued local id without inventing a prefix', async ({ mock, start }) => {
    const b = await bench(mock, start)
    mock.load({
      unary: {
        'session/list': ok({
          items: [{
            agentAvailable: true,
            formatStatus: 'current',
            sessionId: 'local-s1',
            updatedAt: 5,
            running: false,
            blank: false,
            cwd: '/w/one',
            title: 'Local',
          }],
        }),
      },
    })
    await b.svc.refresh()

    const reference = b.svc.retain(sid('local-s1'), { source: 'mainView' })
    onTestFinished(() => { reference.release() })
    await reference.ready

    expect((mock.log.requests(FOLLOW)[0] as SessionFollowRequest).address)
      .toEqual({ kind: 'session', sessionId: sid('local-s1') })
    expect(b.svc.list.getSnapshot().ids).toEqual([sid('local-s1')])
  })

  it('still refuses an absent no-colon identity and a colon-with-empty-side identity', async ({ mock, start }) => {
    const b = await bench(mock, start)

    expect(() => b.svc.retain(sid('missing-local'), { source: 'mainView' })).toThrow('unknown session')
    expect(() => b.svc.retain(sid('alpha:'), { source: 'mainView' })).toThrow('unknown session')
    expect(() => b.svc.retain(sid(':s-1'), { source: 'mainView' })).toThrow('unknown session')
  })

  it('keeps the durable subagent address route intact beside federated keys', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const address = {
      parentSessionId: sid('parent'),
      childSessionId: sid('child'),
      mode: 'continuable' as const,
    }

    const reference = b.svc.retain(address, { source: 'mainView' })
    onTestFinished(() => { reference.release() })
    await reference.ready

    expect((mock.log.requests(FOLLOW)[0] as SessionFollowRequest).address)
      .toEqual({ kind: 'subagent', ...address })
    const row = b.svc.list.getSnapshot().byId[sid('child')]
    expect(row?.origin).toBe('subagent')
    expect(row?.parentId).toBe(sid('parent'))
    expect(b.svc.list.getSnapshot().ids).toEqual([])
  })

  it('routes a federated subagent address as one instance and strips both ids', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const address = {
      parentSessionId: sid('alpha:p'),
      childSessionId: sid('alpha:c'),
      mode: 'continuable' as const,
    }

    const reference = b.svc.retain(address, { source: 'mainView' })
    onTestFinished(() => { reference.release() })
    await reference.ready
    expect((mock.log.requests(FOLLOW)[0] as SessionFollowRequest).address).toEqual({
      kind: 'subagent',
      parentSessionId: sid('alpha:p'),
      childSessionId: sid('alpha:c'),
      mode: 'continuable',
    })

    const target = resolveFederationTarget(
      FOLLOW,
      { request: mock.log.requests(FOLLOW)[0] },
      id => id === 'alpha',
    )
    expect(target?.instanceId).toBe('alpha')
    expect(((target?.args.request as SessionFollowRequest).address)).toEqual({
      kind: 'subagent',
      parentSessionId: sid('p'),
      childSessionId: sid('c'),
      mode: 'continuable',
    })
  })

  it('KNOWN RESIDUAL: a half-federated subagent address still forwards to the child instance', () => {
    // The router forwards when at least one declared identifier carries a
    // prefix and every *prefixed* identifier agrees; an unprefixed sibling id
    // travels unchanged. A locally minted parent plus a federated child cannot
    // arise from a real owning instance today, but it would be delivered to
    // the child's instance with the wrong parent id.
    const target = resolveFederationTarget(
      FOLLOW,
      {
        request: {
          address: {
            kind: 'subagent',
            parentSessionId: 'local-p',
            childSessionId: 'alpha:c',
            mode: 'continuable',
          },
        },
      },
      id => id === 'alpha',
    )
    expect(target?.instanceId).toBe('alpha')
    expect(((target?.args.request as SessionFollowRequest).address)).toEqual({
      kind: 'subagent',
      parentSessionId: 'local-p',
      childSessionId: 'c',
      mode: 'continuable',
    })
  })
})

describe('list projection stays clean', () => {
  it('puts a federated identity only in byId, never in ids', async ({ mock, start }) => {
    const b = await bench(mock, start)

    const reference = b.svc.retain(sid('alpha:s-1'), { source: 'mainView' })
    onTestFinished(() => { reference.release() })
    await reference.ready

    const state = b.svc.list.getSnapshot()
    expect(state.ids).toEqual([])
    expect(Object.keys(state.byId)).toEqual(['alpha:s-1'])
    expect(state.byId[sid('alpha:s-1')]?.retainedBy).toEqual({ mainView: 1 })
    // A federated row must never advertise local blank reuse eligibility.
    expect(state.byId[sid('alpha:s-1')]?.blank).toBe(false)
    expect(reference.binding.session.getSnapshot().blank).toBe(true)
  })

  it('keeps two federated identities side by side and drops each on its own release', async ({ mock, start }) => {
    const b = await bench(mock, start)

    const alpha = b.svc.retain(sid('alpha:s-1'), { source: 'mainView' })
    const beta = b.svc.retain(sid('beta:s-2'), { source: 'mainView' })
    onTestFinished(() => { alpha.release() })
    onTestFinished(() => { beta.release() })
    await Promise.all([alpha.ready, beta.ready])

    expect(b.svc.list.getSnapshot().ids).toEqual([])
    expect(Object.keys(b.svc.list.getSnapshot().byId).sort()).toEqual(['alpha:s-1', 'beta:s-2'])
    expect(b.svc.list.getSnapshot().byId[sid('beta:s-2')]?.displayTitle).toBe('beta:s-2')

    beta.release()
    expect(Object.keys(b.svc.list.getSnapshot().byId)).toEqual(['alpha:s-1'])

    alpha.release()
    expect(b.svc.list.getSnapshot().byId[sid('alpha:s-1')]).toBeUndefined()
    expect(b.svc.list.getSnapshot().ids).toEqual([])
  })

  it('publishes a breadcrumb-only parent row for a federated subagent address', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const parent = sid('alpha:p-1')
    const reference = b.svc.retain(
      { parentSessionId: parent, childSessionId: sid('c-1'), mode: 'continuable' },
      { source: 'mainView' },
    )
    onTestFinished(() => { reference.release() })
    await reference.ready

    const state = b.svc.list.getSnapshot()
    // The child is addressed through its parent's instance, and the parent's
    // own scope is gone, so the header still needs a row to draw the crumb.
    expect(reference.sessionId).toBe('alpha:c-1')
    expect(state.byId[sid('alpha:c-1')]?.parentId).toBe(parent)
    expect(state.byId[parent]?.displayTitle).toBe('p-1')
  })

  it('leaves a real local blank row reusable beside a federated identity', async ({ mock, start }) => {
    const b = await bench(mock, start)
    mock.load({
      unary: {
        'session/list': ok({
          items: [{
            agentAvailable: false,
            formatStatus: 'current',
            sessionId: 'local-blank',
            updatedAt: 9,
            running: false,
            blank: true,
            cwd: '/w/one',
            title: 'Blank',
          }],
        }),
      },
    })
    await b.svc.refresh()

    const reference = b.svc.retain(sid('alpha:s-1'), { source: 'mainView' })
    onTestFinished(() => { reference.release() })
    await reference.ready

    const state = b.svc.list.getSnapshot()
    expect(state.ids).toEqual([sid('local-blank')])
    expect(state.byId[sid('local-blank')]?.blank).toBe(true)
    expect(state.byId[sid('alpha:s-1')]?.blank).toBe(false)
  })
})
