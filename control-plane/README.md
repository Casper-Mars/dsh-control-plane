# control-plane 配置

本目录**只放配置**。控制面的实现（插件 + bundle）在
[`packages/control/control-plane`](../packages/control/control-plane)。

## 文件

| 文件 | 说明 |
|---|---|
| `control-plane.example.json` | 模板，进仓库 |
| `control-plane.json` | 本地配置，被 `.gitignore` 忽略，从模板复制 |

## 格式

```json
{
  "instances": [
    { "id": "cto", "name": "CTO Agent", "host": "127.0.0.1", "port": 8090 }
  ]
}
```

- `id` 必填、唯一，只允许小写字母、数字、`-`、`_`，是路由与联邦键的唯一来源
- `name` 可选，缺省取 `id`，只用于侧边栏显示
- `host` / `port` 必填，指向该实例的 dsh web
- `token` 可选，实例仍要求 launch token 时填

## 怎么生效

`scripts/control-plane-dev.sh` 在**启动时**读取本文件（可用 `INSTANCES_FILE` 覆盖），
生成 `<DSH_HOME>/control-plane.instances.patch.yml` 叠加层传给 `dsh --patch`。
插件配置不会热更新，**改完必须重跑 `make control-plane`**。

```bash
cp control-plane/control-plane.example.json control-plane/control-plane.json
make control-plane      # 默认 3095
```

> 里程碑 1 的零依赖前缀反代骨架（`server.mjs`、`make proxy`）已移除；
> 需要追溯请看 git 历史 `786d76e2`。
