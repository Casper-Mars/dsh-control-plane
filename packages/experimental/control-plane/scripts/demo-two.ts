/**
 * Demo: compose the tree from TWO real local instances.
 *
 *   pnpm exec tsx packages/experimental/control-plane/scripts/demo-two.ts \
 *     --config /tmp/two.json
 *
 * `/tmp/two.json`:
 *   { "instances": [
 *       { "id": "a", "name": "A Agent", "host": "127.0.0.1", "port": 3094, "token": "…" },
 *       { "id": "b", "name": "B Agent", "host": "127.0.0.1", "port": 3093, "token": "…" } ] }
 *
 * `token` is only a stop-gap for today's Harness; the control plane itself
 * models no credentials.
 */
import { readFileSync } from 'node:fs'
import WebSocket from 'ws'
import { ControlPlane, resolveInstances } from '../src/index.ts'
import type { ResolvedInstance } from '../src/index.ts'

interface DemoInstance {
  id: string
  name?: string
  host: string
  port: number
  token?: string
}

const index = process.argv.indexOf('--config')
if (index < 0) throw new Error('用法: --config <json>')
const config = JSON.parse(readFileSync(process.argv[index + 1]!, 'utf8')) as { instances: DemoInstance[] }
const instances = resolveInstances({ instances: config.instances.map(({ id, name, host, port }) => ({ id, name, host, port })) })
const tokens = new Map(config.instances.map(instance => [instance.id, instance.token]))

/** Exchange a launch token for the browser-auth cookie. */
async function cookie(instance: ResolvedInstance): Promise<string | undefined> {
  const token = tokens.get(instance.id)
  if (token === undefined) return undefined
  try {
    const response = await fetch(`${instance.baseUrl}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
    const pairs = (response.headers.getSetCookie?.() ?? []).map(entry => entry.split(';', 1)[0]).filter(Boolean)
    await response.body?.cancel()
    return pairs.length > 0 ? pairs.join('; ') : undefined
  } catch {
    // 实例不可达：交给 connect 记录 unreachable
    return undefined
  }
}

const control = new ControlPlane(undefined as never, { instances: config.instances })

const cookies = new Map<string, string | undefined>()
for (const instance of instances) cookies.set(instance.id, await cookie(instance))

await control.connect((instance) => {
  const cookieHeader = cookies.get(instance.id)
  return {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers)
      if (cookieHeader !== undefined) headers.set('cookie', cookieHeader)
      return fetch(new URL(String(input), instance.baseUrl), { ...init, headers })
    },
  }
})

control.onSessionStatus((key, running) => console.log(`  状态事件: ${key} running=${running}`))
control.onSessionChange((key, kind) => console.log(`  变更事件: ${key} ${kind}`))

let tree = await control.snapshot()
console.log('首次刷新完成（已建立基线）')

const created = await control.createSession('a', '/tmp')
console.log(`在 a 上新建会话: ${created}`)

await new Promise(resolve => setTimeout(resolve, 300))
tree = await control.snapshot()
console.log('第二次刷新完成（应看到 added 事件）')
const states = control.states()
console.log(`实例: ${Object.entries(states).map(([id, value]) => `${id}=${value.state}`).join(', ')}`)
for (const node of tree) {
  const state = states[node.instanceId]
  const mark = state?.state === 'connected' ? '✓' : '✗'
  console.log(`${mark} ${node.label}  [${node.sessionCount} 会话, ${node.runningCount} 进行中]${state?.error ? `  (${state.error})` : ''}`)
  for (const workspace of node.workspaces) {
    console.log(`    ${workspace.path}`)
    for (const session of workspace.sessions) console.log(`      ${session.running ? '●' : '○'} ${session.key}`)
  }
}

await control.dispose()
