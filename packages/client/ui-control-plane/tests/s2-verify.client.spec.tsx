// @vitest-environment jsdom
/**
 * Independent S2 verification (tester-authored).
 *
 * Covers the eight acceptance points for the control-plane instance groups:
 * header contents + tri-state dot, fold survival across the 6s poll, the
 * 8/16/20 session paging ladder, keep-the-previous-frame on failed reads, the
 * plain-dsh (no control plane) path, the rail (wide=false) path, the static
 * style/token contract, and the bundle artifact.
 *
 * Fixtures use unique instance ids and workspace keys per case because the
 * disclosure store is module-level (fold state is intentionally process-wide).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import {
  InstanceGroups, instanceGroupsSlot,
  type InstanceGroupView, type InstanceSessionView,
} from '../src/client/InstanceGroups.tsx'
import { apply, inject } from '../src/client/index.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '@deepseek-ai/dsh-client-ui-sidebar/src/client/locales.ts'

const t = makeTranslate({ ...commonEn, ...en })

const owners = new Set<Fiber>()

/** The shell frame that owns the `sidebar` hole the section registers into. */
function SidebarFrame({ renderSlot }: PropsRenderSlots<'sidebar'>) {
  return renderSlot('sidebar', { collapsed: false, width: 300, drawer: false })
}

afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  for (const owner of owners) {
    try { await owner.dispose() } catch { /* bench teardown */ }
  }
  owners.clear()
})

/** Let already-resolved reader promises commit inside act. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

/** Advance fake time and flush the poll's promises. */
async function tick(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function session(instanceId: string, index: number, minutesAgo = index): InstanceSessionView {
  return {
    key: `${instanceId}:s${index}`,
    sessionId: `s${index}`,
    running: index === 0,
    updatedAt: Date.now() - minutesAgo * 60_000,
  }
}

function group(
  instanceId: string,
  count: number,
  path = `/ws-${instanceId}`,
  state: InstanceGroupView['state'] = 'connected',
  error?: string,
): InstanceGroupView {
  return {
    instanceId,
    label: `${instanceId}(id)`,
    state,
    ...(error === undefined ? {} : { error }),
    runningCount: count > 0 ? 1 : 0,
    sessionCount: count,
    workspaces: count === 0 ? [] : [{
      key: `${instanceId}:${path}`,
      path,
      runningCount: 1,
      sessions: Array.from({ length: count }, (_, i) => session(instanceId, i)),
    }],
  }
}

/**
 * A `retry` reader: since S3-03 reachability comes from the tree frame itself,
 * so the section's only other reader is the retry control.
 */
function retry(): (instanceId: string) => Promise<void> {
  return async () => {}
}

/** Count rendered session rows. */
function rows(container: HTMLElement): number {
  return container.querySelectorAll('[data-session-key]').length
}

// ---------------------------------------------------------------------------
// P1 — header: name + tri-state dot + session count + aria-label
// ---------------------------------------------------------------------------
describe('P1 header contents and tri-state reachability', () => {
  it('renders name, session count and the connected dot', async () => {
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group('p1a', 3)]}
        retry={retry()}
        t={t}
      />,
    )
    await settle()
    const header = screen.getByRole('button', { name: 'p1a(id), Connected, 3 sessions' })
    expect(header.getAttribute('data-instance-state')).toBe('connected')
    // Name and trailing count both live on the header row.
    expect(header.textContent).toBe('p1a(id)3')
    // Connected uses the solid `done` dot (a span).
    const dot = header.querySelector('[data-state]') as HTMLElement
    expect(dot.tagName).toBe('SPAN')
    expect(dot.getAttribute('data-state')).toBe('done')
    expect(container.querySelectorAll('[data-instance-state="connected"]')).toHaveLength(1)
  })

  it('maps connecting to the spinner and unreachable to the error dot', async () => {
    const connecting = render(
      <InstanceGroups
        fetchTree={async () => [group('p1b', 0, '/ws-p1b', 'connecting')]}
        retry={retry()}
        t={t}
      />,
    )
    await settle()
    const connectingHeader = connecting.getByRole('button', { name: 'p1b(id), Connecting, 0 sessions' })
    expect(connectingHeader.getAttribute('data-instance-state')).toBe('connecting')
    const spinner = connectingHeader.querySelector('[data-state]') as SVGElement
    expect(spinner.tagName.toLowerCase()).toBe('svg')
    expect(spinner.getAttribute('data-state')).toBe('ongoing')
    const spinnerClass = spinner.getAttribute('class')
    cleanup()

    const unreachable = render(
      <InstanceGroups
        fetchTree={async () => [group('p1b', 0, '/ws-p1b', 'unreachable')]}
        retry={retry()}
        t={t}
      />,
    )
    await settle()
    const unreachableHeader = unreachable.getByRole('button', {
      name: 'p1b(id), Unreachable',
    })
    expect(unreachableHeader.getAttribute('data-instance-state')).toBe('unreachable')
    const errorDot = unreachableHeader.querySelector('[data-state]') as HTMLElement
    expect(errorDot.tagName).toBe('SPAN')
    expect(errorDot.getAttribute('data-state')).toBe('error')
    // The icon class really changes: the spinner class is not the solid-dot class.
    expect(errorDot.getAttribute('class')).not.toBe(spinnerClass)
  })

  it('takes the state from the tree frame only, even for a group with rows', async () => {
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group('p1c', 2, '/ws-p1c', 'connecting')]}
        retry={retry()}
        t={t}
      />,
    )
    await settle()
    expect(container.querySelector('[data-instance-state="connecting"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: /p1c\(id\), Connecting, 2 sessions/ })).toBeTruthy()
    // The count cell shows a dash while the state is not "connected"; the rows
    // themselves are whatever the frame carried.
    expect(container.querySelector('[data-instance-id="p1c"]')?.textContent).toBe('p1c(id)—')
    expect(rows(container)).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// P2 — a fold survives the 6s poll
// ---------------------------------------------------------------------------
describe('P2 fold is not reset by polling', () => {
  it('keeps aria-expanded=false and renders no child rows after the second frame', async () => {
    vi.useFakeTimers()
    const fetchTree = vi.fn(async () => [group('p2', 2)])
    const { container } = render(
      <InstanceGroups fetchTree={fetchTree} retry={retry()} t={t} intervalMs={6000} />,
    )
    await settle()
    expect(rows(container)).toBe(2)

    const header = screen.getByRole('button', { name: /p2\(id\)/ })
    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(rows(container)).toBe(0)

    await tick(6000)
    expect(fetchTree).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[data-dsh-instance-groups]')).not.toBeNull()
    expect(screen.getByRole('button', { name: /p2\(id\)/ }).getAttribute('aria-expanded')).toBe('false')
    expect(rows(container)).toBe(0)

    // Expanding again proves the store (not the frame) owns the flag.
    fireEvent.click(screen.getByRole('button', { name: /p2\(id\)/ }))
    expect(rows(container)).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// P3 — 20 sessions: 8 → 16 → 20 → collapse → 8
// ---------------------------------------------------------------------------
describe('P3 session paging', () => {
  it('walks 8 / 16 / 20 and folds back to 8', async () => {
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group('p3', 20, '/p3')]}
        retry={retry()}
        t={t}
      />,
    )
    await settle()
    expect(rows(container)).toBe(8)
    expect(screen.getByRole('button', { name: 'Show 12 more sessions' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Show 12 more sessions' }))
    expect(rows(container)).toBe(16)

    fireEvent.click(screen.getByRole('button', { name: 'Show 4 more sessions' }))
    expect(rows(container)).toBe(20)

    const less = screen.getByRole('button', { name: 'Show less' })
    fireEvent.click(less)
    expect(rows(container)).toBe(8)
    expect(screen.getByRole('button', { name: 'Show 12 more sessions' })).toBeTruthy()
  })

  it('renders the zh labels the acceptance wording uses', async () => {
    const zhT = makeTranslate({ ...commonZh, ...zh })
    const { container } = render(
      <InstanceGroups
        fetchTree={async () => [group('p3zh', 20, '/p3zh')]}
        retry={retry()}
        t={zhT}
      />,
    )
    await settle()
    expect(rows(container)).toBe(8)
    const more = screen.getByRole('button', { name: '展开其余 12 个会话' })
    fireEvent.click(more)
    expect(rows(container)).toBe(16)
    fireEvent.click(screen.getByRole('button', { name: '展开其余 4 个会话' }))
    expect(rows(container)).toBe(20)
    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(rows(container)).toBe(8)
  })
})

// ---------------------------------------------------------------------------
// P4 — failed reads keep the previous frame
// ---------------------------------------------------------------------------
describe('P4 failed reads keep the last good frame', () => {
  it('keeps the tree when fetchTree rejects on a later poll', async () => {
    vi.useFakeTimers()
    let fail = false
    const fetchTree = vi.fn(async () => {
      if (fail) throw new Error('tree down')
      return [group('p4a', 3, '/p4a')]
    })
    const { container } = render(
      <InstanceGroups fetchTree={fetchTree} retry={retry()} t={t} intervalMs={6000} />,
    )
    await settle()
    expect(rows(container)).toBe(3)

    fail = true
    await tick(6000)
    expect(fetchTree).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[data-dsh-instance-groups]')).not.toBeNull()
    expect(screen.getByText('/p4a')).toBeTruthy()
    expect(rows(container)).toBe(3)
  })

  it('keeps the last state while a frame fails, then adopts the one it is given', async () => {
    vi.useFakeTimers()
    let fail = false
    let down = false
    const fetchTree = vi.fn(async () => {
      if (fail) throw new Error('tree down')
      return [down
        ? group('p4b', 0, '/ws-p4b', 'unreachable', 'gone')
        : group('p4b', 1)]
    })
    const { container } = render(
      <InstanceGroups fetchTree={fetchTree} retry={retry()} t={t} intervalMs={6000} />,
    )
    await settle()
    expect(container.querySelector('[data-instance-state="connected"]')).not.toBeNull()

    fail = true
    await tick(6000)
    expect(fetchTree).toHaveBeenCalledTimes(2)
    const header = container.querySelector('[data-instance-id="p4b"]') as HTMLElement
    expect(header.getAttribute('data-instance-state')).toBe('connected')
    expect(header.textContent).toContain('1')
    expect(rows(container)).toBe(1)

    // The next successful frame is authoritative: offline replaces the rows.
    fail = false
    down = true
    await tick(6000)
    expect(fetchTree).toHaveBeenCalledTimes(3)
    const offline = container.querySelector('[data-instance-id="p4b"]') as HTMLElement
    expect(offline.getAttribute('data-instance-state')).toBe('unreachable')
    expect(offline.textContent).toContain('Offline')
    expect(container.querySelector('[data-instance-offline="p4b"]')?.textContent).toContain('gone')
    expect(rows(container)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// P5 — plain dsh: no controlPlane service
// ---------------------------------------------------------------------------
describe('P5 plain dsh (no control plane)', () => {
  /** Minimal Client bench for the real `apply` path. */
  async function bench() {
    const root = new Context()
    let ctx: Context | undefined
    const owner = root.plugin((owned: Context) => { ctx = owned })
    owners.add(owner)
    await owner.await()
    if (ctx === undefined) throw new Error('bench fixture did not activate')
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('shortcuts', { catalog: createSnapshotStore([]) } as never)
    ctx.provide('layout', { toggleSidebar: vi.fn(), selectPanel: vi.fn() } as never)
    ctx.provide('uiWorkspace', { startSession: vi.fn() } as never)
    ctx.provide('locale', new LocaleRuntime(ctx))
    const slots = ctx.get('slots') as SlotRegistry
    slots.register(
      { name: 'root', children: { sidebar: { kind: 'single', scope: 'root' }, 'sidebar.instances': { kind: 'single', scope: 'root' } } },
      SidebarFrame,
    )
    return { ctx, slots }
  }

  it('renders nothing and never resolves a remote namespace', async () => {
    const { ctx, slots } = await bench()
    expect(ctx.get('remote.controlPlane')).toBeUndefined()
    const sidebar = ctx.plugin({ inject: [...inject], apply })
    await sidebar.await()
    try {
      expect(slots.entries('sidebar.instances')).toHaveLength(1)
      const Section = slots.entries('sidebar.instances')[0]?.component as ComponentType<{
        t: typeof t
        wide: boolean
      }>
      const view = render(<Section t={t} wide />)
      await settle()
      expect(view.container.querySelector('[data-dsh-instance-groups]')).toBeNull()
      expect(view.container.innerHTML).toBe('')
      // The namespace still does not exist after the section mounted and polled.
      expect(ctx.get('remote.controlPlane')).toBeUndefined()
    } finally {
      await sidebar.dispose()
    }
  })

  it('control: the same bench renders once a namespace is provided', async () => {
    const { ctx, slots } = await bench()
    const tree = vi.fn(async () => ({ ok: true as const, value: [group('p5c', 1)] }))
    const reconnect = vi.fn(async () => ({ ok: true as const, value: { state: 'connected' } }))
    ctx.provide('remote.controlPlane', { tree, reconnect } as never)
    const sidebar = ctx.plugin({ inject: [...inject], apply })
    await sidebar.await()
    try {
      const Section = slots.entries('sidebar.instances')[0]?.component as ComponentType<{
        t: typeof t
        wide: boolean
      }>
      const view = render(<Section t={t} wide />)
      await settle()
      expect(tree).toHaveBeenCalledOnce()
      expect(view.container.querySelector('[data-dsh-instance-groups]')).not.toBeNull()
      expect(view.queryByRole('button', { name: /p5c\(id\), Connected, 1 sessions/ as never })).toBeTruthy()
    } finally {
      await sidebar.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// P6 — rail: wide=false mounts nothing and starts no poll
// ---------------------------------------------------------------------------
describe('P6 rail (wide=false)', () => {
  it('does not render the tree and never calls the readers', async () => {
    vi.useFakeTimers()
    const fetchTree = vi.fn(async () => [group('p6', 2)])
    const onRetry = vi.fn(retry())
    const Slot = instanceGroupsSlot({ fetchTree, retry: onRetry })
    const { container } = render(<Slot t={t} wide={false} />)
    await settle()
    expect(container.querySelector('[data-dsh-instance-groups]')).toBeNull()
    expect(container.innerHTML).toBe('')
    expect(fetchTree).not.toHaveBeenCalled()
    expect(onRetry).not.toHaveBeenCalled()

    await tick(6000)
    expect(fetchTree).not.toHaveBeenCalled()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('the shell hands the seat its column state (static wiring guard)', () => {
    const shell = readFileSync(
      resolve(process.cwd(), 'packages/client/ui-sidebar/src/client/SidebarRoot.tsx'), 'utf8',
    )
    expect(shell).toContain("renderSlot('sidebar.instances', { wide })")
  })

  it('mounts and polls when wide=true (control case)', async () => {
    vi.useFakeTimers()
    const fetchTree = vi.fn(async () => [group('p6b', 1)])
    const Slot = instanceGroupsSlot({ fetchTree, retry: retry() })
    const { container } = render(<Slot t={t} wide />)
    await settle()
    expect(container.querySelector('[data-dsh-instance-groups]')).not.toBeNull()
    expect(fetchTree).toHaveBeenCalledTimes(1)
    await tick(30000)
    expect(fetchTree).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// Supporting: the eight dictionaries carry the new keys
// ---------------------------------------------------------------------------
describe('locale coverage for the new keys', () => {
  const dictionaries: Readonly<Record<string, Record<string, string>>> = {
    zh, en, ja, es, fr, de, ru, pt,
  }
  const keys = [
    'instances.group', 'instances.state.connected', 'instances.state.connecting',
    'instances.state.unreachable', 'instances.expand', 'instances.collapse',
    'instances.groupOffline', 'instances.offline', 'instances.empty',
    'instances.retry', 'instances.retrying',
    'time.now', 'time.minutes', 'time.hours', 'time.days', 'time.months', 'time.years',
  ]

  it('defines every new key in all eight languages with the right placeholders', () => {
    expect(Object.keys(dictionaries)).toHaveLength(8)
    for (const [language, dictionary] of Object.entries(dictionaries)) {
      for (const key of keys) {
        expect(dictionary[key], `${language} is missing ${key}`).toBeTruthy()
      }
      expect(dictionary['instances.group'], language).toContain('{name}')
      expect(dictionary['instances.group'], language).toContain('{state}')
      expect(dictionary['instances.group'], language).toContain('{n}')
      expect(dictionary['instances.expand'], language).toContain('{n}')
      // The offline header label has no count: an offline instance has none to report.
      expect(dictionary['instances.groupOffline'], language).toContain('{name}')
      expect(dictionary['instances.groupOffline'], language).toContain('{state}')
      expect(dictionary['instances.groupOffline'], language).not.toContain('{n}')
    }
  })
})

// ---------------------------------------------------------------------------
// P7 — static style / token contract
// ---------------------------------------------------------------------------
describe('P7 style and token contract', () => {
  // jsdom's import.meta.url is an http URL, so anchor on the repo root instead.
  const repo = process.cwd()
  const cssSource = readFileSync(
    resolve(repo, 'packages/client/ui-control-plane/src/client/InstanceGroups.module.css'), 'utf8',
  )
  const themeSource = readFileSync(
    resolve(repo, 'packages/client/ui-theme/src/styles/design-platform.css'), 'utf8',
  )
  const sidebarSource = readFileSync(
    resolve(repo, 'packages/client/ui-sidebar/src/client/SidebarRoot.module.css'), 'utf8',
  )

  /** Collect the theme file's light (`body`) and dark (`body[data-ds-dark-theme]`) blocks. */
  function themeBlocks(): { light: string[]; dark: string[] } {
    const all = (pattern: RegExp): string[] => [...themeSource.matchAll(pattern)].map(m => m[1] as string)
    return {
      light: all(/(?:^|\n)body \{([\s\S]*?)\n\}/g),
      dark: all(/body\[data-ds-dark-theme\] \{([\s\S]*?)\n\}/g),
    }
  }

  const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/

  it('has no color literals and no 11px/12px font-size in the source CSS', () => {
    // Strip comments: prose is allowed to mention sizes/colors, declarations are not.
    const declarations = cssSource.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(declarations.match(COLOR_LITERAL)).toBeNull()
    expect(declarations).not.toMatch(/font-size:\s*1[12]px/)
  })

  it('every --dsw-alias-* token it uses exists in both theme blocks', () => {
    const declarations = cssSource.replace(/\/\*[\s\S]*?\*\//g, '')
    const tokens = [...new Set(
      [...declarations.matchAll(/var\(\s*(--dsw-alias-[a-z0-9-]+)\s*[,)]/g)].map(m => m[1] as string),
    )]
    expect(tokens.length).toBeGreaterThan(0)
    const { light, dark } = themeBlocks()
    expect(light.join('\n')).toContain('--dsw-alias-label-primary:')
    expect(dark.join('\n')).toContain('--dsw-alias-label-primary:')
    for (const token of tokens) {
      expect(
        light.some(block => block.includes(`${token}:`)),
        `${token} missing from the light block`,
      ).toBe(true)
      expect(
        dark.some(block => block.includes(`${token}:`)),
        `${token} missing from the dark block`,
      ).toBe(true)
    }
  })

  it('--dsh-sidebar-* geometry tokens come from the sidebar shell (not design-platform)', () => {
    // Acceptance said "design-platform.css 的亮色与暗色定义块" for both token
    // families; the --dsh-sidebar-* family is shell geometry and lives in the
    // sidebar root. Assert the real contract instead of a nonexistent one.
    const declarations = cssSource.replace(/\/\*[\s\S]*?\*\//g, '')
    const tokens = [...new Set(
      [...declarations.matchAll(/var\(\s*(--dsh-sidebar-[a-z0-9-]+)\s*[,)]/g)].map(m => m[1] as string),
    )]
    expect(tokens.length).toBeGreaterThan(0)
    for (const token of tokens) {
      expect(sidebarSource, `${token} is not defined by SidebarRoot.module.css`).toContain(`${token}:`)
    }
    // Evidence for the report: the theme file defines no `--dsh-sidebar-*` token
    // at all, so the acceptance wording ("both theme blocks") cannot hold for
    // this family; the shell owns it.
    expect(themeSource).not.toMatch(/--dsh-sidebar-/)
  })

  it('the shipped bundle carries the same literal-free instance-groups CSS', () => {
    const bundle = readFileSync(resolve(repo, 'packages/client/ui-sidebar/lib/client.js'), 'utf8')
    const chunks = [...bundle.matchAll(/const css\w* = "((?:[^"\\]|\\.)*)"/g)]
      .map(m => (m[1] as string).replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
    const chunk = chunks.find(text => text.includes('groupHeader') && text.includes('dsh-workspace-indent'))
    expect(chunk, 'instance-groups CSS chunk not found in lib/client.js (stale bundle?)').toBeTruthy()
    expect(chunk?.match(COLOR_LITERAL) ?? null).toBeNull()
    expect(chunk).not.toMatch(/font-size:\s*1[12]px/)
    expect(chunk).toContain('--dsw-alias-label-primary')
    expect(chunk).toContain('--dsh-sidebar-row-padding')
  })
})
