/**
 * Demo: connect to one real local instance and print its session rows.
 *
 *   pnpm exec tsx packages/experimental/control-plane/scripts/demo-upstream.ts \
 *     --base http://127.0.0.1:3094 --token <launch-token>
 *
 * The token argument exists only because the current Harness still requires
 * one; the control plane itself does not model credentials.
 */
import { resolveInstances } from '../src/config.ts'
import { Upstream } from '../src/upstream.ts'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index > -1 ? process.argv[index + 1] : undefined
}

const base = arg('base')
if (base === undefined) throw new Error('用法: --base http://host:port [--token <launch-token>]')
const url = new URL(base)
const instance = resolveInstances({
  instances: [{ id: 'local', name: 'Local', host: url.hostname, port: Number(url.port || 80) }],
})[0]!

/** Exchange the launch token for the browser-auth cookie the Host expects. */
async function cookieFor(token: string | undefined): Promise<string | undefined> {
  if (token === undefined) return undefined
  const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const setCookie = response.headers.getSetCookie?.() ?? []
  await response.body?.cancel()
  const pairs = setCookie.map(entry => entry.split(';', 1)[0]).filter(Boolean)
  return pairs.length > 0 ? pairs.join('; ') : undefined
}

const cookie = await cookieFor(arg('token'))
const upstream = await Upstream.connect(instance, {
  fetch: (input, init) => {
    const headers = new Headers(init?.headers)
    if (cookie !== undefined) headers.set('cookie', cookie)
    return fetch(new URL(String(input), instance.baseUrl), { ...init, headers })
  },
})

try {
  if (process.argv.includes('--create')) {
    const created = await upstream.createSession('/tmp')
    console.log(`新建会话 ${created}`)
  }
  const rows = await upstream.listSessions()
  console.log(`${instance.id} (${upstream.reachability}) 共 ${rows.length} 个会话`)
  for (const row of rows) {
    console.log(`  ${row.running ? '●' : '○'} ${row.sessionId}  ${row.cwd ?? '(no cwd)'}  updated=${row.updatedAt}`)
  }
} finally {
  await upstream.dispose()
}
