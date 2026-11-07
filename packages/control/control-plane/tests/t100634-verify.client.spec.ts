/**
 * Independent t100634 verification (tester-authored).
 *
 * Black-box checks of the `title` projection seam: the `toSessionRow`
 * normalization matrix (trim, blank, null, missing blocks, non-string values),
 * its effect on the other row fields, the `buildTree` pass-through that the
 * sidebar consumes, and the generated typert decode schema for `session/list`
 * — the runtime gate that either keeps `projections.values.title` on the wire
 * or strips it before the control plane ever sees it.
 *
 * Nothing here reuses the developer's `session-row.client.spec.ts` fixtures;
 * this file only drives the exported seams.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ResolvedInstance } from '../src/config.ts'
import { buildTree } from '../src/tree.ts'
import type { SessionRow } from '../src/types.ts'
import { toSessionRow, type RawSummary } from '../src/upstream.ts'
import { TYPERT as typertProduct } from '../../../api/session-controller/lib/typert.host.js'
import { TYPERT_REMOTE as remoteProduct } from '../../../api/session-controller/lib/typert.remote-client.js'
import { TYPERT_REMOTE as controlPlaneRemoteProduct } from '../lib/typert.remote-client.js'

/** One summary carrying every field the Host always reports. */
function raw(overrides: Partial<RawSummary> = {}): RawSummary {
  return {
    sessionId: 'session-1',
    cwd: '/workspace',
    updatedAt: 1_700_000_000_000,
    running: false,
    agentAvailable: true,
    ...overrides,
  }
}

/** One title projection block, in the shape the wire block arrives. */
function hints(title: unknown): RawSummary['projections'] {
  return { values: { title } }
}

// ---------------------------------------------------------------------------
// 1a — the title value itself: carry, trim, and every blank/absent form
// ---------------------------------------------------------------------------
describe('toSessionRow title value', () => {
  it('carries a normal title verbatim apart from the trim', () => {
    const row = toSessionRow(raw({ projections: hints('Fix the login flow') }))
    expect(row.title).toBe('Fix the login flow')
    expect(Object.keys(row)).toContain('title')
  })

  it('trims leading and trailing whitespace', () => {
    expect(toSessionRow(raw({ projections: hints('  Fix the login flow  ') })).title)
      .toBe('Fix the login flow')
    expect(toSessionRow(raw({ projections: hints('\n\tRenamed\r\n') })).title).toBe('Renamed')
  })

  it('keeps inner whitespace untouched', () => {
    expect(toSessionRow(raw({ projections: hints('  a  b  ') })).title).toBe('a  b')
  })

  it('omits the key entirely for null, empty, and whitespace-only titles', () => {
    const blanks: readonly (readonly [string, unknown])[] = [
      ['null', null], ['empty', ''], ['spaces', '   '], ['tabs and newlines', '\t\n'], ['undefined', undefined],
    ]
    for (const [label, title] of blanks) {
      const row = toSessionRow(raw({ projections: hints(title) }))
      // Absent key, not `title: undefined`: the row shape is exactly-optional.
      expect(Object.hasOwn(row, 'title'), label).toBe(false)
      expect(row, label).not.toHaveProperty('title')
    }
  })

  it('omits the key when the projections or values block is missing', () => {
    expect(toSessionRow(raw())).not.toHaveProperty('title')
    expect(toSessionRow(raw({ projections: {} }))).not.toHaveProperty('title')
    expect(toSessionRow(raw({ projections: { values: {} } }))).not.toHaveProperty('title')
  })

  it('ignores a non-string title value', () => {
    const nonStrings: readonly (readonly [string, unknown])[] = [
      ['number', 42], ['zero', 0], ['boolean', true],
      ['object', {}], ['array', []], ['structured object', { text: 'x' }], ['symbol', Symbol('t')],
    ]
    for (const [label, title] of nonStrings) {
      const row = toSessionRow(raw({ projections: hints(title) }))
      expect(Object.hasOwn(row, 'title'), label).toBe(false)
    }
  })

  it('honours the trim before judging blankness (nothing survives trim)', () => {
    // A string of only exotic whitespace must not become a row title.
    expect(toSessionRow(raw({ projections: hints('\u00a0\u3000') }))).not.toHaveProperty('title')
  })
})

// ---------------------------------------------------------------------------
// 1b — the rest of the row is untouched by the title decision
// ---------------------------------------------------------------------------
describe('toSessionRow other fields', () => {
  const cases: readonly { readonly name: string; readonly projections?: RawSummary['projections'] }[] = [
    { name: 'title present', projections: hints('  Named  ') },
    { name: 'title null', projections: hints(null) },
    { name: 'title blank', projections: hints('  ') },
    { name: 'title non-string', projections: hints(7) },
    { name: 'projections missing' },
  ]

  it.each(cases)('maps every other field with $name', ({ projections }) => {
    const row: SessionRow = toSessionRow(raw({
      sessionId: 's-9',
      cwd: '/repo',
      updatedAt: 1_600_000_000_123,
      running: true,
      agentAvailable: false,
      ...(projections === undefined ? {} : { projections }),
    }))
    expect(row.sessionId).toBe('s-9')
    expect(row.cwd).toBe('/repo')
    expect(row.updatedAt).toBe(1_600_000_000_123)
    expect(row.running).toBe(true)
    expect(row.agentAvailable).toBe(false)
  })

  it('stringifies a non-string sessionId and still resolves the title', () => {
    expect(toSessionRow(raw({ sessionId: 7, projections: hints('Seven') }))).toEqual({
      sessionId: '7',
      cwd: '/workspace',
      updatedAt: 1_700_000_000_000,
      running: false,
      agentAvailable: true,
      title: 'Seven',
    })
  })

  it('maps a non-number updatedAt through Number()', () => {
    expect(toSessionRow(raw({ updatedAt: '1700000000123' })).updatedAt).toBe(1_700_000_000_123)
    expect(toSessionRow(raw({ updatedAt: undefined })).updatedAt).toBeNaN()
    expect(toSessionRow(raw({ updatedAt: 'not-a-number' })).updatedAt).toBeNaN()
  })

  it('coerces the tri-state flags the same way with and without a title', () => {
    for (const projections of [hints('Named'), hints(null)]) {
      expect(toSessionRow(raw({ running: 'yes', agentAvailable: 'no', projections })).running).toBe(false)
      expect(toSessionRow(raw({ agentAvailable: 'no', projections })).agentAvailable).toBe(undefined)
      expect(toSessionRow(raw({ agentAvailable: false, projections })).agentAvailable).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// 2 — the tree the sidebar receives keeps the title and the federated key
// ---------------------------------------------------------------------------
describe('buildTree carries the title through', () => {
  const instances: readonly ResolvedInstance[] = [
    { id: 'alpha', name: 'Alpha', host: 'a.local', port: 1, baseUrl: 'http://a.local:1' },
  ]

  it('copies title onto the session node and drops it when absent', () => {
    const rows: readonly SessionRow[] = [
      toSessionRow(raw({ sessionId: 'named', projections: hints('  Named session  ') })),
      toSessionRow(raw({ sessionId: 'plain', projections: hints(null) })),
    ]
    const [group] = buildTree(instances, new Map([['alpha', rows]]))
    const sessions = group?.workspaces[0]?.sessions ?? []
    const named = sessions.find(session => session.sessionId === 'named')
    const plain = sessions.find(session => session.sessionId === 'plain')
    expect(named?.title).toBe('Named session')
    expect(named?.key).toBe('alpha:named')
    expect(plain).not.toHaveProperty('title')
    expect(plain?.key).toBe('alpha:plain')
    // The federation key stays independent of the title.
    expect(sessions.map(session => session.key).sort()).toEqual(['alpha:named', 'alpha:plain'])
  })
})

// ---------------------------------------------------------------------------
// 3 — the generated typert decode schema: does values.title survive?
// ---------------------------------------------------------------------------
interface TypertSchema { parse: (value: unknown) => unknown }
interface TypertInvocation {
  readonly id: string
  readonly namespace: string
  readonly method: string
  readonly result: { readonly create: () => TypertSchema }
}
interface TypertProduct { readonly invocations: readonly TypertInvocation[] }

const typert = typertProduct as TypertProduct

/** The control-plane side of the same seam: its remote client's decode face. */
interface TypertRemoteMethod { readonly result: { readonly create: () => TypertSchema } }
interface TypertRemoteProduct {
  readonly spec: { readonly methods: Readonly<Record<string, TypertRemoteMethod>> }
}

const remote = remoteProduct as TypertRemoteProduct

/** This package's own artifact, i.e. the decode the browser's tree read uses. */
const controlPlaneRemote = controlPlaneRemoteProduct as TypertRemoteProduct

/** The generated `session/list` result codec (the host's result encoder). */
function listCodec(): TypertSchema {
  const descriptor = typert.invocations.find(item => item.namespace === 'session' && item.method === 'list')
  if (descriptor === undefined) throw new Error('typert product exposes no session/list descriptor')
  return descriptor.result.create()
}

/** One upstream `SessionListValue` row as the Host encodes it. */
function wireRow(values: Record<string, unknown>): Record<string, unknown> {
  return {
    agentAvailable: true,
    sessionId: 'session-1',
    updatedAt: 1_700_000_000_000,
    running: true,
    blank: false,
    cwd: '/workspace',
    projections: { kind: 'sequenced', asOfSeq: 12, values },
  }
}

/** The `session/list` result decoder the control plane's remote client uses. */
function listRemoteCodec(): TypertSchema {
  const method = remote.spec.methods['session/list']
  if (method === undefined) throw new Error('typert remote product exposes no session/list method')
  return method.result.create()
}

describe('typert session/list decode keeps the title projection', () => {
  it('has a session/list descriptor with a result codec', () => {
    expect(listCodec()).toBeDefined()
    expect(typeof listCodec().parse).toBe('function')
  })

  it('keeps a string title and a null title through decode', () => {
    const codec = listCodec()
    const named = codec.parse({ items: [wireRow({ title: '  Fix the login flow  ' })] }) as {
      items: { projections: { values: Record<string, unknown> } }[]
    }
    // Decode is lossless for the value; trimming belongs to toSessionRow.
    expect(named.items[0]?.projections.values['title']).toBe('  Fix the login flow  ')
    expect(Object.hasOwn(named.items[0]?.projections.values ?? {}, 'title')).toBe(true)

    const untitled = codec.parse({ items: [wireRow({ title: null })] }) as {
      items: { projections: { values: Record<string, unknown> } }[]
    }
    expect(untitled.items[0]?.projections.values['title']).toBeNull()
  })

  it('is the schema that strips unknown projection keys (why a missing title would be a blocker)', () => {
    const decoded = listCodec().parse({ items: [wireRow({ title: 'Named', notAProjectionKey: 1 })] }) as {
      items: { projections: { values: Record<string, unknown> } }[]
    }
    // Proven guard: the codec is authoritative. Any key absent from the
    // generated values object would be dropped exactly like this one.
    expect(Object.hasOwn(decoded.items[0]?.projections.values ?? {}, 'notAProjectionKey')).toBe(false)
  })

  it('round-trips the decoded row through toSessionRow', () => {
    const decoded = listCodec().parse({ items: [wireRow({ title: '  Fix the login flow  ' })] }) as {
      items: readonly RawSummary[]
    }
    const row = toSessionRow(decoded.items[0] as RawSummary)
    expect(row.title).toBe('Fix the login flow')
    expect(row.running).toBe(true)
  })

  it('the committed artifact declares title inside the session/list values object', () => {
    // Static counterpart to the runtime parse above: pin the generated text so
    // a stale lib/ product cannot pass silently on a cached schema instance.
    const artifact = resolve(process.cwd(), 'packages/api/session-controller/lib/typert.host.js')
    const source = readFileSync(artifact, 'utf8')
    const start = source.indexOf('_deepseek_ai_dsh_api_session_controller_session_list_result$schema = () =>')
    const end = source.indexOf('_deepseek_ai_dsh_api_session_controller_session_modelCatalog_result$schema = () =>')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = source.slice(start, end)
    expect(block).toContain("'projections': z.object({")
    expect(block).toContain("'values': z.object({")
    expect(block).toContain("'title': z.union([z.literal(null), z.string()]).optional()")
  })

  it('decodes through the remote-client face the control plane actually reads with', () => {
    const decoded = listRemoteCodec().parse({ items: [wireRow({ title: 'Named', notAProjectionKey: 1 })] }) as {
      items: { projections: { values: Record<string, unknown> } }[]
    }
    // The upstream Host encodes with the host face; the control plane decodes
    // with this one. Both must carry the key or the title never arrives.
    expect(decoded.items[0]?.projections.values['title']).toBe('Named')
    expect(Object.hasOwn(decoded.items[0]?.projections.values ?? {}, 'notAProjectionKey')).toBe(false)
  })

  it('the browser-side controlPlane/tree decode keeps the row title', () => {
    // Last link in the chain: control plane → browser. A title dropped here
    // would reach the sidebar as absent even with both upstream faces intact.
    const method = controlPlaneRemote.spec.methods['controlPlane/tree']
    if (method === undefined) throw new Error('control-plane artifact exposes no controlPlane/tree method')
    const decoded = method.result.create().parse([{
      instanceId: 'alpha',
      label: 'Alpha(alpha)',
      runningCount: 1,
      sessionCount: 1,
      workspaces: [{
        key: 'alpha:/w',
        path: '/w',
        runningCount: 1,
        latestUpdatedAt: 1,
        sessions: [
          { key: 'alpha:s1', instanceId: 'alpha', sessionId: 's1', title: ' Named ', updatedAt: 1, running: true },
          { key: 'alpha:s2', instanceId: 'alpha', sessionId: 's2', updatedAt: 2, running: false },
        ],
      }],
    }]) as [{
      workspaces: [{ sessions: { title?: string }[] }]
    }]
    const sessions = decoded[0]?.workspaces[0]?.sessions ?? []
    expect(sessions[0]?.title).toBe(' Named ')
    expect(Object.hasOwn(sessions[1] ?? {}, 'title')).toBe(false)
  })

  it('the remote-client artifact declares title inside its session/list values object', () => {
    const artifact = resolve(process.cwd(), 'packages/api/session-controller/lib/typert.remote-client.js')
    const source = readFileSync(artifact, 'utf8')
    const start = source.indexOf('_deepseek_ai_dsh_api_session_controller_session_list_result$schema = () =>')
    const end = source.indexOf('_deepseek_ai_dsh_api_session_controller_session_modelCatalog_result$schema = () =>')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(source.slice(start, end)).toContain("'title': z.union([z.literal(null), z.string()]).optional()")
  })
})
