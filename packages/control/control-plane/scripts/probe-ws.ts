import { resolveInstances } from '../src/config.ts'
import { Upstream } from '../src/upstream.ts'

const instance = resolveInstances({ instances: [{ id: 'nolock', host: '127.0.0.1', port: 8084 }] })[0]!
const upstream = await Upstream.connect(instance, { events: true })
const events: Array<string> = []
upstream.onSessionStatus((sessionId, running) => {
  events.push(`${sessionId}=${running}`)
  console.log(`  事件: ${sessionId} running=${running}`)
})
await new Promise(resolve => setTimeout(resolve, 2000))
console.log('streamReady =', upstream.streamReady, ' reachability =', upstream.reachability)
const created = await upstream.createSession('/tmp')
console.log('created =', created)
// 触发一次真实 turn，验证 api-session/status 是否推送
const remote = (upstream as unknown as {
  root: { remote: { session: { prompt: (request: unknown) => Promise<{ ok: boolean; error?: unknown }> } } }
}).root.remote
const accepted = await remote.session.prompt({
  requestId: `probe-${Date.now()}`,
  sessionId: created,
  mode: 'queue',
  content: [{ type: 'text', text: 'hi' }],
})
console.log('prompt accepted =', accepted.ok, accepted.ok ? '' : JSON.stringify(accepted.error))
await new Promise(resolve => setTimeout(resolve, 6000))
const rows = await upstream.listSessions()
console.log('sessions =', rows.length)
await new Promise(resolve => setTimeout(resolve, 1000))
console.log('events =', events.length)
await upstream.dispose()
