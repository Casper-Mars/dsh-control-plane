#!/usr/bin/env bash
# 起一个「控制面」Host（开发态）：
#   1. 把控制面 bundle（就是插件包本身）通过官方 `dsh plugin add` 装进隔离 profile
#   2. 用 instances 配置生成一份 --patch 覆盖，不动 profile 的 cordis.patch.yml
#   3. 默认构建 control-plane Host 与 ui-sidebar client bundle，避免启动时加载旧 bundle
#      （两次独立的 pnpm run bundle，不能用多 --filter 合并，会触发 workspace 任务环）
#   4. 起 dsh web
#
# 用法：
#   ./scripts/control-plane-dev.sh                 # 默认端口 3095
#   PORT=3100 ./scripts/control-plane-dev.sh
#   INSTANCES_FILE=my.json ./scripts/control-plane-dev.sh
#   SKIP_BUILD=1 ./scripts/control-plane-dev.sh    # 跳过构建，直接使用现有 bundle 产物
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$ROOT/.devhome-cp}"
PORT="${PORT:-3095}"
INSTANCES_FILE="${INSTANCES_FILE:-$ROOT/control-plane/control-plane.json}"
BUNDLE="$ROOT/packages/control/control-plane"

[ -f "$INSTANCES_FILE" ] || {
  echo "缺少实例配置：$INSTANCES_FILE" >&2
  echo "可复制模板：cp control-plane/control-plane.example.json control-plane/control-plane.json" >&2
  exit 1
}

export DSH_HOME
mkdir -p "$DSH_HOME"

# 1) 挂载 bundle（官方路径：写依赖 + 追加到 dsh.profile.bundles，幂等）
#    控制面插件包自己声明 dsh.bundle，所以它同时是 bundle 和插件，不再有独立的挂载壳。
#    旧版把壳放在 control-plane-bundle，这里顺手清掉历史 profile 里的残留依赖。
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-control-plane-bundle >/dev/null 2>&1 || true
pnpm dsh plugin --profile web add "link:$BUNDLE" >/dev/null

# 2) instances 只作为叠加层，保留 profile 自己的 cordis.patch.yml
PATCH="$DSH_HOME/control-plane.instances.patch.yml"
node - "$INSTANCES_FILE" "$PATCH" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')
const [input, output] = process.argv.slice(2)
const config = JSON.parse(readFileSync(input, 'utf8'))
const rows = (config.instances ?? []).map((instance) => {
  const fields = [
    `id: ${instance.id}`,
    instance.name === undefined ? null : `name: '${instance.name.replaceAll("'", "''")}'`,
    `host: ${instance.host}`,
    `port: ${instance.port}`,
    instance.token === undefined ? null : `token: '${instance.token}'`,
  ].filter(Boolean).join(', ')
  return `          - { ${fields} }`
})
writeFileSync(output, `- id: control-plane\n  config:\n    instances:\n${rows.join('\n')}\n`)
NODE

# 3) 默认构建 control-plane Host 与 ui-sidebar client bundle
#    必须是两次独立的 pnpm 调用：合并成一条多 --filter 命令会触发 workspace 任务环
#    （control-plane#bundle ↔ ui-sidebar#bundle）。SKIP_BUILD=1 可跳过构建。
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  echo "跳过构建（SKIP_BUILD=1），直接使用现有 bundle 产物"
else
  echo "构建 control-plane Host 与 ui-sidebar client bundle ..."
  BUILD_STARTED=$SECONDS
  if ! pnpm --filter @deepseek-ai/dsh-control-plane run bundle; then
    echo "构建失败：@deepseek-ai/dsh-control-plane bundle" >&2
    exit 1
  fi
  if ! pnpm --filter @deepseek-ai/dsh-client-ui-sidebar run bundle; then
    echo "构建失败：@deepseek-ai/dsh-client-ui-sidebar bundle" >&2
    exit 1
  fi
  echo "构建完成，耗时 $((SECONDS - BUILD_STARTED))s"
fi

# 4) 起服务
echo "控制面：http://127.0.0.1:$PORT/  （实例：$(node -e "const c=require('$INSTANCES_FILE');console.log(c.instances.map(i=>i.id).join(', '))")）"
exec pnpm dsh --profile web --patch "$PATCH" --no-open --port "$PORT"
