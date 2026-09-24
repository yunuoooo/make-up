#!/bin/sh
set -eu

# 部署 looktrace：拉代码 → 装依赖 → 校验 .env → 构建 → 自检 → 重启。
#
# 用法（在仓库里或任意目录都能跑，脚本自己 cd 到仓库根）：
#   ./scripts/deploy.sh
#   DEPLOY_DRY_RUN=1 ./scripts/deploy.sh     # 只体检，不动任何东西（推荐先跑这个）
#
# 可覆盖的环境变量：
#   DEPLOY_BRANCH         期望所在分支；不一致就停下（不自动切换，避免丢本机改动）
#   DEPLOY_SERVICE        systemd 单元名；给了就用 sudo systemctl restart
#   DEPLOY_RESTART_CMD    自定义重启命令（优先级最高）
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
# 只报「有没有」和「指向哪里」，绝不打印值。
node --env-file="$ROOT_DIR/.env" -e '
const problems = [];
const warn = [];
const mode = (process.env.XHS_SOURCE_MODE ?? "").trim();
if (mode !== "api") {
  problems.push(`XHS_SOURCE_MODE 期望 "api"，实际是 "${mode || "(空)"}"。TikHub 是唯一的取数链路：其它值会让整条链路静默降级——不发请求，也不伪装成真实来源。`);
}
const token = (process.env.XHS_API_TOKEN ?? "").trim();
if (!token) problems.push("XHS_API_TOKEN 为空：整条取数链路会静默降级，一次上游请求都不发。");
const base = (process.env.XHS_API_BASE_URL ?? "").trim();
if (base && !base.includes("tikhub.io")) problems.push(`XHS_API_BASE_URL 指向 ${base}，但 xhs 的供应商现在是 TikHub（api.tikhub.io）。`);
if (!(process.env.DEEPSEEK_API_KEY ?? "").trim() && !(process.env.OPENAI_API_KEY ?? "").trim()) {
  warn.push("没有 DEEPSEEK_API_KEY / OPENAI_API_KEY：除非你显式配了别的 PI_PROVIDER，否则模型跑不起来。");
}
if (problems.length) {
  console.error("✗ .env 有 " + problems.length + " 个问题：");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
const limit = (process.env.XHS_API_DETAIL_LIMIT ?? "10").trim();
const cards = (process.env.TAOBAO_CARDS_ENABLED ?? "false").trim();
console.log(`  ✓ xhs: api 模式 → ${base || "https://api.tikhub.io"}（token 已配置，详情上限 ${limit} 篇）`);
console.log(`  ✓ 淘宝卡片: ${cards === "true" || cards === "1" ? "开（一轮最多 8 张，按次计费）" : "关"}`);
for (const w of warn) console.log("  ! " + w);
'

step "3/6 取代码"
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
  SELFCHECK=$(node --env-file="$ROOT_DIR/.env" --input-type=module -e '
import { createExtensionRuntime } from "@earendil-works/pi-coding-agent";
import { loadExtensions } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
const r = await loadExtensions([".pi/extensions/xhs-source.ts"], process.cwd(), undefined, createExtensionRuntime());
const tools = [...r.extensions[0].tools.values()].map((t) => t.definition ?? t);
const status = await tools.find((t) => t.name === "xhs_source_status").execute("deploy-check", {});
console.log(`errors=${r.errors.length} ${status.content[0].text}`);
')
  echo "  $SELFCHECK"
  case "$SELFCHECK" in
    *"errors=0"*) : ;;
    *) fail "扩展加载失败（errors 非 0），先修好再重启。" ;;
  esac
  case "$SELFCHECK" in
    *'"mode":"api"'*'"configured":true'*) : ;;
    *) fail "扩展没读到 api 模式的凭据——重启也不会生效，回去看第 2 步。" ;;
  esac
fi

if [ "$DRY_RUN" = "1" ]; then
  printf '\n=== (dry-run) 跳过重启。真实执行时会：\n'
  if [ -n "${DEPLOY_RESTART_CMD:-}" ]; then echo "  $DEPLOY_RESTART_CMD"
  elif [ -n "${DEPLOY_SERVICE:-}" ]; then echo "  sudo systemctl restart $DEPLOY_SERVICE"
  else echo "  pkill -f next-server && nohup npm run start >> .local-data/server.log 2>&1 &"
  fi
  printf '\n✓ 体检通过，没有任何改动。\n'
  exit 0
fi

step "重启服务"
if [ -n "${DEPLOY_RESTART_CMD:-}" ]; then
  sh -c "$DEPLOY_RESTART_CMD"
elif [ -n "${DEPLOY_SERVICE:-}" ]; then
  sudo systemctl restart "$DEPLOY_SERVICE"
else
  # 兜底：没有 systemd 的机器（本机开发也走这条）。.env 只在启动时读，所以必须重启。
  pkill -f next-server || true
  nohup npm run start >> "$ROOT_DIR/.local-data/server.log" 2>&1 &
  echo "  已用 nohup 启动（日志 .local-data/server.log）。生产环境建议改用 DEPLOY_SERVICE=… 交给 systemd。"
fi

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
