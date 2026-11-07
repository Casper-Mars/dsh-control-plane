/**
 * Independent verification of the control-plane federation rollout switch
 * (t100636), updated for t100637's self-installed forwarder.
 *
 * The control plane is now its own forwarder: constructing it installs the
 * transport, so the only questions left are lifecycle ones — is the router
 * registered, who is in its instance predicate, and does it disappear on
 * disposal. A Gateway stub records registrations and disposals, so nothing here
 * touches a socket.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { FederationRouter } from '@deepseek-ai/dsh-api-gateway'
import { describe, expect, it } from 'vitest'
import type { ResolvedInstance } from '../src/config.ts'
import { ControlPlane } from '../src/index.ts'

const INSTANCES: readonly ResolvedInstance[] = [
  { id: 'alpha', name: 'Alpha', host: '127.0.0.1', port: 1, baseUrl: 'http://127.0.0.1:1' },
  { id: 'beta', name: 'Beta', host: '127.0.0.1', port: 2, baseUrl: 'http://127.0.0.1:2' },
]

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
  it('installs its own forwarder and registers with the configured instance predicate', () => {
    const gateway = gatewayStub()
    const control = new ControlPlane(stubContext(gateway), rawConfig())

    expect(active(gateway)).toHaveLength(1)
    const router = active(gateway)[0]?.router
    // The forwarder is the control plane itself, and both carriers exist.
    expect(typeof router?.forwarder.unary).toBe('function')
    expect(typeof router?.forwarder.stream).toBe('function')
    expect(router?.hasInstance('alpha')).toBe(true)
    expect(router?.hasInstance('beta')).toBe(true)
    expect(router?.hasInstance('ghost')).toBe(false)

    // A second installation is still refused: exactly one transport owns routing.
    expect(() => control.installFederationForwarder({
      unary: async () => 'other',
      stream: () => (async function * () { yield 'other' })(),
    })).toThrow(/already installed/)
  })

  it('never registers when federation.enabled=false', () => {
    const gateway = gatewayStub()
    const control = new ControlPlane(stubContext(gateway), rawConfig({ enabled: false }))

    expect(gateway.registrations).toHaveLength(0)
    // Installing a transport cannot re-open the rollout switch.
    expect(() => control.installFederationForwarder({
      unary: async () => 'x',
      stream: () => (async function * () { yield 'x' })(),
    })).toThrow(/already installed/)
    expect(gateway.registrations).toHaveLength(0)
  })

  it('treats an absent federation config as enabled', () => {
    const gateway = gatewayStub()
    new ControlPlane(stubContext(gateway), rawConfig())
    expect(active(gateway)).toHaveLength(1)
  })

  it('does not register without an active Gateway and still disposes cleanly', async () => {
    const control = new ControlPlane(stubContext(undefined), rawConfig({ enabled: true }))
    expect(() => control.installFederationForwarder({
      unary: async () => 'x',
      stream: () => (async function * () { yield 'x' })(),
    })).toThrow(/already installed/)
    await expect(control.dispose()).resolves.toBeUndefined()
  })

  it('detaches the router on plugin disposal and allows a re-install afterwards', async () => {
    const gateway = gatewayStub()
    const control = new ControlPlane(stubContext(gateway), rawConfig({ enabled: true }))
    expect(active(gateway)).toHaveLength(1)

    await control.dispose()
    expect(active(gateway)).toHaveLength(0)

    // dispose() forgot the forwarder, so a fresh installation registers again.
    const again = control.installFederationForwarder({
      unary: async () => 'x',
      stream: () => (async function * () { yield 'x' })(),
    })
    expect(active(gateway)).toHaveLength(1)
    again()
    expect(active(gateway)).toHaveLength(0)
  })

  it('rejects a custom forwarder while its own is installed', () => {
    const gateway = gatewayStub()
    const control = new ControlPlane(stubContext(gateway), rawConfig({ enabled: true }))
    expect(() => control.installFederationForwarder({
      unary: async () => 'x',
      stream: () => (async function * () { yield 'x' })(),
    })).toThrow(/already installed/)
  })
})
