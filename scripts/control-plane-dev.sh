#!/usr/bin/env bash
# 起一个「控制面」Host（开发态）：
#   1. 把 control-plane-bundle 通过官方 `dsh plugin add` 装进隔离 profile
#   2. 用 instances 配置生成一份 --patch 覆盖，不动 profile 的 cordis.patch.yml
#   3. 起 dsh web
#
# 用法：
#   ./scripts/control-plane-dev.sh                 # 默认端口 3095
#   PORT=3100 ./scripts/control-plane-dev.sh
#   INSTANCES_FILE=my.json ./scripts/control-plane-dev.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$ROOT/.devhome-cp}"
PORT="${PORT:-3095}"
INSTANCES_FILE="${INSTANCES_FILE:-$ROOT/control-plane/control-plane.json}"
BUNDLE="$ROOT/packages/control/control-plane-bundle"

[ -f "$INSTANCES_FILE" ] || {
  echo "缺少实例配置：$INSTANCES_FILE" >&2
  echo "可复制模板：cp control-plane/control-plane.example.json control-plane/control-plane.json" >&2
  exit 1
}

export DSH_HOME
mkdir -p "$DSH_HOME"

# 1) 挂载 bundle（官方路径：写依赖 + 追加到 dsh.profile.bundles，幂等）
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

# 3) 起服务
echo "控制面：http://127.0.0.1:$PORT/  （实例：$(node -e "const c=require('$INSTANCES_FILE');console.log(c.instances.map(i=>i.id).join(', '))")）"
exec pnpm dsh --profile web --patch "$PATCH" --no-open --port "$PORT"
