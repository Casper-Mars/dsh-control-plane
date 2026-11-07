/**
 * Control-plane federation rollout switch.
 *
 * These specs use a stubbed Gateway only: they assert when the control plane
 * registers a router, not how a call is forwarded. The forwarder itself is
 * supplied by the federation transport; this milestone must never fake one,
 * so nothing is registered until `installFederationForwarder` is called.
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
  it('registers a router when federation is enabled by default', () => {
    const gateway = gatewayProbe()
    const control = new ControlPlane(fakeContext(gateway), config())
    const uninstall = control.installFederationForwarder(FORWARDER)

    expect(active(gateway)).toHaveLength(1)
    const router = active(gateway)[0]?.router
    expect(router?.hasInstance('alpha')).toBe(true)
    expect(router?.hasInstance('beta')).toBe(true)
    expect(router?.hasInstance('ghost')).toBe(false)
    expect(router?.forwarder).toBe(FORWARDER)
    uninstall()
  })

  it('never registers a router when federation is disabled', () => {
    const gateway = gatewayProbe()
    const control = new ControlPlane(fakeContext(gateway), config({ enabled: false }))
    const uninstall = control.installFederationForwarder(FORWARDER)

    expect(gateway.entries).toHaveLength(0)
    uninstall()
  })

  it('does not register without an active Gateway', () => {
    const control = new ControlPlane(fakeContext(undefined), config({ enabled: true }))
    expect(() => control.installFederationForwarder(FORWARDER)).not.toThrow()
  })

  it('detaches the router on uninstall and on plugin disposal', async () => {
    const gateway = gatewayProbe()
    const control = new ControlPlane(fakeContext(gateway), config({ enabled: true }))
    const uninstall = control.installFederationForwarder(FORWARDER)
    expect(active(gateway)).toHaveLength(1)

    uninstall()
    expect(active(gateway)).toHaveLength(0)

    const again = control.installFederationForwarder(FORWARDER)
    expect(active(gateway)).toHaveLength(1)
    await control.dispose()
    expect(active(gateway)).toHaveLength(0)
    again()
  })
})
