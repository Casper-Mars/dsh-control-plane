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
| `scripts/demo-tree.ts` | 假数据演示三级结构 |
| `scripts/demo-two.ts` | 两个真实实例 → 三元树 + 连通状态 |

| `src/index.ts`（3.3） | `onSessionStatus` / `onSessionChange`、`startPolling()`（默认 2s，diff 上一轮）、事件里 qualified key |

### 3.4 前置：Remote 命名空间（已完成）

控制面类改为 `TypertRemoteService`，暴露三个方法（生成物：`lib/typert.host.js`、`lib/typert.remote-client.js`）：

| 方法 | 返回 |
|---|---|
| `controlPlane/instances` | `InstanceInfo[]`（id、name、label=`name(id)`、state、error） |
| `controlPlane/tree` | `InstanceNode[]`（实例 → 工作区 → 会话，含 runningCount） |
| `controlPlane/route` | `{ key }` → `{ instanceId, sessionId }` |

- 边界类型集中在 `src/types.ts`，通过 `./types` 子路径导出（Typert 的硬性要求）
- 生成命令：`node --import tsx/esm scripts/generate-typert.ts`（build:artifacts 里也会跑）
- 生成的描述符：`methods: controlPlane/instances, controlPlane/route, controlPlane/tree`

未实现（下一步）：浏览器侧消费（`ctx.remote.controlPlane.tree()`）+ 侧边栏三级分组；WS 事件流见已知限制。

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

## 如何挂载（必须走 bundle）

**patch 的 `insert` 不能直接挂载普通插件**：入口虽然出现在配置里，但启动诊断显示为
`include:<id>` 且从不构造。实测结论：patch insert 面向 bundle，普通插件要由一个
bundle 的 `cordis.patch.yml` 插入。

因此本仓库提供 `packages/control/control-plane-bundle`（只有 package.json + patch）：

```yaml
# control-plane-bundle/cordis.patch.yml
- insert:
    - id: control-plane
      name: '@deepseek-ai/dsh-control-plane'
      config:
        instances: []
```

挂载步骤（开发态）：

1. profile 的 `package.json` 里加依赖与本 bundle：
   ```json
   "dependencies": { "@deepseek-ai/dsh-control-plane-bundle": "link:../../../../../packages/control/control-plane-bundle" },
   "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@deepseek-ai/dsh-control-plane-bundle"] } }
   ```
2. 用 patch 覆盖实例清单（config 整体替换，非深合并）：
   ```yaml
   - id: control-plane
     config:
       instances: [{ id: nolock, name: 'No-Lock', host: 127.0.0.1, port: 8084 }]
   ```
3. `pnpm dsh --profile web --patch <file>`

### 构建顺序（重要）

宿主产物由 **tsc 先编译到 lib/types，再由 tsdown 打包**：

```bash
pnpm exec tsc -b packages/control/control-plane/tsconfig.host.json
pnpm --filter @deepseek-ai/dsh-control-plane exec tsdown --config-loader native
```

只跑 tsdown 会打包**旧的** lib/types —— 改源码后不生效，且没有任何报错。

### 3.5 验证结果

```
[control-plane] 插件已激活，实例数: 1
No-Lock(nolock): connected
No-Lock(nolock)  [6 会话, 0 进行中]
    /tmp
      ○ nolock:session-913c75d3-…
    /Users/reachlucifer/agents/dsh-worker/test/workspace
      ○ nolock:main
      ○ nolock:session-50264eb7-…
```

`controlPlane/instances` 与 `controlPlane/tree` 均经真实 Host 调用成功；侧边栏消费同一
命名空间（`ui-sidebar` 的 `sidebar.instances` 槽位）。

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
