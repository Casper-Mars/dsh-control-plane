/**
 * Control-plane federation rollout switch.
 *
 * These specs use a stubbed Gateway only: they assert when the control plane
 * registers a router, not how a call is forwarded. Since t100637 the control
 * plane is its own forwarder, so construction installs the transport and the
 * switch below decides only whether the Gateway may route to it.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { FederationForwarder, FederationRouter } from '@deepseek-ai/dsh-api-gateway'
import { describe, expect, it } from 'vitest'
import type { ResolvedInstance } from '../src/config.ts'
import { ControlPlane } from '../src/index.ts'

const INSTANCES: readonly ResolvedInstance[] = [
  { id: 'alpha', name: 'Alpha', host: 'a.local', port: 1, baseUrl: 'http://a.local:1' },
  { id: 'beta', name: 'Beta', host: 'b.local', port: 2, baseUrl: 'http://b.local:2' },
]

const FORWARDER: FederationForwarder = {
  unary: async () => 'unary-result',
  stream: () => (async function * () { yield 'stream-result' })(),
}

interface RouterEntry {
  readonly router: FederationRouter
  disposed: boolean
}

interface GatewayProbe {
  readonly entries: RouterEntry[]
  registerFederationRouter(router: FederationRouter): () => void
}

function gatewayProbe(): GatewayProbe {
  const entries: RouterEntry[] = []
  return {
    entries,
    registerFederationRouter(router) {
      if (entries.some(entry => !entry.disposed)) {
        throw new Error('typert gateway: federation router is already registered')
      }
      const entry: RouterEntry = { router, disposed: false }
      entries.push(entry)
      return () => { entry.disposed = true }
    },
  }
}

/** Minimal Context: provides services, answers `get`, and never activates effects. */
function fakeContext(gateway: GatewayProbe | undefined): Context {
  return {
    reflect: { provide: (): void => {} },
    get: (key: string) => key === 'typertGateway' ? gateway : undefined,
    effect: () => () => {},
  } as unknown as Context
}

function config(federation?: { enabled?: boolean }) {
  return {
    instances: INSTANCES.map(instance => ({
      id: instance.id,
      name: instance.name,
      host: instance.host,
      port: instance.port,
    })),
    ...(federation === undefined ? {} : { federation }),
  }
}

function active(probe: GatewayProbe): RouterEntry[] {
  return probe.entries.filter(entry => !entry.disposed)
}

describe('control-plane federation switch', () => {
  it('registers a router, carrying its own forwarder, when federation is enabled by default', () => {
    const gateway = gatewayProbe()
    new ControlPlane(fakeContext(gateway), config())

    expect(active(gateway)).toHaveLength(1)
    const router = active(gateway)[0]?.router
    expect(router?.hasInstance('alpha')).toBe(true)
    expect(router?.hasInstance('beta')).toBe(true)
    expect(router?.hasInstance('ghost')).toBe(false)
    // The transport belongs to the control plane: both carriers are callable.
    expect(typeof router?.forwarder.unary).toBe('function')
    expect(typeof router?.forwarder.stream).toBe('function')
  })

  it('never registers a router when federation is disabled', () => {
    const gateway = gatewayProbe()
    const control = new ControlPlane(fakeContext(gateway), config({ enabled: false }))

    expect(gateway.entries).toHaveLength(0)
    // The rollout switch is not re-openable by installing another transport.
    expect(() => control.installFederationForwarder(FORWARDER)).toThrow(/already installed/)
    expect(gateway.entries).toHaveLength(0)
  })

  it('does not register without an active Gateway, and disposes cleanly', async () => {
    const control = new ControlPlane(fakeContext(undefined), config({ enabled: true }))
    await expect(control.dispose()).resolves.toBeUndefined()
  })

  it('detaches the router on plugin disposal and re-registers after a fresh install', async () => {
    const gateway = gatewayProbe()
    const control = new ControlPlane(fakeContext(gateway), config({ enabled: true }))
    expect(active(gateway)).toHaveLength(1)

    await control.dispose()
    expect(active(gateway)).toHaveLength(0)

    // dispose() forgot the transport, so an explicit installation registers again.
    const again = control.installFederationForwarder(FORWARDER)
    expect(active(gateway)).toHaveLength(1)
    expect(active(gateway)[0]?.router.forwarder).toBe(FORWARDER)
    again()
    expect(active(gateway)).toHaveLength(0)
  })
})
