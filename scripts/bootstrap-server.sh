#!/bin/sh
set -eu

# 一次性把服务器从「手工 git pull → npm run build → npm run start」切成
# 「CI 发布产物 + systemd 托管」。以 root 跑，幂等，可以反复重跑。
#
#   scp scripts/bootstrap-server.sh scripts/deploy-remote.sh scripts/looktrace.service \
#       root@47.90.149.155:/tmp/
#   ssh root@47.90.149.155 'DEPLOY_PUBKEY="$(cat deploy_key.pub)" sh /tmp/bootstrap-server.sh'
#
# 做完之后发版靠 push 到 main；服务器不再构建、不再装依赖。
# 细节见 docs/specs/09-26-cicd-deploy.md。

LIVE=/srv/make-up
PREV=/srv/make-up.prev
SHARED=/srv/make-up-shared
DATA_DIR=$SHARED/.local-data
ENV_FILE=$SHARED/.env
UNIT=looktrace
APP_USER=admin
APP_GROUP=admin
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

step() { printf '\n=== %s\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }
warn() { printf '  ! %s\n' "$1"; }
fail() { printf '\n✗ %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" = "0" ] || fail "要以 root 跑（sudo sh $0）"
[ -d "$LIVE" ] || fail "$LIVE 不存在——这台机器上还没部署过 looktrace？"
command -v node >/dev/null || fail "没装 node"
NODE_BIN=$(command -v node)

# ---------------------------------------------------------------- 1. 目录

step "1/7 目录与权限"
# /srv 是 root 所有，admin 在里面既不能建目录也不能改名。这两个目录必须 root 先建好
# 并交给 admin，之后 CI 才可能用普通用户把它换掉。
install -d -o "$APP_USER" -g "$APP_GROUP" -m 700 "$SHARED"
install -d -o "$APP_USER" -g "$APP_GROUP" "$PREV"
ok "$SHARED（700，放 .env 和用户数据）"
ok "$PREV（rsync 目标 + 回滚源）"

# ---------------------------------------------------------------- 2. 停服

step "2/7 停掉手工起的进程"
systemctl stop "$UNIT" 2>/dev/null || true
pkill -f "next-server" 2>/dev/null || true
# 死代码：xhs-mcp 那条链路已经从仓库删了，但进程还在监听公网 :18060，无鉴权。
# 两个名字都要匹配：/bin/sh /srv/make-up/scripts/xhs-mcp-server 是父进程，
# .../xiaohongshu-mcp/bin/xiaohongshu-mcp-linux-amd64 是它拉起来的真正服务。
# 必须**先杀进程再删文件**——/bin/sh 是按路径逐行读脚本的，文件先没了它会行为异常。
pkill -f "xiaohongshu-mcp|xhs-mcp" 2>/dev/null || true
sleep 1
ok "已停"

# ---------------------------------------------------------------- 3. 迁移用户数据

step "3/7 把 .env 和用户数据挪到 $SHARED"

migrate() {
  src=$1
  dst=$2
  if [ -L "$src" ]; then
    ok "$src 已经是软链，跳过"
    return 0
  fi
  if [ ! -e "$src" ]; then
    ok "$src 不存在，跳过"
    return 0
  fi
  if [ -e "$dst" ]; then
    fail "$src 和 $dst 同时存在。先自己比对一下哪份是新的，手工合完再重跑。"
  fi
  mv "$src" "$dst"
  ok "$src → $dst"
}

migrate "$LIVE/.env" "$ENV_FILE"
migrate "$LIVE/.local-data" "$DATA_DIR"

# 两个软链都建：.local-data 那个是为了让**回滚到本次改动之前的 commit**时，只认
# <cwd>/.local-data 的老代码也能读到同一份数据。
for pair in "$LIVE/.env:$ENV_FILE" "$LIVE/.local-data:$DATA_DIR"; do
  link=${pair%%:*}
  target=${pair#*:}
  [ -L "$link" ] && [ "$(readlink -f "$link")" = "$target" ] && continue
  [ -e "$link" ] && [ ! -L "$link" ] && fail "$link 是真实文件/目录，不是软链。手工看一眼再重跑。"
  rm -f -- "$link"
  ln -s "$target" "$link"
  ok "$link → $target"
done

[ -f "$ENV_FILE" ] || fail "$ENV_FILE 不存在。把 .env 放进去再重跑。"
[ -d "$DATA_DIR" ] || fail "$DATA_DIR 不存在"

# ---------------------------------------------------------------- 4. .env 补两个变量

step "4/7 确认 .env 里的数据目录配置"
# 新代码认 LOOKTRACE_DATA_DIR，pi 认 PI_CODING_AGENT_DIR。缺了任何一个，应用会在
# cwd 下新建一个空的 .local-data：页面照常 200，历史对话和收藏全没了。这是本次
# 改动里最贵的一种静默故障。
set_env_var() {
  key=$1
  value=$2
  if grep -qE "^[[:space:]]*${key}=" "$ENV_FILE"; then
    tmp="$ENV_FILE.tmp.$$"
    sed "s|^[[:space:]]*${key}=.*|${key}=\"${value}\"|" "$ENV_FILE" > "$tmp"
    cat "$tmp" > "$ENV_FILE"   # 用 cat 覆盖而不是 mv，保住原文件的属主和权限
    rm -f "$tmp"
    ok "$key 已更新"
  else
    printf '\n%s="%s"\n' "$key" "$value" >> "$ENV_FILE"
    ok "$key 已写入"
  fi
}
set_env_var LOOKTRACE_DATA_DIR "$DATA_DIR"
set_env_var PI_CODING_AGENT_DIR "$DATA_DIR/pi"

# ---------------------------------------------------------------- 5. systemd

step "5/7 安装 systemd 单元"
[ -f "$SCRIPT_DIR/looktrace.service" ] || fail "找不到 $SCRIPT_DIR/looktrace.service（和本脚本放在一起 scp 过来）"
sed "s|^ExecStart=/usr/bin/node |ExecStart=${NODE_BIN} |" \
  "$SCRIPT_DIR/looktrace.service" > "/etc/systemd/system/${UNIT}.service"
systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null
ok "/etc/systemd/system/${UNIT}.service（ExecStart 用 $NODE_BIN）"

# ---------------------------------------------------------------- 6. 远端脚本 + 公钥

step "6/7 装远端发布脚本和部署公钥"
[ -f "$SCRIPT_DIR/deploy-remote.sh" ] || fail "找不到 $SCRIPT_DIR/deploy-remote.sh（和本脚本放在一起 scp 过来）"
install -o "$APP_USER" -g "$APP_GROUP" -m 755 "$SCRIPT_DIR/deploy-remote.sh" "$SHARED/deploy-remote.sh"
ok "$SHARED/deploy-remote.sh"

if [ -n "${DEPLOY_PUBKEY:-}" ]; then
  install -d -o "$APP_USER" -g "$APP_GROUP" -m 700 "/home/$APP_USER/.ssh"
  touch "/home/$APP_USER/.ssh/authorized_keys"
  chown "$APP_USER:$APP_GROUP" "/home/$APP_USER/.ssh/authorized_keys"
  chmod 600 "/home/$APP_USER/.ssh/authorized_keys"
  if grep -qF "$DEPLOY_PUBKEY" "/home/$APP_USER/.ssh/authorized_keys"; then
    ok "部署公钥已存在"
  else
    printf '%s\n' "$DEPLOY_PUBKEY" >> "/home/$APP_USER/.ssh/authorized_keys"
    ok "部署公钥已加入"
  fi
else
  warn "没给 DEPLOY_PUBKEY，跳过。CI 连不上服务器，补上后重跑："
  warn "  ssh root@… 'DEPLOY_PUBKEY=\"ssh-ed25519 AAAA…\" sh $0'"
fi

# ---------------------------------------------------------------- 7. 清死代码 + 起服

step "7/7 清死代码并启动"
# 那两份 staged unit 在 .local-data/systemd/ 下，而 systemctl --user 根本不读那个
# 路径——它们是惰性的，直接删。
rm -rf -- "$DATA_DIR/xhs-mcp"
rm -f -- "$DATA_DIR/systemd/xhs-mcp.service" "$DATA_DIR/systemd/looktrace.service"
rmdir "$DATA_DIR/systemd" 2>/dev/null || true
ok "已删 xhs-mcp 的进程、数据和 staged unit"

systemctl reset-failed "$UNIT" 2>/dev/null || true
systemctl start "$UNIT"
printf '  等待 :3000 就绪… '
if curl -sf --retry 25 --retry-delay 1 --retry-connrefused -o /dev/null "http://127.0.0.1:3000/"; then
  echo "HTTP 200 ✓"
else
  fail ":3000 没起来，看 journalctl -u $UNIT -n 50"
fi

cat <<'NOTE'

✓ 服务器侧初始化完成。接下来：

  1. 在 GitHub 仓库（origin）的 Settings → Secrets and variables → Actions 里加：
       DEPLOY_SSH_KEY         部署私钥（ed25519，公钥已经装在这台机器上）
       DEPLOY_HOST            47.90.149.155
       DEPLOY_USER            admin
       DEPLOY_SSH_KNOWN_HOSTS 先跑 ssh-keyscan 47.90.149.155 取回来
  2. push 一个 commit 到 main，或手动跑 workflow：deploy.yml

发版前请先读 docs/specs/09-26-cicd-deploy.md，里面写了为什么路径一个字都不能变。
NOTE
