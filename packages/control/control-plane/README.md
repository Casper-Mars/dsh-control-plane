# @deepseek-ai/dsh-control-plane

控制面的核心数据模型：**一个 Web UI 管多个 Harness 实例**，侧边栏三级 `实例 → 工作区 → 会话`。

## 当前进度（3.2 出站连接）

已实现：

| 文件 | 内容 |
|---|---|
| `src/config.ts` | 实例配置校验与派生：`id` 唯一且格式受限、`host`/`port` 必填、`name` 缺省取 `id`、派生 `baseUrl` |
| `src/tree.ts` | 联邦键编码（`<instanceId>:<值>`）、解包、三级树组装（实例按配置顺序、工作区按路径、会话按更新时间倒序）、组内 running 统计 |
| `src/index.ts` | Cordis 插件：`controlPlane.instances` / `.tree()` / `.route(key)` |
| `src/upstream.ts` | 每实例一条出站连接（独立 Cordis 子 root + client connection + 只挂 `session` 命名空间），`listSessions()` / `createSession()` / 状态与错误 |
| `src/index.ts` | `controlPlane.connect()`（连全部 + 探活）、`.snapshot()`（并发拉取并组树）、`.states()`、`.dispose()` |
| `src/connections.ts` | 每实例连接注册表：重连（并发去重）、自动恢复限频（默认 5s/实例）、失败原因（值而非抛错） |
| `src/events.ts` | `controlPlane/events` 推送扇出：首帧全量树、`status` / `change` / `states` 增量帧、每订阅者有限队列（慢消费者只丢旧的非树帧） |
| `scripts/demo-tree.ts` | 假数据演示三级结构 |
| `scripts/demo-two.ts` | 两个真实实例 → 三元树 + 连通状态 |

| `src/index.ts`（3.3） | `onSessionStatus` / `onSessionChange`、`startPolling()`（默认 2s，diff 上一轮）、事件里 qualified key |

### 3.4 前置：Remote 命名空间（已完成）

控制面类改为 `TypertRemoteService`，暴露五个方法（生成物：`lib/typert.host.js`、`lib/typert.remote-client.js`）：

| 方法 | 返回 |
|---|---|
| `controlPlane/instances` | `InstanceInfo[]`（id、name、label=`name(id)`、state、error） |
| `controlPlane/tree` | `InstanceNode[]`（实例 → 工作区 → 会话，含 runningCount、state、error） |
| `controlPlane/route` | `{ key }` → `{ instanceId, sessionId }` |
| `controlPlane/reconnect` | `{ instanceId }` → `{ state, error? }`（失败是值，不是拒绝） |
| `controlPlane/events` | `mode: 'stream'`：首帧全量树，随后 `status` / `change` / `states` 增量帧（订阅期间宿主保持 2s diff） |

- 边界类型集中在 `src/types.ts`，通过 `./types` 子路径导出（Typert 的硬性要求）
- 生成命令：`node --import tsx/esm scripts/generate-typert.ts`（build:artifacts 里也会跑）
- 生成的描述符：`methods: controlPlane/instances, controlPlane/route, controlPlane/tree, controlPlane/reconnect, controlPlane/events`

### 3.6 事件流（t100642）

- `controlPlane/events` 是本地流式端点（不进 federation 表）：订阅时先 `yield` 一帧 `snapshot()` 全量树，之后逐条推送会话 running 态、added/updated/removed 变化，以及实例可达性变化。
- 可达性变化同时推 `states`（只含变化的实例）和一帧新 `tree`：恢复的实例要连同会话行一起回来，失败的实例要立刻停掉可点击行。
- 背压：每订阅者一条有界队列；队列满时丢最旧的非树帧，`tree` 帧始终保留。发布路径不 `await` 消费者，一个卡住的浏览器不会拖慢其他人。
- 订阅存在期间由事件流持有 2s `startPolling()`（宿主已自行启动时不会抢占；最后一个订阅者离开才停），断线重订阅仍从全量树起步。
- 侧边栏仍保留 30s 兜底轮询；推送只是快路径。

### 3.7 会话行右键菜单（t100643）

- 侧边栏会话行把**完整的联邦键**（`<instanceId>:<sessionId>`）交给官方 `ctx.contextMenus` 的 `session` 目标，因此复用的是 ui-workspace 已有的 `session.pin/rename/fork/archive` 贡献，不另造浮层。
- 目标额外携带三项只能在控制面知道的展示事实：`pinned`、`archived`（来自归属实例的 Workspace pin/archive 集）与 `unavailableReason`（实例非 `connected` 时的本地化原因）。ui-workspace 优先读目标上的值，缺省才回落本地 catalog —— 普通 dsh 的会话行不带这些字段，行为不变。
- `pin`/`archive` 的权威集来自每条连接上的 `workspace/follow`：`session/list` 不含这两个字段，`Upstream` 每连接维持一条 follow 世代把两个集合缓存在本地，`listSessions()` 投影到 `SessionRow.pinned/archived`（为真才出现在行上）。follow 失败不影响可达性判定。
- `archived` 的行为与官方一致：`buildTree` 直接把归档行从树里去掉（下一次 diff 会推 `updated`，侧边栏随即刷新）；取消归档后行会回来。
- `diff` 除了 `updatedAt`/`running` 还比较 `title`/`pinned`/`archived`：重命名、置顶、归档都不会动 `updatedAt`，不比较就只能等 30s 兜底轮询。
- 离线：`unreachable` 实例仍按既有规则不渲染会话行（比置灰更强）；`connecting`（或刚掉线的帧）仍显示行，但四个操作全部 `disabled`，菜单首行用 `unavailableReason` 说明原因；「复制 Session ID」不需要实例，保持可用。
- 联邦键不查本地 grants（本地授权快照只描述本 Host 自己的资源），归属实例在转发调用到达时自行鉴权；`session/fork` 返回的裸子 id 由 session 客户端补回实例前缀，避免后续调用被解析到本 Host 的同名会话。

### 3.5 离线态与重连（S3-03）

- `controlPlane/tree` 的每个实例节点带 `state`（`connecting` / `connected` / `unreachable`）与可选 `error`；侧边栏以这一帧为准，不再单独轮询 `instances`。
- `snapshot()` 在某个实例读取失败时**不写入空数组**：该实例保留 `unreachable` + 错误原因、`workspaces` 为空。这样「离线」与「在线但无会话」在数据上就可区分。
- `controlPlane/reconnect({ instanceId })` 重连单个实例：先 dispose 旧连接，再 `Upstream.connect` + `listSessions` 探活。失败返回 `{ state: 'unreachable', error }` 而不是抛错（侧边栏要显示原因）；同一实例的并发重连共享一次尝试（in-flight map）。
- 自动恢复：`snapshot()` 开头对「从未连上」的实例做后台重连，每个实例最多 5s 一次（`InstanceConnections.recover`）。已挂载但探活失败的连接留在注册表里，下一次 `listSessions()` 自己恢复，不触发重连。

### 3.3 验证结果（轮询 diff）

```
首次刷新完成（已建立基线）
在 a 上新建会话: a:session-aa10a893-…
  变更事件: a:session-aa10a893-… added      ← 下一轮 diff 立刻发现
第二次刷新完成
```

running 状态变化走同一条 diff 路径（`old.running !== value.running` → `onSessionStatus`）。

### 3.2 验证结果

```
实例: a=connected, b=connected      # 停掉 b 后 → a=connected, b=unreachable
✓ A Agent(a)  [5 会话, 0 进行中]
    /tmp
      ○ a:session-b3560842-…       # 同一实例的会话都带 a: 前缀
✗ B Agent(b)  [0 会话, 0 进行中]  (Remote 调用失败: session/list failed: fetch failed)
```

一个实例挂掉不会影响另一个：连接、探测、组树都是每实例独立的一次调用。

## 为什么需要实例前缀

`dsh` 的 `SessionId` 是**进程内自增计数器**（`session-${++counter}`），每个实例都从 `session-1` 开始；工作区路径也会重复（都是 `/workspace`）。所以跨实例的任何 id 都必须带实例维度，否则必然冲突。

编码规则：`<instanceId>:<原值>`，原值原样保留（Windows 路径 `C:\work`、含冒号的 session id 都能正确还原）。

## 验证

```bash
# 打印三级树（假数据：两个实例都出现 session-1 与 /workspace）
pnpm exec tsx packages/control/control-plane/scripts/demo-tree.ts

# 类型检查
pnpm exec tsc -b packages/control/control-plane/tsconfig.host.json
```

输出示例：

```
CTO Agent(cto)  [3 会话, 1 进行中]
  /workspace  (2 会话, 1 进行中)
    ● cto:session-1
    ○ cto:session-2
  /workspace/api  (1 会话, 0 进行中)
    ○ cto:session-3
PM Agent(pm)  [2 会话, 0 进行中]
  /workspace  (1 会话, 0 进行中)
    ○ pm:session-1
  (no workspace)  (1 会话, 0 进行中)
    ○ pm:session-4
Dev Agent(dev)  [0 会话, 0 进行中]

路由: cto:session-1 → instance=cto, sessionId=session-1
```

## 如何挂载（bundle，官方方式）

**patch 的 `insert` 不能直接挂普通插件**：条目会出现在配置里、启动诊断显示 `state: active`，
但构造器从不执行（表现为 `include:<id>`）。普通插件必须由一个 bundle 的
`cordis.patch.yml` 插入——这也是 dsh 自己所有插件的形态。

**本包自己就是 bundle**：`package.json` 声明 `dsh.bundle.patch`，根目录的
`cordis.patch.yml` 插入 `control-plane` 插件行（name 指向本包）。所以仓库里没有独立的
挂载壳包——一个目录同时是插件源码和 bundle 层。

### 一条命令

```bash
cp control-plane/control-plane.example.json control-plane/control-plane.json   # 填 instances
make control-plane          # 默认 3095，PORT=3100 可改
```

脚本做的事（`scripts/control-plane-dev.sh`）：

1. `dsh plugin add link:<本包>` —— 官方挂载：写 profile 依赖 + 追加到 `dsh.profile.bundles`
2. 把 `instances` 生成为 `--patch` 叠加层（不改 profile 的 `cordis.patch.yml`）
3. 起 `dsh web`

### 构建顺序（重要）

宿主产物是 **tsc 编译到 lib/types → tsdown 打包**：

```bash
pnpm exec tsc -b packages/control/control-plane/tsconfig.host.json
pnpm --filter @deepseek-ai/dsh-control-plane exec tsdown --config-loader native
```

只跑 tsdown 会打包**旧的** lib/types：改源码不生效、且完全没有报错。

### 验证结果（干净 profile + 免 token 实例）

```
[control-plane] 插件已激活，实例数: 1
No-Lock(nolock): connected
route: {"instanceId":"nolock","sessionId":"main"}
No-Lock(nolock)  [6 会话, 0 进行中]
    /tmp
      ○ nolock:session-…
    /Users/reachlucifer/agents/dsh-worker/test/workspace
      ○ nolock:main
```

`controlPlane/instances`、`/route`、`/tree` 均经真实 Host 调用成功；侧边栏消费同一命名空间。

## 已知限制

1. **WS 事件通道未接通**：`interactions: 'answer'` 时网关的 mux 载体没有走到注入的
   `createWebSocket`（Node 侧 `lib/client.node.js` 里 `connection.openWebSocket` 未被调用，
   表现为 `[connection] connection lost, retry #N`）。当前用 2s 轮询 diff 替代，
   running/updatedAt 变化能在 ≤2s 内被发现；接通后改回推送，接口不变。
2. 轮询对实例数量线性增加请求量（每实例每 2s 一次 `session/list`），实例多时需要退避或事件化。

## 配置形态（将来挂进 profile）

```yaml
- id: control-plane
  name: '@deepseek-ai/dsh-control-plane'
  config:
    instances:
      - { id: cto, name: CTO Agent, host: 127.0.0.1, port: 8090 }
      - { id: pm,  name: PM Agent,  host: 127.0.0.1, port: 8091 }
      - { id: dev, name: Dev Agent, host: 127.0.0.1, port: 8092 }
```
