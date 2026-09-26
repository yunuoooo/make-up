#!/bin/sh
set -eu

# 在服务器上执行一次发布：前置检查 → 停服 → 换目录 → 起服 → 健康检查 → 失败自动回滚。
# 它自己**不构建、不装依赖** —— 产物由 CI 构建好后 rsync 过来，这里只搬目录。
#
#   sh /srv/make-up-shared/deploy-remote.sh <sha>       # 发布已经 rsync 到 $PREV 的那棵树
#   sh /srv/make-up-shared/deploy-remote.sh --rollback  # 把 $PREV 换回来
#
# 这份脚本被装到 $SHARED 下（bootstrap 的时候放），不是放在发布树里 —— 它要 mv 掉发布
# 树自己所在的目录，放在树里会被 rsync --delete 删掉、也会在换目录时被改名。
#
# 为什么 $LIVE 的路径一个字都不能变：lib/pi/session.ts 按 cwd 的**绝对路径**给会话目录
# 命名，而 Node 的 process.cwd() 会解析软链。所以不能用 releases/<sha> + current 软链那
# 套——那样每次发版所有历史对话都会静默消失。

LIVE=/srv/make-up
PREV=/srv/make-up.prev
SHARED=/srv/make-up-shared
UNIT=looktrace
PORT=3000
DATA_DIR=$SHARED/.local-data
ENV_FILE=$SHARED/.env
LOCK_FILE=$SHARED/deploy.lock

# 会话目录名跟着 $LIVE 走，所以现算而不是写死。
PROJECT_DIR="--$(printf '%s' "$LIVE" | sed 's|^/||; s|[/:]|-|g')--"

step() { printf '\n=== %s\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '\n✗ %s\n' "$1" >&2; exit 1; }

port_pid() {
  ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2
}

count_sessions() {
  [ -d "$DATA_DIR/pi/sessions/$PROJECT_DIR" ] || { echo 0; return; }
  ls -1 "$DATA_DIR/pi/sessions/$PROJECT_DIR" 2>/dev/null | wc -l | tr -d ' '
}

# 换 LIVE <-> PREV。三次 rename 全在同文件系统内，是瞬时的。
# 必须 -T：目标存在时普通 mv 会把源**塞进**目标里（变成 $TMP/make-up）。
# 必须 sudo：/srv 是 root 所有，admin 在它里面改名要靠权限。
swap() {
  TMP=$SHARED/.swap-tmp
  [ -e "$TMP" ] && fail "$TMP 还在，说明上一次换目录没走完。看一眼再重跑。"
  sudo mv -T "$LIVE" "$TMP" || fail "换目录第 1 跳失败"
  sudo mv -T "$PREV" "$LIVE" || {
    sudo mv -T "$TMP" "$LIVE" || fail "第 2 跳失败且还原失败：线上树在 $TMP，手工 mv -T $TMP $LIVE"
    fail "换目录第 2 跳失败，已还原原状"
  }
  sudo mv -T "$TMP" "$PREV" || fail "换目录第 3 跳失败（线上已是新版，旧版在 $TMP）"
}

# 把 $LIVE 下的 .env 和 .local-data 都做成指向 $SHARED 的软链。
#
# .local-data 这个软链看起来多余（新代码认 LOOKTRACE_DATA_DIR），但**留着**：回滚到
# 本次改动之前的 commit 时，老代码只认 <cwd>/.local-data，那时它就是用户数据不丢的
# 唯一保证。新旧两条路径指向同一份数据，来回切都安全。
#
# 遇到真目录/真文件一律**停下**，绝不 rm —— 那里面可能是全部历史对话。
ensure_link() {
  path=$1
  target=$2
  if [ -L "$path" ]; then
    [ "$(readlink -f "$path")" = "$target" ] && return 0
    rm -f -- "$path"   # 删软链只删链接本身，不动目标
  elif [ -e "$path" ]; then
    fail "$path 是真实的$( [ -d "$path" ] && echo 目录 || echo 文件 )，不是软链。停手，先自己看一眼：这里面可能是用户数据。"
  fi
  ln -s "$target" "$path"
  [ "$(readlink -f "$path")" = "$target" ] || fail "$path 软链没建对"
}

ensure_links() {
  ensure_link "$LIVE/.env" "$ENV_FILE"
  ensure_link "$LIVE/.local-data" "$DATA_DIR"
}

problems=""
note() { problems="$problems
  - $1"; }

# 健康检查。光看 HTTP 200 是不够的：首页是静态 server component，谁在服务这个端口
# 都会返回 200。必须确认服务的进程就是本次发布的这棵树。
health_check() {
  problems=""
  curl -sf --retry 25 --retry-delay 1 --retry-connrefused -o /dev/null "http://127.0.0.1:$PORT/" \
    || note "http://127.0.0.1:$PORT/ 没有返回 2xx"

  pid=$(port_pid)
  if [ -z "$pid" ]; then
    note "没有进程在监听 :$PORT"
  else
    # 换目录时活下来的老进程，cwd 会跟着旧目录走到 $PREV，会话目录名也跟着变——它服务
    # 的每一条回答都会被写进一个下次发版就作废的目录里。
    cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || echo "")
    [ "$cwd" = "$LIVE" ] || note ":$PORT 的进程 pid=$pid 的 cwd 是 ${cwd:-读不到}，不是 $LIVE"
    if [ -r "/proc/$pid/cgroup" ]; then
      grep -q "$UNIT" "/proc/$pid/cgroup" || note "pid=$pid 不属于 $UNIT 的 cgroup（不是 systemd 管的）"
    fi
  fi

  # 可执行位丢了是静默故障：lib/pi/bridge.ts 用的是 access(piBin)（F_OK 不是 X_OK），
  # 检查会过，到 spawn 才失败，而首页照样 200。
  [ -x "$LIVE/node_modules/.bin/pi" ] || note "$LIVE/node_modules/.bin/pi 不可执行"
  [ "$(readlink -f "$LIVE/.env")" = "$ENV_FILE" ] || note "$LIVE/.env 没指向 $ENV_FILE"
  [ "$(readlink -f "$LIVE/.local-data")" = "$DATA_DIR" ] || note "$LIVE/.local-data 没指向 $DATA_DIR"

  now=$(count_sessions)
  [ "$now" -ge "$sessions_before" ] \
    || note "会话文件从 $sessions_before 掉到 $now —— 用户数据没接上"

  for f in "$DATA_DIR"/*.json; do
    [ -e "$f" ] || continue
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$f" 2>/dev/null \
      || note "$f 解析不了（写入被截断了）"
  done

  [ -z "$problems" ]
}

# 只返回状态，不在这里 fail：起不来也必须走回滚，不能把线上留在一棵起不来的树上。
start_unit() {
  # StartLimitBurst 触发后 unit 会停在 failed，不 reset-failed 的话 start 直接拒绝。
  sudo systemctl reset-failed "$UNIT" 2>/dev/null || true
  sudo systemctl start "$UNIT" 2>/dev/null
}

# ---------------------------------------------------------------- 入口

MODE=${1:-}
case "$MODE" in
  --rollback) ;;
  ""|-h|--help) echo "用法：$0 <sha> | --rollback"; exit 2 ;;
  *) ;;
esac

[ -d "$SHARED" ] || fail "$SHARED 不存在。先在服务器上跑 scripts/bootstrap-server.sh。"
[ -d "$LIVE" ] || fail "$LIVE 不存在"
[ -f "$PREV/.next/BUILD_ID" ] || fail "$PREV 不像一个完整的构建产物（没有 .next/BUILD_ID）。rsync 跑成了吗？"

# 手动跑和 CI 跑撞在一起会同时往 $PREV 里写、同时换目录，结果是一棵混合的树，
# 连回滚源都被毁掉。workflow 里的 concurrency 只能挡住 CI 之间，这一层挡手工。
exec 9>"$LOCK_FILE" || fail "打不开锁文件 $LOCK_FILE"
flock -n 9 || fail "另一个部署正在跑。等它结束再重试。"

sessions_before=$(count_sessions)

if [ "$MODE" = "--rollback" ]; then
  # 被标记过的是发布失败的树，别让人手工又把它换上来。
  [ -e "$PREV/.deploy-failed" ] \
    && fail "$PREV 是上次发布失败被换下来的树，不能拿来回滚。重新推一个 commit。"
  step "回滚到 $PREV（当前会话文件 $sessions_before 个）"
else
  step "1/5 对新树跑前置检查（线上一个字节还没动）"
  ( cd "$PREV" && node scripts/preflight.mjs --env --env-file="$ENV_FILE" ) \
    || fail ".env 校验没过，中止"
  ( cd "$PREV" && node scripts/preflight.mjs --data-dir="$DATA_DIR" --env-file="$ENV_FILE" ) \
    || fail "用户数据目录配置不对，中止"
  # 不发任何上游请求：只问扩展「你看到的数据源是什么」。
  ( cd "$PREV" && node scripts/preflight.mjs --extension --env-file="$ENV_FILE" ) \
    || fail "扩展自检没过，中止；线上树一个字节没动"
fi

step "停服"
sudo systemctl stop "$UNIT" 2>/dev/null || true
# 手工起过的、或上一次没管住的进程：:3000 被它们占着的话 systemctl start 会
# EADDRINUSE，而健康检查照样 200 ——「成功」的部署其实还在跑旧代码。
pkill -f "next-server" 2>/dev/null || true
# 注意模式要写 .bin/pi 指向的真实路径：node_modules/.bin/pi 是软链，进程的 cmdline
# 里出现的是解析后的 bundle。
pkill -f "$LIVE/node_modules/@earendil-works/pi-coding-agent" 2>/dev/null || true
i=0
while [ "$i" -lt 20 ]; do
  [ -z "$(port_pid)" ] && break
  sleep 1
  i=$((i + 1))
done
holder=$(port_pid)
[ -z "$holder" ] || fail ":$PORT 还被 pid $holder 占着，不敢换目录。先手工看清楚那是什么进程。"
ok ":$PORT 已释放"

step "换目录"
swap
ensure_links
ok "已切换（被换下去的那份在 $PREV）"

step "起服"
start_failed=0
if ! start_unit; then
  start_failed=1
  problems="
  - systemctl start $UNIT 失败"
  printf '\n✗ %s 起不来\n' "$UNIT"
fi

step "健康检查"
if [ "$start_failed" = "0" ] && health_check; then
  ok "HTTP 200 且服务的确实是 $LIVE"
else
  [ "$start_failed" = "1" ] || printf '\n✗ 健康检查没过：\n%s\n' "$problems"
  step "自动回滚"
  swap
  ensure_links
  if start_unit && health_check; then
    # 标记这棵树坏掉，防止有人手工 --rollback 又把它换上来。下一次 rsync 会
    # 用 --delete 顺手删掉它（源里没有这个文件）。
    : > "$PREV/.deploy-failed"
    fail "新版本没通过（起服或健康检查），已回滚到上一版，旧版仍在服务。看 journalctl -u $UNIT -n 80。"
  fi
  fail "回滚后仍然不过 —— 手工介入：journalctl -u $UNIT -n 100"
fi

# 记一笔「现在跑的是哪个 commit」，出问题的时候不用去猜。
# 回滚模式下 $LIVE 是换回来的旧版，$PREV 是原来的新版，两者都是好的。
BUILD_ID=$(cat "$LIVE/.next/BUILD_ID" 2>/dev/null || echo '?')
if [ "$MODE" = "--rollback" ]; then
  # 换回来之后 $PREV 才是刚被换下去的那个，它的 BUILD_ID 是「原来的新版」。
  printf '%s\n' "rollback → BUILD_ID ${BUILD_ID}（换下 BUILD_ID $(cat "$PREV/.next/BUILD_ID" 2>/dev/null || echo '?')）" \
    > "$SHARED/last-deploy.txt"
else
  printf '%s\n' "$MODE → BUILD_ID ${BUILD_ID}" > "$SHARED/last-deploy.txt"
fi
printf '\n✓ %s 完成 · BUILD_ID %s\n' \
  "$([ "$MODE" = "--rollback" ] && echo 回滚 || echo 发布)" "$BUILD_ID"
