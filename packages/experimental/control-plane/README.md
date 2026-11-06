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

未实现（下一步）：`instances` Remote 命名空间（给浏览器）；WS 事件流（见已知限制）。

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
pnpm exec tsx packages/experimental/control-plane/scripts/demo-tree.ts

# 类型检查
pnpm exec tsc -b packages/experimental/control-plane/tsconfig.host.json
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
