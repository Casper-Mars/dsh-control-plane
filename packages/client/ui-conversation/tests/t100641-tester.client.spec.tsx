// @vitest-environment jsdom
/**
 * t100641 tester — the control-plane home against the untouched dsh home.
 *
 * Independent read of the contract:
 *  - a control plane with no Session offers no dead controls: one centered
 *    notice, no composer chain, no hero seats, no model seat, no workspace
 *    chip/title, no width handles (proved twice: explicit render spies on the
 *    `conversation.content` props, and the fully assembled real tree);
 *  - selecting a Session — including the federated `alpha:s-1` key — returns
 *    the ordinary body, model seat, and send path;
 *  - a plain dsh Client renders exactly the hero/composer it always did;
 *  - the notice copy exists in all eight dictionaries, and its stylesheet is
 *    token-only with tokens both theme sheets define.
 *
 * The production sources are not modified by this suite.
 */
import './control-row-dom.ts'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import {
  SlotTestRuntime, stubConfigForm, usePinnedBrowserLanguages,
} from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyMenus, inject as injectMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ISession, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { apply, inject, type EmptyWorkspaceOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ConversationContent } from '../src/client/skeleton/ConversationContent.tsx'
import { ControlPlaneEmpty } from '../src/client/skeleton/ControlPlaneEmpty.tsx'
import type { ConversationContentProps } from '../src/client/contract/slots.ts'
import { InputHub } from '../src/client/input/hub.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'

usePinnedBrowserLanguages('zh-CN')

// jsdom implements no Range geometry (Lexical measures the caret once the
// surface is genuinely contenteditable).
Range.prototype.getBoundingClientRect = () => ({
  top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
})

/** A federated key: the remote instance prefix is part of the Session id. */
const FEDERATED = 'alpha:s-1' as SessionId
/** A workspace the control plane must never surface on its home. */
const WORKSPACE_TITLE = 'Proj Title'
const WORKSPACE_PATH = '/Users/secret/workspace-path'

const dictionaryOf = (dictionary: object): Record<string, string> => dictionary as Record<string, string>
const translate = (dictionary: object) => {
  const values = dictionaryOf(dictionary)
  return (key: string) => values[key] ?? key
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/* ------------------------------------------------------------------ *
 * Part 1 — the `conversation.content` props as a render record.
 * ------------------------------------------------------------------ */

/** jsdom has no ResizeObserver; the composer seat publishes its height through one. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

interface ContentOptions {
  controlPlane?: boolean
  sessionId?: SessionId
}

/**
 * Render `ConversationContent` with throwaway hooks and recording seats.
 * @param options - the two inputs under test plus the optional Session.
 * @returns the rendered view and every render-record key.
 */
function mountContent(options: ContentOptions = {}) {
  const slotKeys: string[] = []
  const chainKeys: string[] = []
  const factoryKeys: string[] = []
  const renderSlot = vi.fn((key: string, _owner: object, options?: { children?: unknown }) => {
    slotKeys.push(key)
    // The frame is the only seat whose children carry the body; the rest are
    // business-owned holes and render nothing in this harness.
    return key === 'conversation.hero.frame' ? (options?.children ?? null) : null
  })
  const renderSlotChain = vi.fn((key: string, _owner: object, chosen: { fallback?: unknown }) => {
    chainKeys.push(key)
    return (chosen.fallback ?? null) as never
  })
  // The real factory injects the local occurrence props; this harness only
  // records which local Component the surface asked for, so it answers with an
  // inert stand-in instead of the production default.
  const useFactorySlot = vi.fn((name: string, _fallback: unknown) => {
    factoryKeys.push(name)
    return () => null
  })
  const selectWorkspace = vi.fn(async (_id: WorkspaceId) => {})
  const sessionSnapshot = {
    sessionId: options.sessionId,
    openState: 'open',
    openError: null,
    running: false,
    blank: false,
    awaitingFirstTurn: false,
    promptAttempted: false,
  } as unknown as SessionSnapshot
  const props = {
    variant: 'main',
    phase: options.sessionId === undefined ? 'hero' : 'active',
    hero: options.sessionId === undefined,
    controlPlane: options.controlPlane === true,
    sessionId: options.sessionId,
    selectWorkspace,
    hooks: { composerBlock: { getSnapshot: () => undefined, subscribe: () => () => {} } },
    t: translate(zh),
    useSession: (selector: (value: unknown) => unknown) => selector(options.sessionId === undefined ? undefined : sessionSnapshot),
    useSessions: (selector: (value: unknown) => unknown) => selector({
      ids: options.sessionId === undefined ? [] : [options.sessionId],
      byId: {
        [options.sessionId ?? 'none']: {
          id: options.sessionId ?? 'none', displayTitle: 'S', running: false,
          retainedBy: { mainView: 1 }, blank: false, updatedAt: 0, cwd: WORKSPACE_PATH,
        },
      },
      phase: 'ready',
      projectionsBySession: {},
    }),
    useSessionStatus: (selector: (value: unknown) => unknown) => selector(new Map()),
    // A workspace with a title and a path: if the home rendered any workspace
    // chrome, this is the text it would leak.
    useWorkspaces: (selector: (value: unknown) => unknown) => selector({
      phase: 'ready',
      items: [{
        workspaceId: 'w-one', title: WORKSPACE_TITLE, path: WORKSPACE_PATH, sessionIds: [FEDERATED],
      }],
    }),
    useInput: (selector: (value: unknown) => unknown) => selector(
      options.sessionId === undefined ? undefined : { draft: { text: '', references: [] } },
    ),
    useComposerBlock: (selector: (value: unknown) => unknown) => selector(undefined),
    renderSlot,
    renderSlotChain,
    renderFactorySlot: vi.fn(),
    useFactorySlot,
  } as unknown as ConversationContentProps
  const view = render(<ConversationContent {...props} />)
  return { view, slotKeys, chainKeys, factoryKeys, selectWorkspace }
}

describe('conversation.content on a control plane with no Session', () => {
  beforeEach(() => { vi.stubGlobal('ResizeObserver', ResizeObserverStub) })

  it('renders only the notice: no composer chain, no hero seats, no width controls', () => {
    const b = mountContent({ controlPlane: true })
    const notice = b.view.container.querySelector('[data-conversation-control-plane-empty]')
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain(dictionaryOf(zh)['empty.controlPlane.title'])
    expect(notice!.textContent).toContain(dictionaryOf(zh)['empty.controlPlane.description'])

    // Nothing the notice could be operated through.
    expect(b.view.container.querySelector('textarea')).toBeNull()
    expect(b.view.container.querySelector('[contenteditable]')).toBeNull()
    expect(b.view.container.querySelector('[role="combobox"]')).toBeNull()
    expect(b.view.container.querySelector('input, button, [aria-haspopup]')).toBeNull()

    // The early return happens *above* every seat: the record is empty.
    expect(b.slotKeys).toEqual([])
    expect(b.chainKeys).toEqual([])
    expect(b.factoryKeys).toEqual([])
    expect(b.slotKeys).not.toContain('conversation.composer.bar')
    expect(b.slotKeys).not.toContain('conversation.composer')
    expect(b.slotKeys.filter(key => key.startsWith('conversation.hero.'))).toEqual([])
    expect(b.chainKeys).not.toContain('conversation.composer')
    // The caller-selected width controls are not instantiated either.
    expect(b.factoryKeys).not.toContain('widthControls')
    expect(b.view.container.querySelector('[data-width-handle]')).toBeNull()
  })

  it('leaks no workspace title or path and no width controls into the DOM', () => {
    const b = mountContent({ controlPlane: true })
    expect(b.view.container.textContent).not.toContain(WORKSPACE_TITLE)
    expect(b.view.container.textContent).not.toContain(WORKSPACE_PATH)
    expect(b.view.container.textContent).not.toContain('workspace-path')
    // No chip label, no path-derived folder label.
    expect(b.view.container.querySelector('[data-width-handle]')).toBeNull()
    expect(b.view.container.querySelectorAll('button')).toHaveLength(0)
  })
})

describe('conversation.content keeps the ordinary body once a Session is selected', () => {
  beforeEach(() => { vi.stubGlobal('ResizeObserver', ResizeObserverStub) })

  it('resolves the federated key to the full surface, not the notice', () => {
    const b = mountContent({ controlPlane: true, sessionId: FEDERATED })
    expect(b.view.container.querySelector('[data-conversation-control-plane-empty]')).toBeNull()
    expect(b.view.container.querySelector('[data-conversation-content]')).not.toBeNull()
    expect(b.chainKeys).toContain('conversation.composer')
    expect(b.slotKeys).toContain('conversation.composer.bar')
    const barCall = b.slotKeys.indexOf('conversation.composer.bar')
    expect(b.slotKeys[barCall]).toBe('conversation.composer.bar')
    // The factory still selects its caller-owned local Components.
    expect([...new Set(b.factoryKeys)]).toEqual(['views', 'widthControls'])
    // Nothing was opened or created as a side effect.
    expect(b.selectWorkspace).not.toHaveBeenCalled()
  })
})

describe('a plain dsh Client is unchanged', () => {
  beforeEach(() => { vi.stubGlobal('ResizeObserver', ResizeObserverStub) })

  it('renders the hero seeds, workspace chip seat, and composer bar with no Session', () => {
    const b = mountContent({ controlPlane: false })
    expect(b.view.container.querySelector('[data-conversation-control-plane-empty]')).toBeNull()
    expect(b.view.container.textContent).toContain(dictionaryOf(zh)['hero.headline'])
    expect(b.slotKeys).toContain('conversation.hero.frame')
    expect(b.slotKeys).toContain('conversation.hero.brand.mark')
    expect(b.slotKeys).toContain('conversation.hero.workspace')
    expect(b.slotKeys).toContain('conversation.composer.bar')
    expect(b.chainKeys.filter(key => key === 'conversation.composer').length).toBeGreaterThan(0)
    expect([...new Set(b.factoryKeys)]).toEqual(['views', 'widthControls'])
  })

  it('renders the active body for a selected Session', () => {
    const b = mountContent({ controlPlane: false, sessionId: FEDERATED })
    expect(b.view.container.querySelector('[data-conversation-control-plane-empty]')).toBeNull()
    expect(b.view.container.querySelector('[data-conversation-content]')).not.toBeNull()
    expect(b.slotKeys).toContain('conversation.composer.bar')
    // The hero brand mark belongs to the home only.
    expect(b.slotKeys).not.toContain('conversation.hero.brand.mark')
    expect(b.chainKeys.filter(key => key === 'conversation.composer').length).toBeGreaterThan(0)
  })
})

/* ------------------------------------------------------------------ *
 * Part 2 — the assembled tree (real slots, real composer, real send).
 * ------------------------------------------------------------------ */

type AppRootProps = PropsRenderSlots<'main'>
function AppRoot({ renderSlot }: AppRootProps) {
  return <>{renderSlot('main', {}, { entryKey: 'conversation' })}</>
}

const LAYOUT_CHILDREN = { 'main': { kind: 'keyed', scope: 'root' } } as const

function ModelSeatProbe() {
  return <span data-testid="model-seat">model-seat</span>
}

function WorkspaceSeatProbe({ open }: EmptyWorkspaceOwnerProps) {
  const [count, setCount] = useState(0)
  return (
    <button data-testid="workspace-seat" onClick={() => { setCount(value => value + 1) }}>
      {String(open)}:{count}
    </button>
  )
}

function provideWorkspaceNavigation(runtime: SlotTestRuntime): (id: SessionId) => void {
  let mainReference: ReturnType<typeof runtime.sessions.retain> | undefined
  const openSession = (id: SessionId): void => {
    const next = runtime.sessions.retain(id, { source: 'mainView' })
    mainReference?.release()
    mainReference = next
  }
  runtime.ctx.provide('uiWorkspace', {
    openWorkspace: vi.fn(async (_workspaceId: WorkspaceId, beforeOpen: (id: SessionId) => void) => {
      beforeOpen(FEDERATED)
      openSession(FEDERATED)
    }),
    openSession,
  } as never)
  return openSession
}

interface BenchOptions {
  controlPlane?: boolean
  sessionId?: SessionId
  select?: boolean
}

/**
 * Assemble the real Conversation plugin over the real SlotRegistry.
 * @param options - control-plane posture and an optional pre-seeded Session.
 * @returns the runtime, rendered root, prompt spy, and dynamic Session helpers.
 */
async function bench(options: BenchOptions = {}) {
  const runtime = await SlotTestRuntime.create()
  const openSession = provideWorkspaceNavigation(runtime)
  runtime.ctx.provide('configForms', {
    developerTools: { enabled: createSnapshotStore(true) },
    get: () => stubConfigForm().scope,
  } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.ctx.provide('shortcuts', { catalog: createSnapshotStore([]) })
  // A control plane mounts the Remote namespace as its own service; apply reads
  // it through `ctx.get`, so it must be provided before mounting the plugin.
  if (options.controlPlane === true) runtime.ctx.provide('remote.controlPlane', {})
  await runtime.mount({ inject: [...injectMenus], apply: applyMenus })
  await runtime.workspaces.update((draft) => {
    draft.items = [{
      workspaceId: 'w-one', title: WORKSPACE_TITLE, path: WORKSPACE_PATH, sessionIds: [FEDERATED],
    }] as never
  })
  const seed = async (id: SessionId) => {
    const prompt = vi.fn<ISession['prompt']>(async () => ({ ok: true, value: { accepted: true } }))
    await runtime.sessions.add({
      id,
      summary: { title: 'Remote S', displayTitle: 'Remote S', cwd: '/remote/proj' },
      session: { prompt, loadOlder: vi.fn<ISession['loadOlder']>() },
    })
    return prompt
  }
  const prompt = options.sessionId === undefined ? undefined : await seed(options.sessionId)
  if (options.sessionId !== undefined && options.select === true) openSession(options.sessionId)
  await runtime.root.declare(LAYOUT_CHILDREN, AppRoot)
  await runtime.mount({ inject: [...inject], apply })
  runtime.slots.register({ name: 'conversation.input.model' }, ModelSeatProbe)
  runtime.slots.register({ name: 'conversation.hero.workspace' }, WorkspaceSeatProbe)
  const view = runtime.renderRoot()
  return {
    runtime,
    view,
    prompt,
    openSession,
    seed,
  }
}

describe('the assembled control-plane home', () => {
  it('mounts the notice alone — no composer seat, hero seat, model seat, or width handle', async () => {
    const b = await bench({ controlPlane: true })
    const notice = b.view.container.querySelector('[data-conversation-control-plane-empty]')
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain(dictionaryOf(zh)['empty.controlPlane.title'])
    expect(notice!.textContent).toContain(dictionaryOf(zh)['empty.controlPlane.description'])

    // The entire composer/transcript subtree is absent, not merely disabled.
    expect(b.view.container.querySelector('[data-composer-seat]')).toBeNull()
    expect(b.view.container.querySelector('[data-composer-input]')).toBeNull()
    expect(b.view.container.querySelector('[data-conversation-scroll]')).toBeNull()
    expect(b.view.container.querySelector('textarea')).toBeNull()
    expect(b.view.container.querySelector('[contenteditable]')).toBeNull()
    expect(b.view.container.querySelector('[role="combobox"]')).toBeNull()
    expect(b.view.container.querySelector('[data-width-handle]')).toBeNull()
    // Seats a caller could fill never mount, because their parents never render.
    expect(b.view.queryByTestId('model-seat')).toBeNull()
    expect(b.view.queryByTestId('workspace-seat')).toBeNull()
    // One notice, no operable node inside it.
    expect(notice!.querySelectorAll('button, input, textarea, [contenteditable], [role="combobox"]')).toHaveLength(0)
    await b.runtime.dispose()
  })

  it('shows no workspace title or path anywhere in the home', async () => {
    const b = await bench({ controlPlane: true })
    expect(b.view.container.textContent).not.toContain(WORKSPACE_TITLE)
    expect(b.view.container.textContent).not.toContain(WORKSPACE_PATH)
    await b.runtime.dispose()
  })

  it('keeps the composer, model seat, and send path for a federated selected Session', async () => {
    const b = await bench({ controlPlane: true, sessionId: FEDERATED, select: true })
    expect(b.view.container.querySelector('[data-conversation-control-plane-empty]')).toBeNull()
    const composer = b.view.container.querySelector<HTMLDivElement>('[data-composer-input]')
    expect(composer).not.toBeNull()
    expect(composer!.getAttribute('contenteditable')).toBe('true')
    expect(b.view.getByTestId('model-seat')).toBeTruthy()
    expect(b.view.container.querySelector('[data-conversation-content]')?.getAttribute('data-conversation-session'))
      .toBe(FEDERATED)

    // Sending still routes through the Session sink (no real network in play).
    const conversation = b.runtime.ctx.get('conversation') as { input: unknown }
    const shell = (conversation.input as InputHub).shell(FEDERATED)
    act(() => { shell.setDraft('t100641 send check') })
    fireEvent.keyDown(composer!, { key: 'Enter' })
    await waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })
    expect(JSON.stringify(b.prompt!.mock.calls[0])).toContain('t100641 send check')
    await b.runtime.dispose()
  })

  it('replaces the notice when the first local Session is selected', async () => {
    const b = await bench({ controlPlane: true })
    expect(b.view.container.querySelector('[data-conversation-control-plane-empty]')).not.toBeNull()
    const prompt = await b.seed(FEDERATED)
    b.openSession(FEDERATED)
    await b.runtime.flush()
    expect(b.view.container.querySelector('[data-conversation-control-plane-empty]')).toBeNull()
    const composer = b.view.container.querySelector<HTMLDivElement>('[data-composer-input]')
    expect(composer).not.toBeNull()
    expect(composer!.getAttribute('contenteditable')).toBe('true')
    expect(b.view.getByTestId('model-seat')).toBeTruthy()
    const conversation = b.runtime.ctx.get('conversation') as { input: unknown }
    act(() => { (conversation.input as InputHub).shell(FEDERATED).setDraft('after selection') })
    fireEvent.keyDown(composer!, { key: 'Enter' })
    await waitFor(() => { expect(prompt).toHaveBeenCalledOnce() })
    await b.runtime.dispose()
  })
})

describe('the assembled plain dsh home', () => {
  it('keeps the hero, workspace chip, and inert composer with no Session', async () => {
    const b = await bench()
    void 0
    expect(b.view.container.querySelector('[data-conversation-control-plane-empty]')).toBeNull()
    expect(b.view.container.textContent).toContain(dictionaryOf(zh)['hero.headline'])
    const composer = b.view.container.querySelector<HTMLDivElement>('[data-composer-input]')
    expect(composer).not.toBeNull()
    // Nothing can be typed into or sent from the cold hero.
    expect(composer!.getAttribute('contenteditable')).not.toBe('true')
    expect(b.view.queryByTestId('model-seat')).toBeNull()
    // The workspace chip is the ordinary placeholder before a Session exists.
    expect(b.view.getByRole('button', { name: '选择工作区' })).toBeTruthy()
    expect(b.view.getByTestId('workspace-seat')).toBeTruthy()
    await b.runtime.dispose()
  })

  it('keeps the ordinary body, model seat, and send path with a Session', async () => {
    const b = await bench({ sessionId: FEDERATED, select: true })
    expect(b.view.container.querySelector('[data-conversation-control-plane-empty]')).toBeNull()
    const composer = b.view.container.querySelector<HTMLDivElement>('[data-composer-input]')!
    expect(composer.getAttribute('contenteditable')).toBe('true')
    expect(b.view.getByTestId('model-seat')).toBeTruthy()
    const conversation = b.runtime.ctx.get('conversation') as { input: unknown }
    act(() => { (conversation.input as InputHub).shell(FEDERATED).setDraft('plain dsh send') })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })
    await b.runtime.dispose()
  })
})

/* ------------------------------------------------------------------ *
 * Part 3 — locale completeness and stylesheet hygiene.
 * ------------------------------------------------------------------ */

describe('the control-plane notice copy', () => {
  it('is present and non-empty in all eight dictionaries', () => {
    const dictionaries = { zh, en, ja, es, fr, de, ru, pt }
    for (const [language, dictionary] of Object.entries(dictionaries)) {
      const values = dictionaryOf(dictionary)
      for (const key of ['empty.controlPlane.title', 'empty.controlPlane.description']) {
        const value = values[key] ?? ''
        expect(typeof value, `${language} ${key}`).toBe('string')
        expect(value.trim().length, `${language} ${key}`).toBeGreaterThan(0)
      }
      // The two lines must be distinct copy, not a copy-paste duplicate.
      expect(values['empty.controlPlane.title']).not.toBe(values['empty.controlPlane.description'])
    }
  })

  it('renders the runtime dictionary in ja, de, and pt', () => {
    for (const dictionary of [ja, de, pt]) {
      const view = render(<ControlPlaneEmpty t={translate(dictionary)} />)
      const values = dictionaryOf(dictionary)
      expect(view.container.textContent).toContain(values['empty.controlPlane.title'])
      expect(view.container.textContent).toContain(values['empty.controlPlane.description'])
      cleanup()
    }
  })
})

const cssPath = resolve(import.meta.dirname, '../src/client/skeleton/ControlPlaneEmpty.module.css')
const themePath = resolve(import.meta.dirname, '../../ui-theme/src/styles/design-platform.css')

interface CssBlock {
  selector: string
  body: string
}

/** Split a stylesheet into flat `selector { body }` blocks. */
function cssBlocks(source: string): CssBlock[] {
  const blocks: CssBlock[] = []
  let index = 0
  while (index < source.length) {
    const open = source.indexOf('{', index)
    if (open < 0) break
    let depth = 1
    let cursor = open + 1
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === '{') depth++
      else if (source[cursor] === '}') depth--
      cursor++
    }
    blocks.push({ selector: source.slice(index, open).trim(), body: source.slice(open + 1, cursor - 1) })
    index = cursor
  }
  return blocks
}

describe('the control-plane notice stylesheet', () => {
  const source = readFileSync(cssPath, 'utf8')

  it('contains no color literals', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(source).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch|lab|lch)\(/)
    expect(source).not.toMatch(/:\s*(?:white|black|red|green|blue|gray|grey|orange|yellow)\b/)
  })

  it('uses no 11px or 12px font size', () => {
    expect(source).not.toMatch(/font-size:\s*1[12]px/)
  })

  it('references only tokens the light and dark theme sheets both define', () => {
    const tokens = [...new Set([...source.matchAll(/var\((--dsw-[a-z0-9-]+)\)/g)].map(match => match[1]!))]
    expect(tokens.length).toBeGreaterThan(0)
    const themed = cssBlocks(readFileSync(themePath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))
    const light = themed.filter(block => /(^|[\s,])body\s*$/.test(block.selector) && !block.selector.includes('data-ds-dark-theme'))
    const dark = themed.filter(block => block.selector.includes('data-ds-dark-theme'))
    expect(light.length).toBeGreaterThan(0)
    expect(dark.length).toBeGreaterThan(0)
    for (const token of tokens) {
      const declaration = `${token}:`
      expect(light.some(block => block.body.includes(declaration)), `${token} in light`).toBe(true)
      expect(dark.some(block => block.body.includes(declaration)), `${token} in dark`).toBe(true)
    }
  })
})
