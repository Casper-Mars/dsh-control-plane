# Short names for the Web and Desktop application commands. The package.json
# scripts they call stay the source of truth; docs/development.md documents both.
.DEFAULT_GOAL := help
.PHONY: help build clean web desktop dev-web dev-desktop local control-plane

PNPM ?= pnpm
ARGS ?=

help:
	@echo "make build        pnpm run build           complete repository build"
	@echo "make clean        pnpm run clean           remove build outputs and safe deleted-package residue"
	@echo "make web          pnpm run start:web       serve the built Web artifacts from source"
	@echo "make desktop      pnpm run start:desktop   launch the built Desktop artifacts"
	@echo "make dev-web      pnpm run dev:web         build, serve, and rebuild Web on source edits"
	@echo "make dev-desktop  pnpm run dev:desktop     build, then launch Desktop"
	@echo "ARGS='--no-open --port 3081' forwards options to the launched application;"
	@echo "the Web commands accept dsh web flags, the Desktop launcher accepts none."
	@echo "make local       起 Web UI（隔离 DSH_HOME=./.devhome，默认端口 3099）"
	@echo "PORT=3098 make local  换端口"
	@echo "make control-plane  起控制面 Host（bundle + 实例叠加层）"

build:
	$(PNPM) run build

clean:
	$(PNPM) run clean

web:
	$(PNPM) run start:web $(ARGS)

desktop:
	$(PNPM) run start:desktop $(ARGS)

dev-web:
	$(PNPM) run dev:web $(ARGS)

dev-desktop:
	$(PNPM) run dev:desktop $(ARGS)

# ── 本项目（Web 控制面）本地验证 ─────────────────────────────────────────
# 与 make web 的区别：DSH_HOME 隔离到仓库内 .devhome（不碰 ~/.dsh），端口默认 3099。
PORT ?= 3099
DSH_HOME_DIR := $(CURDIR)/.devhome

local:
	DSH_HOME=$(DSH_HOME_DIR) $(PNPM) dsh --profile web --no-open --port $(PORT)

# 控制面开发态：装 bundle + 生成 instances 叠加层 + 起服务
control-plane:
	./scripts/control-plane-dev.sh
