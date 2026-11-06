/**
 * 3.5 / 3.6 验证：连到「控制面 host」，调用它的 controlPlane 命名空间。
 *
 *   pnpm exec tsx packages/control/control-plane/scripts/demo-host.ts \
 *     --base http://127.0.0.1:3095 [--token ***]
 *
 * 与 demo-two.ts 的区别：不直连各实例，而是走控制面自己的 Remote 命名空间，
 * 也就是浏览器将来调用的同一个入口。
 */
import { resolveInstances, type ResolvedInstance } from '../src/config.ts'
import { Upstream } from '../src/upstream.ts'

/** Remote 结果信封。 */
interface Result<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: unknown
}

/** controlPlane/instances 的元素。 */
interface InstanceInfo {
  readonly label: string
  readonly state: string
  readonly error?: string
}

/** controlPlane/tree 的元素（只声明验证用到的字段）。 */
interface InstanceNode {
  readonly label: string
  readonly sessionCount: number
  readonly runningCount: number
  readonly workspaces: ReadonlyArray<{
    readonly path: string
    readonly sessions: ReadonlyArray<{ readonly key: string; readonly running: boolean }>
  }>
}

/** 控制面 Remote 面的最小形态。 */
interface ControlPlaneRemote {
  readonly instances: () => Promise<Result<readonly InstanceInfo[]>>
  readonly tree: () => Promise<Result<readonly InstanceNode[]>>
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index > -1 ? process.argv[index + 1] : undefined
}

const base = arg('base')
if (base === undefined) throw new Error('用法: --base http://host:port [--token ***')
const url = new URL(base)
const host: ResolvedInstance = resolveInstances({
  instances: [{ id: 'control', name: 'Control', host: url.hostname, port: Number(url.port || 80) }],
})[0]!

/** launch token 换成 index cookie（仅当前 Harness 需要）。 */
async function cookieFor(token: string | undefined): Promise<string | undefined> {
  if (token === undefined) return undefined
  const response = await fetch(`${host.baseUrl}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const pairs = response.headers.getSetCookie().map(entry => entry.split(';', 1)[0]).filter(Boolean)
  if (response.body !== null) await response.body.cancel()
  return pairs.length === 0 ? undefined : pairs.join('; ')
}

const cookie = await cookieFor(arg('token'))
const upstream = await Upstream.connect(host, {
  fetch: (input, init) => {
    const headers = new Headers(init?.headers)
    if (cookie !== undefined) headers.set('cookie', cookie)
    return fetch(new URL(String(input), host.baseUrl), { ...init, headers })
  },
})

const disposeControl = await upstream.mountRemote(
  (await import('@deepseek-ai/dsh-control-plane/remote') as { default: unknown }).default,
)
const remote = (upstream as unknown as { root: { remote: { controlPlane: ControlPlaneRemote } } })
  .root.remote.controlPlane

try {
  const infos = await remote.instances()
  if (infos.ok) {
    for (const info of infos.value ?? []) {
      const error = info.error === undefined ? '' : `  (${info.error})`
      console.log(`${info.label}: ${info.state}${error}`)
    }
  } else {
    console.log('instances 失败:', JSON.stringify(infos.error))
  }

  const routed = await (remote as unknown as {
    route: (request: { key: string }) => Promise<Result<{ instanceId: string }>>
  }).route({ key: 'nolock:main' })
  console.log('route:', routed.ok ? JSON.stringify(routed.value) : JSON.stringify(routed.error))

  const tree = await remote.tree()
  if (!tree.ok) throw new Error(`controlPlane/tree 失败: ${JSON.stringify(tree.error)}`)
  for (const node of tree.value ?? []) {
    console.log(`${node.label}  [${node.sessionCount} 会话, ${node.runningCount} 进行中]`)
    for (const workspace of node.workspaces) {
      console.log(`    ${workspace.path}`)
      for (const session of workspace.sessions.slice(0, 5)) {
        console.log(`      ${session.running ? '●' : '○'} ${session.key}`)
      }
    }
  }
} finally {
  await disposeControl()
  await upstream.dispose()
}
