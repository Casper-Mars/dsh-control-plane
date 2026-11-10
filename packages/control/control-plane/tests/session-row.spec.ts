/**
 * `toSessionRow`: mapping one upstream `SessionSummary` onto the row the
 * sidebar consumes, with the title projection as the only optional piece.
 *
 * The Host reports `null` before a title exists, and titles are user text, so
 * blank strings must not shadow the sidebar's id fallback.
 */
import { describe, expect, it } from 'vitest'
import { toSessionRow, type RawSummary } from '../src/upstream.ts'

/** One summary with the fields upstream always reports. */
function summary(overrides: Partial<RawSummary> = {}): RawSummary {
  return {
    sessionId: 'session-1',
    cwd: '/workspace',
    updatedAt: 1_700_000_000_000,
    running: false,
    agentAvailable: true,
    ...overrides,
  }
}

describe('toSessionRow', () => {
  it('maps the required summary fields', () => {
    expect(toSessionRow(summary({ sessionId: 7, running: true, agentAvailable: false }))).toEqual({
      sessionId: '7',
      cwd: '/workspace',
      updatedAt: 1_700_000_000_000,
      running: true,
      agentAvailable: false,
    })
  })

  it('carries a non-blank title projection and trims it', () => {
    const row = toSessionRow(summary({
      projections: { values: { title: '  Fix the login flow  ' } },
    }))
    expect(row.title).toBe('Fix the login flow')
  })

  it('omits the title while the projection is still null', () => {
    const row = toSessionRow(summary({ projections: { values: { title: null } } }))
    expect(row).not.toHaveProperty('title')
  })

  it('omits a blank title so the id fallback stays in charge', () => {
    expect(toSessionRow(summary({ projections: { values: { title: '   ' } } }))).not.toHaveProperty('title')
    expect(toSessionRow(summary({ projections: { values: { title: '' } } }))).not.toHaveProperty('title')
  })

  it('omits the title when the projection block or value is absent', () => {
    expect(toSessionRow(summary())).not.toHaveProperty('title')
    expect(toSessionRow(summary({ projections: {} }))).not.toHaveProperty('title')
    expect(toSessionRow(summary({ projections: { values: {} } }))).not.toHaveProperty('title')
  })

  it('ignores a non-string title value', () => {
    const row = toSessionRow(summary({ projections: { values: { title: 42 } } }))
    expect(row).not.toHaveProperty('title')
  })

  it('carries the subagent origin the instance reported', () => {
    expect(toSessionRow(summary({ origin: 'subagent' })).origin).toBe('subagent')
  })

  it('omits origin for an ordinary session or an unknown value', () => {
    expect(toSessionRow(summary())).not.toHaveProperty('origin')
    expect(toSessionRow(summary({ origin: 'primary' }))).not.toHaveProperty('origin')
    expect(toSessionRow(summary({ origin: 1 }))).not.toHaveProperty('origin')
  })
})
