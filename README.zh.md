# dsh-control-plane

[English](README.md) | 中文

一个 Web 控制面：**在一个界面里管理多个 DeepSeek Harness（`dsh`）实例**。左侧是 `实例 → 工作区 → 会话` 三级树，右侧复用官方 dsh 对话界面。

<a id="what-it-is"></a>

## 它是什么

- 一条浏览器连接、多个 dsh 宿主：带实例前缀的会话键（`<instanceId>:<sessionId>`）由网关转发到归属实例。
- 统一的三级树、实例在线状态、重连，以及每个实例各自的失败原因。
- 边界：只做接入、路由、呈现、审计。任务编排、重试、验收属于交付层，不在这里。

<a id="status"></a>

## 状态

开发者预览，基于 `dsh` 0.2.2-rc.1。仓库目前仍带着完整的 dsh 源码，因为两个 runtime 扩展点是就地修改的；目标形态是 `dsh-web-control-plane-app` bundle 加插件，完成之后仓库会收缩到只剩控制面本身。

已实现：host 插件（实例树、每实例出站连接、事件流、重连）、网关联邦路由、客户端联邦会话键、侧边栏实例树、会话行右键菜单，以及从工作区行新建会话。

<a id="architecture"></a>

## 架构

```text
Browser ── /api ──> Gateway ── local ─────────────> this host
                        └───── federated key ────> instance A / B / C
```

- `packages/control/control-plane` —— host 插件：每个实例一条出站连接、组树、事件扇出。
- `packages/api/gateway/src/federation.ts` —— 网关联邦路由，处理带实例前缀的调用。
- `packages/api/session-controller/src/client/federation.ts` —— 客户端联邦身份与 `cwd` hint。
- `packages/client/ui-sidebar/src/client/InstanceGroups.tsx` —— 侧边栏实例树。
- `packages/client/ui-conversation` —— 控制面空态与 foreign 会话处理。

<a id="quick-start"></a>

## 快速开始

开发说明和 demo 脚本见 `packages/control/control-plane/README.md`。

```yaml
- id: control-plane
  name: '@deepseek-ai/dsh-control-plane'
  config:
    instances:
      - { id: cto, name: CTO Agent, host: 127.0.0.1, port: 8090 }
      - { id: dev, name: Dev Agent, host: 127.0.0.1, port: 8091 }
```

<a id="repository-layout"></a>

## 仓库结构

```text
packages/control/control-plane/   control-plane host plugin
packages/api/gateway/             gateway and federation routing
packages/api/session-controller/  session model and federated client keys
packages/client/ui-sidebar/       instance tree
packages/client/ui-conversation/  conversation shell
```

<a id="documentation"></a>

## 文档

- 控制面 host 说明：`packages/control/control-plane/README.md`
- 设计计划：[飞书文档](https://www.feishu.cn/docx/NPIcdwT75ogYwexOYYtcp1Xfnkg)
- 上游 harness：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)

<a id="upstream"></a>

## 上游

本仓库派生自 `deepseek-ai/deepseek-harness`（MIT）。`upstream` remote 指向官方仓库；当前历史从控制面工作开始，而不是完整的上游历史。

<a id="license"></a>

## License

MIT
