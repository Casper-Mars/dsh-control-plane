# 本地启动与验证

本文说明如何在**源码检出**里启动 dsh 的 Web UI，以及裁剪掉某些功能后怎么验证它真的没了。

适用对象：`~/project/opc/dsh-web-control`（上游 `deepseek-ai/deepseek-harness`）。所有命令都在仓库根目录执行。

---

## 0. 前置条件

| 项 | 要求 | 检查 |
|---|---|---|
| Node.js | **≥ 24.9**（CI 覆盖 24.9 / 24 / 26） | `node -v` |
| pnpm | **11.28.5**，由 corepack 提供 | `corepack enable && pnpm -v` |
| Git | ≥ 2.26（`pnpm install` 会装 lefthook 钩子） | `git --version` |
| 依赖 | 仓库根 `node_modules` | `pnpm install` |

首次配置：

```bash
cd ~/project/opc/dsh-web-control
corepack enable
pnpm install            # 装依赖 + 配置 worktree 本地 git 钩子
pnpm run typecheck      # 通过即说明环境就绪（耗时较长，只在新克隆后跑一次）
```

> 本机若 `pnpm -v` 报错，先 `corepack enable`；仓库用 `package.json > packageManager` 锁定版本，不要手动 `npm i -g pnpm`。

---

## 1. 三条启动路径（按用途选一条）

### A. 最快验证：直接跑源码（推荐用于「改完看一眼」）

不需要预先构建整个仓库，CLI 用 tsx 直接跑 TypeScript 源码：

```bash
make local                 # 默认 3099，DSH_HOME 自动指向 ./.devhome
make local PORT=3098       # 换端口
```

等价于：

```bash
export DSH_HOME="$PWD/.devhome"
pnpm dsh --profile web --no-open --port 3099
```

首次启动会自动用官方模板（`PROFILE_TEMPLATES.web`）在 `$DSH_HOME/profiles/web` 建 profile，并从 workspace 解析 bundle 包。

- 终端会打印一行 `dsh web: http://127.0.0.1:3099/?token=xxx`，浏览器打开它
- `--port 0` 让系统挑空闲端口；`--host <ip>` 绑定具体网卡（拒绝 `0.0.0.0`）
- 停止：`Ctrl+C`

> 注意：这条路径用的是**已构建的**前端产物（`apps/web/dist`）。刚 clone 下来没有 `dist`，先跑 `pnpm run build:artifacts`（或直接用路径 B）。

### B. 开发热更新：改 UI 源码自动重建（推荐用于真正改代码）

```bash
export DSH_HOME="$PWD/.devhome"
pnpm run dev:web --port 3099
```

它做四件事（一条命令、一个终端）：

1. `build:artifacts`（首次全量构建；用 `--skip-build` 可复用上次产物）
2. `tsc -b tsconfig.client.json --watch` — 产出 `lib/types`
3. `tsdown` watch — 产出各包的 `lib/index.js`、`lib/client.js`
4. `vite build --watch` — 重写 `apps/web/dist`
5. 最后起 `dsh web`

宿主 webserver 会轮询它服务的 bundle 文件，检测到重建就广播 `rebuilt` 帧，浏览器自动刷新。

常用参数：

| 参数 | 作用 |
|---|---|
| `--skip-build` | 跳过首次构建（要求之前构建过） |
| `--no-serve` | 只起 watcher，不起 `dsh web`（适合自己另开服务） |
| `--poll[=ms]` | 用轮询代替 inotify（网络盘/容器挂载必须开，默认 500ms） |

> **不要**在 `dev:web` 运行期间再跑 `pnpm run build` 或 `build:artifacts`：它们写同一份 `lib/` 和 `apps/web/dist`。

### C. 构建产物 + 起服务（最接近发布形态）

```bash
pnpm run build          # 全量构建（Host + Client + 前端）
pnpm run start:web      # 等同于 dsh --profile web
```

适合做「最终形态验收」，不适合反复改。

---

## 2. 模型配置（怎么让聊天能真跑起来）

三选一：

| 方式 | 做法 |
|---|---|
| 环境变量 | `export DEEPSEEK_API_KEY=sk-...` 后再启动 |
| UI 里配 | 首次打开 Web UI → Settings → Models 填 Key |
| 无 Key 验证 UI | 起 mock LLM：另开终端 `pnpm run mock:llm`（默认 `http://127.0.0.1:8000/v1`），再在 Models 里把 baseURL 指过去 |

只验证「UI 结构/裁剪」的话，Key 不是必需的——不进会话、只看界面即可。

---

## 3. 裁剪功能后，怎么验证「真的删掉了」

官方 Web 的功能是**运行时组装的**：host 从 bundle 的 `cordis.patch.yml` 里收集 `dsh.client` 行，形成浏览器 roster（`window.__DSH_BOOT__`），前端再按这张图加载插件。所以验证分三层，从粗到细。

### 3.1 看组装结果（不需要打开浏览器）

```bash
pnpm dsh --profile web --dump-config | grep -E "ui-plugin-manager|ui-plugin-market"
```

- 被删/被禁用后，这里**查不到**对应条目（或被标为 `disabled`）
- 想看「不含用户 patch 和 `--patch` 的纯 bundle 层」：`--dump-default-config`

### 3.2 看浏览器实际加载的 roster

打开页面后，浏览器控制台：

```js
window.__DSH_BOOT__.plugins.map(p => p.id)   // 或 entries
```

对比裁剪前后的清单差异，这是最权威的一层——它就是前端真正加载的插件列表。

### 3.3 看界面行为

- 被裁剪的入口（例如设置里的「插件管理」）不再出现
- 若删错到**必需入口**（见下），页面会停在 boot 页并报错，不会白屏无提示

必需入口（fatal set，删了直接起不来）：

```
@deepseek-ai/dsh-client-modules
@deepseek-ai/dsh-api-session-controller
@deepseek-ai/dsh-client-ui-renderer
@deepseek-ai/dsh-client-ui-layout
@deepseek-ai/dsh-client-ui-session
@deepseek-ai/dsh-client-ui-chat
@deepseek-ai/dsh-client-ui-sidebar
```

其余插件加载失败只会在控制台报错、应用照常挂载（少一个功能）。

---

## 4. 裁剪的两种粒度

### 4.1 验证期：用 patch overlay 禁用（不改包、不重装依赖）

在仓库里放一个 overlay 文件，例如 `trim.patch.yml`：

```yaml
# 只禁用，不删除 —— 用于快速验证「没有这个功能」的界面效果
- id: ui-plugin-manager
  disabled: true
- id: ui-plugin-market
  disabled: true
- id: settings-plugins
  disabled: true
- id: settings-plugin-inventory
  disabled: true
```

启动时挂上（`--patch` 可重复）：

```bash
pnpm dsh --profile web --patch ./trim.patch.yml --no-open --port 3099
```

> `id` 取自 `packages/bundle/web-app/cordis.patch.yml` 里的 `dsh.client` 行（名字通常就是插件名去掉 `@deepseek-ai/dsh-client-` 前缀）。改完 patch 只需重启，**不需要重新构建**。

### 4.2 正式裁剪：从组合里去掉

两条都要做，否则要么装了不用、要么引用不到：

1. **删依赖**：`packages/bundle/web-app/package.json` 的 `dependencies` 里去掉对应 `@deepseek-ai/dsh-client-ui-*`
2. **删 roster 行**：`packages/bundle/web-app/cordis.patch.yml` 里删掉对应的 `dsh.client` 行（保留 `disabled: true` 也可，但语义是「装了但关掉」）
3. 重新 `pnpm install`（锁文件会变）→ `pnpm run build`

### 4.3 用哪个？

| 目的 | 用哪种 |
|---|---|
| 讨论「这个功能要不要留」 | 4.1 patch 禁用，秒级生效 |
| 确定不要了、准备提交 | 4.2 删依赖 + 删行，跑全量构建验证 |

---

## 5. 常见坑

| 现象 | 原因 / 处理 |
|---|---|
| 启动报缺 native 模块 | 跑一次 `pnpm run build:native-system` |
| 页面停在 boot 页 | 删到了 fatal set，或某个必需插件的依赖被一起删了；看控制台第一条错误 |
| 改了源码界面没变 | 没在 `dev:web` 下开发，或 watcher 掉了；用 `--poll` 重开 |
| 端口占用 | `--port 0` 或换端口；日志里会打印实际端口和 token |
| 想彻底重置 | 删掉 `$DSH_HOME/profiles/web` 后重启，会按模板重新生成 |
| 想回到干净状态 | `git checkout -- packages/bundle/web-app`，再 `pnpm install` |
| 页面打开 401 | URL 少了 `?token=`，token 在启动日志里 |

---

## 6. 验证清单（每次改完 UI 组合跑一遍）

```bash
# 1) 组装层：目标插件已不在（或被 disabled）
pnpm dsh --profile web --dump-config | grep -c "ui-plugin-manager"      # 期望 0

# 2) 起服务
export DSH_HOME="$PWD/.devhome"
pnpm dsh --profile web --no-open --port 3099

# 3) 浏览器打开日志里的 URL
#    - 页面正常挂载（不是 boot 页）
#    - 控制台里 window.__DSH_BOOT__ 的插件列表不含目标插件
#    - 对应 UI 入口消失（设置里没有「插件管理」）
#    - 核心聊天可用：新建会话、发一条消息（mock LLM 也算通）

# 4) 回归：确认没误删
#    会话列表 / 侧边栏 / 输入框 / 模型选择 / 设置页 都能打开
```

---

## 7. 命令速查

| 命令 | 用途 |
|---|---|
| `make local` | 起 Web UI（`DSH_HOME=./.devhome`，默认 3099，`PORT=` 可改） |
| `pnpm run build:artifacts` | 构建浏览器产物（`make build` 是全量构建） |
| `pnpm install` | 装依赖（含 git 钩子） |
| `pnpm run typecheck` | 全仓类型检查 |
| `pnpm dsh --profile web ...` | 直接跑源码（`--no-open` / `--port` / `--patch` / `--dump-config`） |
| `pnpm run dev:web` | 构建 + watcher + 起服务（开发主循环） |
| `pnpm run build` | 全量构建 |
| `pnpm run start:web` | 用构建产物起服务 |
| `pnpm run build:artifacts` | 只构建产物（`dev:web` 的首阶段） |
| `pnpm run build:native-system` | 编译 native 模块 |
| `pnpm run mock:llm` | 无 Key 的 mock 模型服务（`127.0.0.1:8000`） |
| `pnpm run test:web` | Web 端快照/交互测试（需先 build） |
