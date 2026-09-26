# 09-26 CI/CD 部署：CI 构建，服务器只换目录

## 1. 目标

push 到 `main` → GitHub Actions 构建 → 产物送到 `47.90.149.155` → **服务器不构建、不装依赖**，只做「换目录 + 重启」。

改之前是 SSH 上服务器手工 `git pull` → `npm run build` → `npm run start`。1.6GB 内存的轻量机跑 Next 构建很吃力，进程没有托管，构建失败或中断还会在线上留下半成品。

## 2. 三条硬约束（决定了架构长什么样）

这三条是从代码里读出来的，不是偏好。违反任何一条都是**静默**故障，不会报错。

### 2.1 `/srv/make-up` 这个路径一个字都不能变

- `lib/storage/json-store.ts` 原来用 `path.join(process.cwd(), ".local-data")`
- `lib/pi/session.ts` 按 cwd 的**绝对路径**生成会话目录名（服务器上是 `--srv-make-up--`）
- Node 的 `process.cwd()` **会解析软链**

所以常见的 `releases/<sha>` + `current` 软链那套在这里是错的：cwd 会变成 `/srv/.../releases/<sha>`，会话目录名跟着变，**所有历史对话静默消失**，而且界面只会提示「会话已过期，从头开始」。

结论：原地换目录，不换路径。

### 2.2 只能单实例

`lib/pi/conversation-lock.ts` 是**进程内**互斥锁（同会话并发返回 409）。多实例需要外部锁，所以不能做蓝绿双实例。

结论：重启必然「先停后起」，约 5 秒中断。正在生成的回答会被截断，**别在有人提问时发版**。

### 2.3 运行时需要仓库里的源文件，不只是 `.next`

- `lib/pi/bridge.ts` 用 `join(cwd, "node_modules", ".bin", "pi")` 找 pi 二进制
- `.pi/extensions/xhs-source.ts` 通过 pi 的 jiti 加载器**直接 import `lib/xhs/tikhub.ts` / `lib/xhs/types.ts` 的 TypeScript 源码**，还要从 node_modules 解析 `typebox`

`output: 'standalone'` 的文件追踪覆盖不到这些，坏掉是静默的（首页照样 200）。**不要**为了省体积改成 standalone。

## 3. 体积：为什么用 rsync 增量

| 内容 | 压缩后 | 变化频率 |
| --- | --- | --- |
| `.next`（去掉 `.next/cache`） | 0.8 MB | 每次 |
| 跟踪的源码树（`git archive HEAD`） | 1.45 MB | 每次 |
| `node_modules` | 137 MB | 只在 lockfile 变时 |

`.next` 本地 150MB 里 **146MB 是 webpack 构建缓存**，运行时一点都用不到。

## 4. 服务器布局

```text
/srv/make-up          发布树（cwd，路径永不变）。.env 和 .local-data 是指向 shared 的软链
/srv/make-up.prev     上一个版本 —— 同时是下一次 rsync 的增量基准和回滚源
/srv/make-up-shared/  .env（真文件，700）+ .local-data/（真目录）+ deploy-remote.sh + deploy.lock
```

用户数据**不在发布树里**，靠 `.env` 里的两个变量指出去：

- `LOOKTRACE_DATA_DIR=$SHARED/.local-data`（`lib/storage/json-store.ts` 读）
- `PI_CODING_AGENT_DIR=$SHARED/.local-data/pi`（`lib/pi/bridge.ts` 读）

发布树里仍然保留 `.local-data` 软链，看起来多余，但**是故意的**：回滚到本次改动之前的 commit 时，老代码只认 `<cwd>/.local-data`，那条软链就是用户数据不丢的唯一保证。新旧两条路径指向同一份数据，来回切都安全。

## 5. 部署流程

1. **CI**（`ubuntu-24.04` 固定，Node `22.23.2` 与服务器一致）：`npm ci` → `npm run build` → `npm run typecheck` → `npm test`
   - typecheck 必须在 build **之后**：`tsconfig.json` 把 `.next/types/**/*.ts` 也算进来，先跑会静默跳过 Next 的路由类型校验。
   - 不需要任何密钥（仓库里没有 `NEXT_PUBLIC_*`）。
   - **不经过 `actions/upload-artifact`**：它重新打包会丢掉可执行位和软链。`node_modules/.bin/pi` 正是软链，可执行位丢了要到运行时 `spawn` 才炸（`lib/pi/bridge.ts` 用的是 `access()`，即 `F_OK` 不是 `X_OK`），而首页照样 200。
2. **rsync** 到 `admin@…:/srv/make-up.prev/`：`-rlptD --no-owner --no-group --delete --exclude=.env --exclude=.local-data`
   - 不能用 `-a`：它隐含 `-o -g`，非 root 的接收端 `chown` 会 `EPERM` 并以退出码 23 失败。
   - 命令行 `--exclude` 在接收端同样生效，所以 `--delete` 不会删掉它们。不加 `--delete-excluded`。
   - 此时服务**仍在跑旧版本**。
3. **`scripts/deploy-remote.sh`**（装在 `$SHARED` 下，每次发布由 CI 同步过去）：
   - `flock` 独占锁 —— 挡 CI 和手工并发（workflow 的 `concurrency` 只挡得住 CI 之间）
   - **前置检查**跑在**新树**上，不过就中止，线上一个字节没动
   - 停服 → 确认 `:3000` 已释放
   - 三次 `mv -T` 原子换目录（必须 `-T`：目标存在时普通 `mv` 会嵌套；必须 `sudo`：`/srv` 是 root 所有）
   - 补软链 → `reset-failed` → `systemctl start`
   - 健康检查（见 §6）→ 不过就换回去重启

停服窗口 = 三次 rename（同文件系统，瞬时）+ Next 启动（约 1 秒）。

## 6. 健康检查为什么不止看 200

首页是静态 server component，**谁在服务这个端口都会返回 200**。所以除了 `curl`，还必须断言：

| 断言 | 防的是什么 |
| --- | --- |
| `:3000` 持有者的 `readlink -f /proc/$pid/cwd` == `/srv/make-up` | 换目录时活下来的老进程 cwd 会跟着旧目录走到 `.prev`，它写出的每一条会话都会落进一个下次发版就作废的目录 |
| 该 pid 属于 `looktrace.service` 的 cgroup | 手工 `nohup` 起的孤儿进程占着端口，`systemctl start` 会 EADDRINUSE，而检查照样「通过」——部署显示绿的，跑的是旧代码 |
| `node_modules/.bin/pi` 可执行 | 见 §5 第 1 条 |
| `.env` / `.local-data` 软链指向 `$SHARED` | 数据没接上 |
| 会话文件数没减少 | 用户数据没接上（最贵的一种静默故障） |
| `$SHARED/.local-data/*.json` 能解析 | 见 §7 |

**前端检查**（`scripts/preflight.mjs`，由 `deploy.sh` 和 `deploy-remote.sh` 共用）刻意保留了两段原 `deploy.sh` 的检查，它们抓的是这个项目最典型的事故：**配置错了不报错，只是静默降级**（不发上游请求、答案里说「没有实时站内检索」）。抽成一份而不是各抄一遍，就是因为抄两份必然会漂。

## 7. 配套的代码改动

`lib/storage/json-store.ts` 两处：

1. `LOOKTRACE_DATA_DIR` 覆盖 —— 让用户数据离开发布树。
2. **写 `.tmp` + `rename` 替换裸 `writeFile`**。这是个已存在的数据丢失 bug：`readJson` 读失败会**静默返回 fallback**，而 `user-products.ts` 是「读-改-写」，所以一次 SIGTERM 截断文件 → 读成 `[]` → 下次写入把 `[]` 固化。加了「每次部署都停一次服务」之后，这个 race 从偶发变成每次发版都掷一次骰子。

## 8. 回滚

- **自动**：健康检查不过 → 换回上一版 → 补软链 → 重启 → 再检查。若换回来后仍不过，脚本以非 0 退出并告诉你手工介入，同时给失败的树打上 `.deploy-failed` 标记。
- **手工**：`ssh admin@… 'sh /srv/make-up-shared/deploy-remote.sh --rollback'`。若 `.prev` 带 `.deploy-failed` 标记会拒绝执行 —— 那棵树是坏的，别让它再上来。
- **重发/回滚到某个 commit**：`workflow_dispatch` 填 `ref`。

## 9. 首次初始化

`scripts/bootstrap-server.sh`（以 root 跑，幂等，可反复重跑）：

```sh
scp scripts/bootstrap-server.sh scripts/deploy-remote.sh scripts/looktrace.service \
    root@47.90.149.155:/tmp/
ssh root@47.90.149.155 'DEPLOY_PUBKEY="$(cat deploy_key.pub)" sh /tmp/bootstrap-server.sh'
```

它做七件事：建 `$SHARED`(700) 和 `$PREV`（`/srv` 是 root 所有，必须 root 先建好交给 `admin`）→ 停手工进程 → 把 `.env` 和 `.local-data` 挪进 shared 并建软链 → 往 `.env` 补两个数据目录变量 → 装 systemd 单元 → 装发布脚本和部署公钥 → 清掉 xhs-mcp 死代码并启动。

第 7 步会杀掉仍监听公网 `:18060` 的旧 `xiaohongshu-mcp` 进程（那条链路已从仓库删除，且无鉴权）。**必须先杀进程再删文件**：`/bin/sh` 是按路径逐行读脚本的，文件先没了它会行为异常。

### systemd 单元的两个决定

- **system unit，不是 `systemctl --user`**：部署走非交互 SSH，user unit 要多依赖一个 `XDG_RUNTIME_DIR`。
- **直接跑 `node .../next/dist/bin/next start`，不是 `npm run start`**：少一个进程，也避免 npm 自己退出而 `next-server` 还活着时 unit 显示 `inactive`、`:3000` 却被占着的假象。
- **故意不写 `EnvironmentFile=`**：systemd 的解析器和 dotenv 不一样（不认 `export`、引号规则不同），解析失败会直接起不来。Next 自己会从 `WorkingDirectory` 读 `.env`，保持现状最稳。

## 10. 需要的 GitHub Secrets

| 名字 | 值 |
| --- | --- |
| `DEPLOY_SSH_KEY` | 部署私钥（ed25519）。**不要用 root 密码** |
| `DEPLOY_HOST` | `47.90.149.155` |
| `DEPLOY_USER` | `admin` |
| `DEPLOY_SSH_KNOWN_HOSTS` | `ssh-keyscan 47.90.149.155` 的输出。固定 host key，否则等于 TOFU |

## 11. 已知限制 / 没做的事

- **首传约 140MB 出境**，之后每次约 2~5MB。注意 `npm ci` 会重写 mtime，rsync 的 size+mtime 快速检查每次都失效，会对约 3 万个文件做块校验。如果慢到不可接受，第一条优化是把 `package-lock.json` 的 hash 存成服务器上的 stamp，只有它变了才 rsync `node_modules`。
- **`deploy.sh` 不再服务生产**：服务器的发布树不是 git 仓库，脚本会明确拒绝并指向 CI。它现在只服务本机开发和应急手改。
- `:3000` 直接暴露、无 nginx、无 TLS。要加反代的话注意 Next 需要 `X-Forwarded-*`。
- `.env` 权限：`$SHARED` 是 700，但 `/srv/make-up/.env` 是发布树里 755 目录下的软链，本机其他用户仍可读。和改动前一样，不算修复。
- `readJson` 仍然对**解析失败**静默返回 fallback。§7 的原子写把截断这条路堵上了，但真要彻底，应该把「文件坏了」和「文件不存在」区分开。
