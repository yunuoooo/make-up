#!/bin/sh
set -eu

# 只切换生产淘宝开关，不构建或替换发布树。与部署共用锁，失败恢复原配置。
case "${1:-}" in
  true|false) ENABLED=$1 ;;
  *) echo "用法：$0 true|false" >&2; exit 2 ;;
esac

LIVE=/srv/make-up
SHARED=/srv/make-up-shared
ENV_FILE=$SHARED/.env
UNIT=looktrace

fail() { printf '%s\n' "$1" >&2; exit 1; }
exec 9>"$SHARED/deploy.lock"
flock -n 9 || fail "另一个部署正在运行，请稍后重试。"
[ "$(readlink -f "$LIVE/.env")" = "$ENV_FILE" ] || fail "生产 .env 软链不正确。"
sudo -n systemctl is-active --quiet "$UNIT" || fail "生产服务当前未运行。"

check_idle() {
  pid=$(systemctl show "$UNIT" -p MainPID --value)
  if pgrep -P "$pid" >/dev/null 2>&1 || [ -n "$(ss -tnH state established '( sport = :3000 )')" ]; then
    fail "当前有请求或 Agent 正在运行，本次未重启服务，请稍后重试。"
  fi
}

health_check() {
  curl -fsS --max-time 3 --retry 20 --retry-delay 1 --retry-connrefused \
    -o /dev/null http://127.0.0.1:3000/ || return 1
  sudo -n systemctl is-active --quiet "$UNIT" || return 1
  pid=$(systemctl show "$UNIT" -p MainPID --value)
  [ "$(readlink -f "/proc/$pid/cwd")" = "$LIVE" ] || return 1
  ss -ltnpH 'sport = :3000' | grep -q "pid=$pid," || return 1
}

check_idle
umask 077
BACKUP=$(mktemp "$SHARED/.env.bak-taobao.XXXXXX")
CANDIDATE=$(mktemp "$SHARED/.env.taobao.XXXXXX")
cp "$ENV_FILE" "$BACKUP"
APPLIED=0
cleanup() {
  status=$?
  trap - 0
  if [ "$status" -ne 0 ] && [ "$APPLIED" = 1 ]; then
    printf '%s\n' "检查未通过，正在恢复原配置。" >&2
    if cp "$BACKUP" "$CANDIDATE" && mv -f "$CANDIDATE" "$ENV_FILE" \
      && sudo -n systemctl restart "$UNIT" && health_check; then
      printf '%s\n' "原配置已恢复，服务正常。" >&2
    else
      printf '%s\n' "恢复失败，需要检查 looktrace.service。备份：$BACKUP" >&2
    fi
  fi
  rm -f "$CANDIDATE"
  exit "$status"
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

node --input-type=module - "$ENV_FILE" "$CANDIDATE" "$ENABLED" <<'NODE'
import fs from "node:fs";
import assert from "node:assert/strict";
import { parseEnv } from "node:util";

const [source, target, enabled] = process.argv.slice(2);
const text = fs.readFileSync(source, "utf8");
const before = parseEnv(text);
if (enabled === "true" && !before.TAOBAO_API_TOKEN?.trim()) {
  throw new Error("TAOBAO_API_TOKEN 未配置，未修改开关。");
}
const pattern = /^[ \t]*(?:export[ \t]+)?TAOBAO_CARDS_ENABLED[ \t]*=[^\r\n]*/gm;
const matches = [...text.matchAll(pattern)];
assert.ok(matches.length <= 1, "淘宝开关有重复定义，未修改配置。");
const line = `TAOBAO_CARDS_ENABLED="${enabled}"`;
const next = matches.length ? text.replace(pattern, line) : `${text}${text.endsWith("\n") ? "" : "\n"}${line}\n`;
const after = parseEnv(next);
assert.equal(after.TAOBAO_CARDS_ENABLED, enabled);
delete before.TAOBAO_CARDS_ENABLED;
delete after.TAOBAO_CARDS_ENABLED;
const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
assert.ok([...keys].every((key) => before[key] === after[key]), "其它配置不得改变。");
fs.writeFileSync(target, next, { mode: 0o600 });
console.log(`准备设置 TAOBAO_CARDS_ENABLED=${enabled}，其它配置保持一致。`);
NODE

cd "$LIVE"
node scripts/preflight.mjs --env --env-file="$CANDIDATE"
check_idle
APPLIED=1
mv -f "$CANDIDATE" "$ENV_FILE"
sudo -n systemctl restart "$UNIT"
health_check || fail "重启后的健康检查失败。"

# 使用 Next 的真实环境加载顺序，避免 .env.local 等覆盖导致开关没有生效。
node --experimental-strip-types --input-type=module - "$ENABLED" <<'NODE'
import nextEnv from "@next/env";
import { createTaobaoClient, productCardsEnabled } from "./lib/commerce/taobao.ts";
nextEnv.loadEnvConfig(process.cwd(), false);
const expected = process.argv[2] === "true";
const enabled = productCardsEnabled();
const configured = createTaobaoClient().configured;
if (enabled !== expected || (expected && !configured)) {
  throw new Error("Next 实际读取的淘宝配置不符合预期。");
}
console.log(JSON.stringify({ enabled, configured, service: "active", http: 200 }));
NODE
APPLIED=0
printf '淘宝推荐已设为 %s，服务健康。原配置备份：%s\n' "$ENABLED" "$BACKUP"
