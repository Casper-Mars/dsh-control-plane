/**
 * Independent verification of the control-plane federation rollout switch
 * (t100636). Uses a Gateway stub that records registrations and disposals, so
 * the assertions are about lifecycle only: when a router exists, who is in its
 * instance predicate, and when it disappears.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { FederationForwarder, FederationRouter } from '@deepseek-ai/dsh-api-gateway'
import { describe, expect, it } from 'vitest'
import type { ResolvedInstance } from '../src/config.ts'
import { ControlPlane } from '../src/index.ts'

const INSTANCES: readonly ResolvedInstance[] = [
  { id: 'alpha', name: 'Alpha', host: '127.0.0.1', port: 1, baseUrl: 'http://127.0.0.1:1' },
  { id: 'beta', name: 'Beta', host: '127.0.0.1', port: 2, baseUrl: 'http://127.0.0.1:2' },
]

const FORWARDER: FederationForwarder = {
  unary: async () => 'forwarded-unary',
  stream: () => (async function * () { yield 'forwarded-stream' })(),
}

interface Registration {
  readonly router: FederationRouter
  disposed: boolean
}

interface GatewayStub {
  readonly registrations: Registration[]
  registerFederationRouter(router: FederationRouter): () => void
}

function gatewayStub(): GatewayStub {
  const registrations: Registration[] = []
  return {
    registrations,
    registerFederationRouter(router) {
      if (registrations.some(entry => !entry.disposed)) {
        throw new Error('typert gateway: federation router is already registered')
      }
      const entry: Registration = { router, disposed: false }
      registrations.push(entry)
      return () => { entry.disposed = true }
    },
  }
}

/** Minimal Context: answers `get`, never activates effects, never connects. */
function stubContext(gateway: GatewayStub | undefined): Context {
  return {
    reflect: { provide: (): void => {} },
    get: (key: string) => key === 'typertGateway' ? gateway : undefined,
    effect: () => () => {},
  } as unknown as Context
}

function rawConfig(federation?: { readonly enabled?: boolean }) {
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

function active(stub: GatewayStub): Registration[] {
  return stub.registrations.filter(entry => !entry.disposed)
}

describe('control-plane federation rollout switch (independent)', () => {
  it('registers only after a forwarder is installed, with the configured instance predicate', () => {
    const gateway = gatewayStub()
    const control = new ControlPlane(stubContext(gateway), rawConfig())

    // enabled=true but no forwarder yet: the Gateway keeps the local-only path.
    expect(active(gateway)).toHaveLength(0)

    const uninstall = control.installFederationForwarder(FORWARDER)
    expect(active(gateway)).toHaveLength(1)
    const router = active(gateway)[0]?.router
    expect(router?.forwarder).toBe(FORWARDER)
    expect(router?.hasInstance('alpha')).toBe(true)
    expect(router?.hasInstance('beta')).toBe(true)
    expect(router?.hasInstance('ghost')).toBe(false)

    uninstall()
    expect(active(gateway)).toHaveLength(0)
    // Idempotent uninstall.
    expect(() => { uninstall() }).not.toThrow()
  })

  it('never registers when federation.enabled=false, even with a forwarder', () => {
    const gateway = gatewayStub()
    const control = new ControlPlane(stubContext(gateway), rawConfig({ enabled: false }))

    const uninstall = control.installFederationForwarder(FORWARDER)
    expect(gateway.registrations).toHaveLength(0)
    uninstall()
    expect(gateway.registrations).toHaveLength(0)
  })

  it('treats an absent federation config as enabled', () => {
    const gateway = gatewayStub()
    const control = new ControlPlane(stubContext(gateway), rawConfig())
    const uninstall = control.installFederationForwarder(FORWARDER)
    expect(active(gateway)).toHaveLength(1)
    uninstall()
  })

  it('does not register without an active Gateway and still disposes cleanly', async () => {
    const control = new ControlPlane(stubContext(undefined), rawConfig({ enabled: true }))
    expect(() => control.installFederationForwarder(FORWARDER)).not.toThrow()
    await expect(control.dispose()).resolves.toBeUndefined()
  })

  it('detaches the router on plugin disposal and allows a re-install afterwards', async () => {
    const gateway = gatewayStub()
    const control = new ControlPlane(stubContext(gateway), rawConfig({ enabled: true }))

    control.installFederationForwarder(FORWARDER)
    expect(active(gateway)).toHaveLength(1)

    await control.dispose()
    expect(active(gateway)).toHaveLength(0)

    // dispose() forgot the forwarder, so a fresh installation registers again.
    const again = control.installFederationForwarder(FORWARDER)
    expect(active(gateway)).toHaveLength(1)
    again()
    expect(active(gateway)).toHaveLength(0)
  })

  it('rejects a second forwarder while one is installed', () => {
    const gateway = gatewayStub()
    const control = new ControlPlane(stubContext(gateway), rawConfig({ enabled: true }))
    const uninstall = control.installFederationForwarder(FORWARDER)
    expect(() => control.installFederationForwarder(FORWARDER)).toThrow(/already installed/)
    uninstall()
  })
})
