# control-plane（控制面骨架）

里程碑 1：**统一入口 + 多实例前缀路由**。零依赖，纯 Node HTTP/WS 反向代理。

```
浏览器 ──▶ control-plane :8099
              ├─ /i/cto/  ▶  127.0.0.1:8090（cto 的 dsh web）
              ├─ /i/pm/   ▶  127.0.0.1:8093
              ├─ /i/dev/  ▶  127.0.0.1:8091
              ├─ /__instances  实例清单（JSON）
              └─ /             302 到第一个实例
```

## 用

```bash
cp control-plane/control-plane.example.json control-plane/control-plane.json   # 改实例
make proxy          # 起在 127.0.0.1:8099
```

配置（`control-plane.json`，已被 gitignore）：

```json
{
  "listen": { "host": "127.0.0.1", "port": 8099 },
  "instances": [
    { "id": "cto", "name": "CTO Agent", "host": "127.0.0.1", "port": 8090 },
    { "id": "pm",  "name": "PM Agent",  "host": "127.0.0.1", "port": 8093 },
    { "id": "dev", "name": "Dev Agent", "host": "127.0.0.1", "port": 8091 }
  ]
}
```

- `id` 全局唯一，重复或字段缺失会在启动时直接报错（不接受 agent 自报身份）
- 控制面容器里跑时 `host` 用 `host.docker.internal`（或 compose 服务名），因为 agent 端口只绑宿主回环

## 做了什么

- HTTP 前缀代理：静态资源、`/api` 一元调用全部原样转发（含 query）
- WebSocket 升级代理：`/api/remote.mux` 的帧双向管道
- 启动时校验配置：id 唯一、必填字段齐全

## 已知限制（里程碑 2 要解决的）

1. **会话不合并**：`/i/cto/` 与 `/i/pm/` 是两套独立 SPA，切换等于换一套界面；统一会话列表需要理解 remote 协议，属于里程碑 2（联邦 host）。
2. **入口 URL 必须带上游前缀**：agent 若打印 `http://host:port/?token=…`，要改成 `/i/<id>/?token=…` 打开（上游的 303 是相对路径，能正确落在前缀内）。
3. **只支持路径前缀路由**：没有按 header/cookie 选实例、没有健康检查、没有连接复用。

## 验证过的行为

```
GET /                      → 302 /i/dummy/
GET /__instances           → 200 实例清单
GET /i/dummy/              → 200（转发上游）
GET /i/nope/               → 404
GET /i/web/?token=…        → 303 → 200，__DSH_BOOT__ 正常下发（真实 dsh 实例验证）
```

## 里程碑 2/3（未开始）

- 里程碑 2：`instances` remote namespace、健康探活、按会话路由。
- 里程碑 3：会话列表合并（`instanceId/hostSessionId` 复合键）、跨实例搜索、审计落驿传。
