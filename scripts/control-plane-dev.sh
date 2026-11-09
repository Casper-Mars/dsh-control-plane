#!/usr/bin/env bash
# 起一个「控制面」Host（开发态）：
#   1. 把隔离 profile 的 bundles 固定为 [dsh-base, dsh-control-plane-app]
#      （旧 profile 里的 web-app / control-plane 第三层会被清掉）
#   2. 默认构建 control-plane Host、ui-control-plane client 和 app bundle 的 lib
#   3. 用 `dsh web --config <instances.json>` 起服务
#
# 用法：
#   ./scripts/control-plane-dev.sh                 # 默认端口 3095
#   PORT=3100 ./scripts/control-plane-dev.sh
#   SKIP_BUILD=1 ./scripts/control-plane-dev.sh    # 跳过构建，直接使用现有 lib 产物
#
# 测试用脚本：实例配置固定指向仓库内的 control-plane/control-plane.json。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$ROOT/.devhome-cp}"
PORT="${PORT:-3095}"
# 测试用：固定使用仓库内的测试实例配置。
INSTANCES_FILE="$ROOT/control-plane/control-plane.json"

[ -f "$INSTANCES_FILE" ] || {
  echo "缺少实例配置：$INSTANCES_FILE" >&2
  echo "可复制模板：cp control-plane/control-plane.example.json control-plane/control-plane.json" >&2
  exit 1
}

export DSH_HOME
mkdir -p "$DSH_HOME/profiles/web"

# 1) 固定 profile 的 bundle 列表；实例配置不再写进 profile patch，而是由 --config 传入。
node - "$DSH_HOME/profiles/web/package.json" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')
const [file] = process.argv.slice(2)
let pkg = { name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }
try { pkg = JSON.parse(readFileSync(file, 'utf8')) } catch {}
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
pkg.dsh.profile.bundles = ['@deepseek-ai/dsh-base', 'dsh-control-plane-app']
writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
NODE

# 2) 构建 Host、浏览器插件和 app bundle；SKIP_BUILD=1 可跳过。
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  echo "跳过构建（SKIP_BUILD=1），直接使用现有 lib 产物"
else
  echo "构建 control-plane Host、ui-control-plane client 与 app bundle ..."
  BUILD_STARTED=$SECONDS
  pnpm --filter @deepseek-ai/dsh-control-plane run bundle
  pnpm --filter @deepseek-ai/dsh-client-ui-control-plane run bundle
  pnpm --filter dsh-control-plane-app run bundle
  echo "构建完成，耗时 $((SECONDS - BUILD_STARTED))s"
fi

# 3) 起服务。
echo "控制面：http://127.0.0.1:$PORT/  （实例文件：${INSTANCES_FILE} ）"
exec pnpm dsh --profile web --no-open --port "$PORT" --config "$INSTANCES_FILE"
