# dsh-control-plane

English | [中文](README.zh.md)

A web control plane that runs **multiple DeepSeek Harness (`dsh`) instances behind one UI**. The sidebar shows an `instance → workspace → session` tree; the conversation column reuses the official dsh UI.

## What it is

- One browser connection, many dsh hosts: instance-qualified session keys (`<instanceId>:<sessionId>`) are routed by the gateway.
- A unified tree, live instance status, reconnect, and per-instance error reasons.
- Scope: access, routing, presentation, and audit. Task orchestration, retries, and acceptance belong to the delivery layer, not here.

## Status

Developer preview, based on `dsh` 0.2.2-rc.1. The repository currently carries the full dsh source because two runtime seams are patched in place; the target shape is a `dsh-web-control-plane-app` bundle plus plugins, after which the repository shrinks to the control plane alone.

Implemented: the host plugin (tree, per-instance connections, event stream, reconnect), gateway federation routing, client-side federated session keys, the sidebar instance tree, the session context menu, and new-session from a workspace row.

## Architecture

```text
Browser ── /api ──> Gateway ── local ─────────────> this host
                        └───── federated key ────> instance A / B / C
```

- `packages/control/control-plane` — host plugin: one outbound connection per instance, tree assembly, event fan-out.
- `packages/api/gateway/src/federation.ts` — gateway routing for instance-qualified calls.
- `packages/api/session-controller/src/client/federation.ts` — client-side federated identities and `cwd` hints.
- `packages/client/ui-sidebar/src/client/InstanceGroups.tsx` — sidebar instance tree.
- `packages/client/ui-conversation` — control-plane empty state and foreign-session handling.

## Quick start

Development instructions and the demo scripts live in `packages/control/control-plane/README.md`.

```json
{ "instances": [
  { "id": "cto", "name": "CTO Agent", "host": "127.0.0.1", "port": 8090 },
  { "id": "dev", "name": "Dev Agent", "host": "127.0.0.1", "port": 8091 }
] }
```

```bash
dsh web --config ./control-plane.json
```

## Repository layout

```text
packages/bundle/control-plane-app/  the browser surface (default web profile)
packages/control/control-plane/     control-plane host plugin
packages/client/ui-control-plane/   sidebar instance tree
packages/api/gateway/               gateway and federation routing
packages/api/session-controller/    session model and federated client keys
```

## Documentation

- Control-plane host notes: `packages/control/control-plane/README.md`
- Design plan: [Feishu document](https://www.feishu.cn/docx/NPIcdwT75ogYwexOYYtcp1Xfnkg)
- Upstream harness: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)

## Upstream

This repository is derived from `deepseek-ai/deepseek-harness` (MIT). The `upstream` remote points at the official repository; the current history starts at the control-plane work rather than the full upstream history.

## License

MIT
