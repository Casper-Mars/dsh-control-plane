/**
 * Demo: compose the sidebar tree from fake instance data, no real connections.
 *
 *   pnpm exec tsx packages/experimental/control-plane/scripts/demo-tree.ts
 *
 * The fixture deliberately reuses `session-1` in both instances and the same
 * `/workspace` path, which is what makes the instance dimension necessary.
 */
import { resolveInstances } from '../src/config.ts'
import { buildTree, split } from '../src/tree.ts'
import type { SessionRow } from '../src/tree.ts'

const instances = resolveInstances({
  instances: [
    { id: 'cto', name: 'CTO Agent', host: '127.0.0.1', port: 8090 },
    { id: 'pm', name: 'PM Agent', host: '127.0.0.1', port: 8091 },
    { id: 'dev', name: 'Dev Agent', host: '127.0.0.1', port: 8092 },
  ],
})

const now = 1_760_000_000_000
const fixture = new Map<string, SessionRow[]>([
  ['cto', [
    { sessionId: 'session-1', cwd: '/workspace', updatedAt: now + 5000, running: true },
    { sessionId: 'session-2', cwd: '/workspace', updatedAt: now + 1000, running: false },
    { sessionId: 'session-3', cwd: '/workspace/api', updatedAt: now + 3000, running: false },
  ]],
  ['pm', [
    { sessionId: 'session-1', cwd: '/workspace', updatedAt: now + 4000, running: false },
    { sessionId: 'session-4', updatedAt: now + 2000, running: false },
  ]],
])

const tree = buildTree(instances, fixture)
for (const node of tree) {
  console.log(`${node.label}  [${node.sessionCount} 会话, ${node.runningCount} 进行中]`)
  for (const workspace of node.workspaces) {
    console.log(`  ${workspace.path}  (${workspace.sessions.length} 会话, ${workspace.runningCount} 进行中)`)
    for (const session of workspace.sessions) {
      console.log(`    ${session.running ? '●' : '○'} ${session.key}`)
    }
  }
}

const sample = tree[0]?.workspaces[0]?.sessions[0]?.key
if (sample === undefined) throw new Error('demo: 空树')
const routed = split(sample)
console.log(`\n路由: ${sample} → instance=${routed.instanceId}, sessionId=${routed.value}`)
