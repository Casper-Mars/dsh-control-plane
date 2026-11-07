/**
 * t100640 — `sessions.create` with a federated Workspace key.
 *
 * A control plane multiplexes several instances into one Gateway, so the
 * browser passes `<instanceId>:<cwd>` as the workspace and the owning instance
 * answers with its bare local Session id. That id belongs to another catalog:
 * this Client must neither publish a placeholder for it nor attach a failed
 * create's id to its list. The qualified row arrives through the control
 * plane's tree refresh instead.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, onTestFinished } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  createClientTest, webApp, type TestClient,
} from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { ClientSessions } from '../src/client/sessions/service.ts'
import { err, sessionWorld } from './remote/session.client.ts'

const BARE = SessionId('s-new')
const GHOST = SessionId('s-ghost')
const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-api-gateway']) })

/** A composed Session service over the mocked Remote, ready for catalog reads. */
async function bench(mock: RemoteMock, start: () => Promise<TestClient>) {
  mock.load(sessionWorld)
  const client = await start()
  const ctx = new Context()
  const sessions = new ClientSessions(ctx, client.ctx.remote)
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return { sessions, ctx }
}

describe('federated session create', () => {
  it('forwards the complete workspace key and does not catalogue the bare answer', async ({ mock, start, remote }) => {
    remote.session.create.mockResolvedValue(ok({ sessionId: BARE }))
    const { sessions } = await bench(mock, start)

    const created = await sessions.create({ workspaceId: 'alpha:/repo' as never })

    // The Gateway, not this Client, splits the instance prefix.
    expect(remote.session.create).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'alpha:/repo' })
    expect(created).toBe(BARE)
    const list = sessions.list.getSnapshot()
    expect(list.ids).toEqual([])
    expect(list.byId[BARE]).toBeUndefined()
  })

  it('does not publish a failed federated create\'s attach id either', async ({ mock, start, remote }) => {
    remote.session.create.mockResolvedValue(err(new RemoteError('session/workspace-attach-failed', 'published but unattached', {
      sessionId: GHOST, workspaceId: 'alpha:/repo',
    })))
    const { sessions } = await bench(mock, start)

    await expect(sessions.create({ workspaceId: 'alpha:/repo' as never }))
      .rejects.toMatchObject({ name: 'SessionCreateError' })
    expect(sessions.list.getSnapshot().ids).toEqual([])
    expect(sessions.list.getSnapshot().byId[GHOST]).toBeUndefined()
  })

  it('keeps the local placeholder behaviour for a local workspace', async ({ mock, start, remote }) => {
    remote.session.create.mockResolvedValue(ok({ sessionId: BARE }))
    const { sessions } = await bench(mock, start)

    await sessions.create({ workspaceId: 'w1' as never })

    expect(remote.session.create).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'w1' })
    // No colon: a local key, so the merged row is the established behaviour.
    expect(sessions.list.getSnapshot().ids).toEqual([BARE])
    expect(sessions.list.getSnapshot().byId[BARE]).toBeDefined()
  })

  it('keeps the published-row behaviour for a local workspace on attach failure', async ({ mock, start, remote }) => {
    remote.session.create.mockResolvedValue(err(new RemoteError('session/workspace-attach-failed', 'published but unattached', {
      sessionId: GHOST, workspaceId: 'w1',
    })))
    const { sessions } = await bench(mock, start)

    await expect(sessions.create({ workspaceId: 'w1' as never })).rejects.toMatchObject({
      name: 'SessionCreateError',
    })

    expect(sessions.list.getSnapshot().ids).toEqual([GHOST])
  })

  it('also treats a federated blank Session id as remote', async ({ mock, start, remote }) => {
    remote.session.create.mockResolvedValue(ok({ sessionId: BARE }))
    const { sessions } = await bench(mock, start)

    await sessions.create({ workspaceId: 'alpha:/repo' as never, sessionId: 'alpha:blank' as never })

    expect(remote.session.create).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'alpha:/repo', sessionId: 'alpha:blank',
    })
    expect(sessions.list.getSnapshot().ids).toEqual([])
  })
})
