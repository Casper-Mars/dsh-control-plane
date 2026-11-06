# @deepseek-ai/dsh-control-plane

控制面的核心数据模型：**一个 Web UI 管多个 Harness 实例**，侧边栏三级 `实例 → 工作区 → 会话`。

## 当前进度（里程碑 2 第一步）

已实现（无真实连接，纯数据层）：

| 文件 | 内容 |
|---|---|
| `src/config.ts` | 实例配置校验与派生：`id` 唯一且格式受限、`host`/`port` 必填、`name` 缺省取 `id`、派生 `baseUrl` |
| `src/tree.ts` | 联邦键编码（`<instanceId>:<值>`）、解包、三级树组装（实例按配置顺序、工作区按路径、会话按更新时间倒序）、组内 running 统计 |
| `src/index.ts` | Cordis 插件：`controlPlane.instances` / `.tree()` / `.route(key)` |
| `scripts/demo-tree.ts` | 假数据演示，打印三级结构并验证路由 |

未实现（下一步）：出站连接（每实例一条 client connection）、`instances` Remote 命名空间、事件流订阅。

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
