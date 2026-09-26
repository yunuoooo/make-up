#!/bin/sh
set -eu

# 本地/手工部署：拉代码 → 装依赖 → 校验 .env → 构建 → 自检 → 重启。
#
# **生产服务器不走这个脚本。** 服务器上的 /srv/make-up 是 CI 发布的产物（不是 git
# clone），发版靠 push 到 main 触发的 GitHub Actions —— 服务器不构建、不装依赖。
# 见 docs/specs/09-26-cicd-deploy.md。这个脚本现在服务的是本机开发和应急手改。
#
# 用法（在仓库里或任意目录都能跑，脚本自己 cd 到仓库根）：
#   ./scripts/deploy.sh
#   DEPLOY_DRY_RUN=1 ./scripts/deploy.sh     # 只体检，不动任何东西（推荐先跑这个）
#
# 可覆盖的环境变量：
#   DEPLOY_BRANCH         期望所在分支；不一致就停下（不自动切换，避免丢本机改动）
#   DEPLOY_SERVICE        systemd 单元名；给了就用 sudo systemctl restart
#   DEPLOY_RESTART_CMD    自定义重启命令（优先级最高）
#   DEPLOY_ALLOW_NOHUP=1  允许用 pkill + nohup 重启（本机开发用；默认关，理由见下方 restart_kind）
#   DEPLOY_PORT           就绪探测的端口，默认 3000
#   DEPLOY_SKIP_PULL=1    跳过 git 拉取
#   DEPLOY_SKIP_INSTALL=1 跳过 npm ci
#   DEPLOY_SKIP_SELFCHECK=1 跳过扩展自检
#
# 为什么这些检查写死在脚本里：2026-09-24 有一次真实误导——文档还写着「xhs 走 Just
# One API」，而那条链路对图文笔记返回空 data、文件也已删除。**配置错了不会报错，只会
# 静默降级**（不发请求、答案里说「没有实时站内检索」）。所以部署时必须把「模式、供应
# 商、token」三件事当场问清，宁可停下也不要上线一个安静的坏配置。

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

DRY_RUN=${DEPLOY_DRY_RUN:-0}
PORT=${DEPLOY_PORT:-3000}

step() { printf '\n=== %s\n' "$1"; }
fail() { printf '\n✗ %s\n' "$1" >&2; exit 1; }
run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '  (dry-run) %s\n' "$*"
  else
    "$@"
  fi
}

step "1/6 环境"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 22 ] || fail "需要 Node 22+（pi 运行时与仓库测试都依赖它），当前：$(node -v 2>/dev/null || echo '未安装 node')"
echo "  node $(node -v) · 仓库 $ROOT_DIR"
[ -f "$ROOT_DIR/.env" ] || fail ".env 不存在。复制 .env.example 为 .env，至少填 DEEPSEEK_API_KEY、XHS_API_TOKEN。"

step "2/6 校验 .env（不回显任何密钥）"
# 逻辑在 scripts/preflight.mjs，和 CI 发布时对新树跑的那次是同一份。
node "$ROOT_DIR/scripts/preflight.mjs" --env --env-file="$ROOT_DIR/.env"

step "3/6 取代码"
if ! git -C "$ROOT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  fail "这里不是 git 仓库——说明这棵树是 CI 发布的产物，不是 clone。
  生产服务器上的发布走 GitHub Actions（push 到 main 自动部署），不要再手工更新它：
    gh workflow run deploy.yml --ref main        # 重新发一次
    gh workflow run deploy.yml -f ref=<旧 commit>  # 回滚
  手工路径（在服务器上）：sh /srv/make-up-shared/deploy-remote.sh --rollback"
fi
if [ "${DEPLOY_SKIP_PULL:-0}" = "1" ]; then
  echo "  (按 DEPLOY_SKIP_PULL=1 跳过)"
else
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  echo "  当前分支：$BRANCH · 提交 $(git rev-parse --short HEAD)"
  if [ -n "${DEPLOY_BRANCH:-}" ] && [ "$BRANCH" != "$DEPLOY_BRANCH" ]; then
    fail "所在分支是 $BRANCH，期望 $DEPLOY_BRANCH。请先 git checkout $DEPLOY_BRANCH（脚本不替你切换，免得丢掉本机改动）。"
  fi
  if [ -n "$(git status --porcelain)" ]; then
    echo "  ! 工作区有未提交改动（下面 pull 可能失败）——服务器上通常不该有"
  fi
  run git fetch origin --quiet
  run git pull --ff-only
  run git log --oneline -1
fi

step "4/6 装依赖"
if [ "${DEPLOY_SKIP_INSTALL:-0}" = "1" ]; then
  echo "  (按 DEPLOY_SKIP_INSTALL=1 跳过)"
else
  run npm ci
fi

step "5/6 构建"
run npm run build

step "6/6 自检 + 重启"
if [ "${DEPLOY_SKIP_SELFCHECK:-0}" = "1" ]; then
  echo "  (按 DEPLOY_SKIP_SELFCHECK=1 跳过)"
else
  # 不发任何上游请求：只问扩展「你看到的数据源是什么」。
  node "$ROOT_DIR/scripts/preflight.mjs" --extension --env-file="$ROOT_DIR/.env" \
    || fail "扩展自检没过，先修好再重启。"
fi

# 怎么重启：自定义命令 > systemd 单元 > nohup（要显式开关）。
# nohup 兜底必须显式打开：它会起一个 systemd 之外的服务，:3000 被它占着时后续
# `systemctl start` 会 EADDRINUSE，而健康检查照样返回 200—— 于是一次「成功」的
# 部署其实还在跑旧代码。宁可停下，也不制造这种假绿。
restart_kind() {
  if [ -n "${DEPLOY_RESTART_CMD:-}" ]; then echo custom
  elif [ -n "${DEPLOY_SERVICE:-}" ]; then echo service
  elif [ "${DEPLOY_ALLOW_NOHUP:-0}" = "1" ]; then echo nohup
  else echo none
  fi
}

if [ "$DRY_RUN" = "1" ]; then
  printf '\n=== (dry-run) 跳过重启。真实执行时会：\n'
  case "$(restart_kind)" in
    custom) echo "  $DEPLOY_RESTART_CMD" ;;
    service) echo "  sudo systemctl restart $DEPLOY_SERVICE" ;;
    nohup) echo "  pkill -f next-server && nohup npm run start >> .local-data/server.log 2>&1 &" ;;
    none) echo "  (没有可用的重启方式——真实执行会在这里停下，让你设 DEPLOY_SERVICE / DEPLOY_RESTART_CMD / DEPLOY_ALLOW_NOHUP)" ;;
  esac
  printf '\n✓ 体检通过，没有任何改动。\n'
  exit 0
fi

step "重启服务"
case "$(restart_kind)" in
  custom) sh -c "$DEPLOY_RESTART_CMD" ;;
  service) sudo systemctl restart "$DEPLOY_SERVICE" ;;
  nohup)
    pkill -f next-server || true
    nohup npm run start >> "$ROOT_DIR/.local-data/server.log" 2>&1 &
    echo "  已用 nohup 启动（日志 .local-data/server.log）。"
    ;;
  none)
    fail "不知道该怎么重启。生产环境设 DEPLOY_SERVICE=<systemd 单元名>；本机开发想用 nohup 兜底就设 DEPLOY_ALLOW_NOHUP=1。"
    ;;
esac

printf '  等待 :%s 就绪… ' "$PORT"
if curl -sf --retry 25 --retry-delay 1 --retry-connrefused -o /dev/null "http://localhost:$PORT/"; then
  echo "HTTP 200 ✓"
else
  fail "服务起来后 $PORT 端口没响应，看日志：$ROOT_DIR/.local-data/server.log"
fi

printf '\n✓ 部署完成（%s · %s）\n' "$(git rev-parse --short HEAD)" "$(git rev-parse --abbrev-ref HEAD)"
cat <<'NOTE'
  提醒（避免再被旧文档带偏）：
  - xhs 的供应商是 TikHub；Just One 只用于淘宝卡片
  - 小红书取数不需要任何二进制或本地服务：没有浏览器、没有登录态、没有 npm run xhs:* 这类命令
  - 09-07 那份 MCP 接入 spec 已标 Superseded，它写的那条链路已经删了，别照着它操作
NOTE
