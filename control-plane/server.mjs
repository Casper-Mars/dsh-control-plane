#!/usr/bin/env node
/**
 * 控制面骨架 · 里程碑 1：统一入口 + 多实例路由（零依赖）
 *
 *   http://<control>/i/<instanceId>/...  →  <instance.host>:<instance.port>/...
 *
 * 只做 HTTP + WebSocket 的前缀反向代理，不懂 dsh 内部协议：
 *  - 浏览器打开 `/i/cto/` 就是 cto 那套官方 UI（静态资源、/api、/api/remote.mux 全走这里）
 *  - WebSocket 升级（remote.mux）按同样的前缀转发
 *  - `GET /__instances` 返回实例清单，供后续做实例选择器 / 健康检查
 *
 * 里程碑 2（未做）：会话列表合并 —— 需要理解 remote 协议，另起一层联邦 host。
 *
 * 用法:
 *   node control-plane/server.mjs [--config control-plane/control-plane.json]
 */
import { createServer, request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function loadConfig(argv) {
  const flag = argv.indexOf('--config')
  const path = resolve(flag > -1 ? argv[flag + 1] : resolve(HERE, 'control-plane.json'))
  const config = JSON.parse(readFileSync(path, 'utf8'))
  const ids = new Set()
  for (const instance of config.instances ?? []) {
    for (const key of ['id', 'host', 'port']) {
      if (instance[key] === undefined) throw new Error(`instance 缺少字段 ${key}: ${JSON.stringify(instance)}`)
    }
    if (ids.has(instance.id)) throw new Error(`instance id 重复: ${instance.id}`)
    ids.add(instance.id)
  }
  if (ids.size === 0) throw new Error('instances 为空')
  return { ...config, byId: new Map(config.instances.map(i => [i.id, i])), path }
}

const config = loadConfig(process.argv.slice(2))
const PREFIX = /^\/i\/([^/]+)(\/.*)?$/

/** 把请求转发到目标实例；path 已按前缀裁剪。 */
function proxy(req, res, instance, path) {
  const headers = { ...req.headers, host: `${instance.host}:${instance.port}` }
  const upstream = httpRequest(
    { host: instance.host, port: instance.port, method: req.method, path, headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  upstream.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: `upstream ${instance.id} 不可用`, detail: error.message }))
  })
  req.pipe(upstream)
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://placeholder')

  if (url.pathname === '/__instances') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      instances: config.instances.map(({ id, name, host, port }) => ({ id, name, host, port, url: `/i/${id}/` })),
    }, null, 2))
    return
  }

  if (url.pathname === '/' || url.pathname === '') {
    res.writeHead(302, { location: `/i/${config.instances[0].id}/` })
    res.end()
    return
  }

  const match = PREFIX.exec(url.pathname)
  if (match === null) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found', hint: '实例入口形如 /i/<instanceId>/' }))
    return
  }

  const instance = config.byId.get(decodeURIComponent(match[1]))
  if (instance === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: `未知实例 ${match[1]}` }))
    return
  }
  proxy(req, res, instance, (match[2] ?? '/') + url.search)
})

// WebSocket（/api/remote.mux）走同样的前缀路由
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://placeholder')
  const match = PREFIX.exec(url.pathname)
  const instance = match === null ? undefined : config.byId.get(decodeURIComponent(match[1]))
  if (instance === undefined) {
    socket.destroy()
    return
  }
  const upstream = httpRequest({
    host: instance.host,
    port: instance.port,
    method: req.method,
    path: (match[2] ?? '/') + url.search,
    headers: { ...req.headers, host: `${instance.host}:${instance.port}` },
  })
  upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n${
        Object.entries(upstreamRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`,
    )
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    upstreamSocket.pipe(socket).pipe(upstreamSocket)
  })
  upstream.on('error', () => socket.destroy())
  upstream.end()
})

const { host, port } = config.listen ?? { host: '127.0.0.1', port: 8099 }
server.listen(port, host, () => {
  console.log(`control-plane: http://${host}:${port}/  (config: ${config.path})`)
  for (const instance of config.instances) {
    console.log(`  /i/${instance.id}/  →  http://${instance.host}:${instance.port}  (${instance.name})`)
  }
})
