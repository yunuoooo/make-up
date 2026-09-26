# 妆迹 looktrace

小红书妆容研究 Agent。用户描述妆容需求，Agent 用 [Pi](https://github.com/earendil-works/pi-coding-agent) 运行时加载妆容顾问技能，通过小红书检索真实笔记（取数走 **TikHub** 的 HTTP 接口），输出妆容拆解表，并按需补全可购买的商品卡片。

答案里的每个结论都要求有来源笔记和证据类型；商品卡片是可选链路（上游按次计费，默认关闭）。

## 快速开始

需要 Node 22+（测试用 `--experimental-strip-types`）。

```sh
npm install            # 含 Pi Agent 运行时，无需全局安装
cp .env.example .env   # 至少填模型 key 与 XHS_API_TOKEN
npm run dev            # http://localhost:3000
```

取数走 HTTP，没有浏览器、没有登录态，也不需要额外开任何服务：填好 `XHS_API_TOKEN` 就能用。token（或 `XHS_SOURCE_MODE`）没配好时整条链路安静降级，答案会如实说明本轮没有实时站内检索。

## 配置

配置全部走 `.env`。`.env.example` 是逐项带注释的模板，下表是索引。

### 模型（必填）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 空 | 模型凭据；不填则 Agent 无法启动 |
| `PI_PROVIDER` | `deepseek` | Pi 的 provider |
| `PI_MODEL` | `deepseek-chat` | 模型名 |

运行时路径一般不用改，需要时用 `PI_BIN` / `PI_CODING_AGENT_DIR` / `PI_SKILL_PATH` 覆盖。

### 小红书取数

取数只有一条链路：**TikHub** 的 HTTP 接口（`lib/xhs/tikhub.ts`）。架构与改动面见 [09-24 集成方案](./docs/specs/09-24-xhs-api-integration.md)，字段、两层信封与计费陷阱见 [TikHub SSOT](./docs/specs/09-24-tikhub-xhs-ssot.md)。2026-09-24 之前还有一条本地浏览器驱动的 MCP 回退路径，已连同二进制、登录脚本和部署文档一起删除。

**图文与视频都支持**（[09-25 视频理解](./docs/specs/09-25-video-understanding.md)）：检索不按笔记类型过滤；详情按搜索结果里的 `type` 分流到对应端点，视频笔记会**连口播字幕一起返回**——字幕取自详情响应里的 `.srt` 地址，解析成带 `[MM:SS]` 时间戳的纯文本。没有视频模型、不下载视频、不需要任何二进制。视频没有人声或没有字幕轨时，笔记照常返回并带一个 `reason`（`no-voice` / `no-transcript` / `transcript-failed`），答案会如实说明而不是假装看过画面。字幕只向 `xhscdn.com` / `rednotecdn.com` 取，且**字幕地址本身（带签名）不进模型上下文、日志与 SSE**。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `XHS_SOURCE_MODE` | `api` | 只有 `api` 算开；其它值（含留空、写错）按「没有数据源」降级——保险丝，不是开关 |
| `XHS_API_TOKEN` | 空 | TikHub 的 API Token（请求头 `Authorization: Bearer`，不进 URL）。为空即未配置：不发请求，答案会说明本轮没有实时站内检索 |
| `XHS_API_BASE_URL` | `https://api.tikhub.io` | 换供应商时才改 |
| `XHS_API_TIMEOUT_SECONDS` | `60` | 单请求超时（上游建议 120s、至少 60s） |
| `XHS_API_BUDGET_SECONDS` | `60` | 单轮上游累计耗时预算，超了就不再发起新请求，已拿到的照发 |
| `XHS_API_SEARCH_PAGES` | `2` | 搜索翻页上限，每页 20 条 |
| `XHS_API_DETAIL_LIMIT` | `10` | 一轮读几篇正文——**唯一的省钱杠杆**（逐次计费，取技能要求的 6–10 篇上界；视频笔记走同一个计数器） |
| `XHS_API_TRANSCRIPT_LIMIT` | `20000` | 视频字幕的字符上限。与正文的 8000 分开：十分钟的教程字幕长得多，截断的代价也更大 |

### 淘宝商品卡片（默认关）

上游是采集类接口、**按次计费**，一轮妆容要打好几次搜索和详情，所以总开关**默认关闭**。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TAOBAO_CARDS_ENABLED` | `false` | **总开关**。改成 `"true"` 或 `"1"` 才发请求 |
| `TAOBAO_API_TOKEN` | 空 | 凭据，走 query 参数；为空即视为未配置 |
| `TAOBAO_API_BASE_URL` | `https://api.justoneapi.com` | 换供应商或指向沙箱时才改 |
| `TAOBAO_API_TIMEOUT_SECONDS` | `30` | 单请求超时 |
| `TAOBAO_CARDS_BUDGET_SECONDS` | `60` | 整批总预算，超预算只影响没拿到的那几件 |
| `TAOBAO_CARD_LIMIT` | `8` | 单轮卡片上限 |
| `TAOBAO_CACHE_TTL_SECONDS` | `86400` | 卡片缓存 TTL，缓存是为了不重复烧配额 |

开关与 token 是**「与」**的关系：两个都满足才调用，所以配了 token 也不会自动开始计费。判据从严——只有 `"true"` / `"1"` 算开，没写、写空、写错都按关处理，这个方向的默认值只会少花钱。

**一轮的账单**：一张卡片 = 一次搜索 + 一次详情，一轮默认最多 8 张 = 16 次调用。上游**只有成功（`code=0`）才计费**，失败、重试与限流都不花钱。详情现在是 V6（V3 是 ¥0.6/次、V8 是 ¥0.2/次；**V6 的单价还没核**），搜索 V2 的单价同样没核准——算法、历史版本与两个还没动的降本杠杆见 [SSOT 第 8 节](./docs/specs/09-21-justoneapi-taobao-ssot.md) 与 [第 4.3 节](./docs/specs/09-21-justoneapi-taobao-ssot.md)。

关掉时整条链路安静降级：不发任何请求（连 `pending` 事件都不发），不出空骨架、假价格、假链接，答案正文里的机器可读块照常剥掉。

### Langfuse 观测（可选）

全链路 trace：每个阶段的 input/output 与耗时。两个 key 都为空 = 完全不上报。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | 空 | 项目设置里生成；全空即关闭 |
| `LANGFUSE_BASE_URL` | `https://cloud.langfuse.com` | 自托管时改这里 |
| `LANGFUSE_TRACING_ENVIRONMENT` | `development` | 环境标签 |
| `LANGFUSE_TRACE_INCLUDE_CONTENT` | `true` | `false` 时只记形状与字节数，不记正文 |

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发服务器 |
| `npm run build` / `npm start` | 生产构建与启动 |
| `npm run typecheck` | 类型检查 |
| `npm test` / `npm run test:l1` | 快速测试 |
| `npm run test:l3` | 端到端测试（会跑真实 pi 进程，需 `RUN_L3_E2E=1`） |
| `./scripts/deploy.sh` | **本机/应急**部署（拉代码 → 装依赖 → 校验 `.env` → 构建 → 自检 → 重启）；先跑 `DEPLOY_DRY_RUN=1 ./scripts/deploy.sh` 体检 |

## 部署

**生产发布 = push 到 `main`。** GitHub Actions 在 CI 里构建，只把产物 rsync 到服务器；服务器不构建、不装依赖，只做「换目录 + 重启」，健康检查不过自动回滚。细节见 [09-26 CI/CD 部署](./docs/specs/09-26-cicd-deploy.md)。

```sh
gh workflow run deploy.yml --ref main           # 重发一次
gh workflow run deploy.yml -f ref=<旧 commit>   # 回滚到某个版本
ssh admin@47.90.149.155 'sh /srv/make-up-shared/deploy-remote.sh --rollback'   # 就地回滚上一版
```

两条别踩的线：`/srv/make-up` 这个路径**一个字都不能改**（会话目录名按 cwd 的绝对路径生成，换路径等于所有历史对话静默消失）；服务**只能单实例**（会话锁在进程内），所以重启有约 5 秒中断，别在有人提问时发版。

## 已知限制

| 限制 | 说明 |
| --- | --- |
| 取数按次计费 | TikHub 逐次计费，一轮读几篇正文由 `XHS_API_DETAIL_LIMIT` 控制 |
| 取数不可用时不自动降级成假来源 | token 或模式没配好，答案是「本轮没有实时站内检索」，不会编来源 |
| 商品卡片默认关 | 上游按次计费，要用得显式打开 `TAOBAO_CARDS_ENABLED` |
| 会话有保质期 | 服务端会话保留 30 条、30 天，超出的被清理；过期后追问会从零开始，界面会提示。见 [09-23](./docs/specs/09-23-conversation-sessions.md) |
| 单实例的会话锁 | 同一会话的并发请求返回 409，锁在进程内；多实例部署需要外部锁 |

## 目录

```text
app/                        Next.js App Router 页面与 API 路由
frontend/                   界面组件、hooks、设计 token（Tailwind v4 + shadcn/ui）
lib/pi/                     Pi 运行时桥接、事件映射与会话管理（Agent 的唯一入口）
lib/commerce/               商品卡片链路：技能的商品块 → 上游适配器 → 卡片补全
lib/xhs/                    小红书取数：TikHub 适配器
lib/observability/          Langfuse trace 采集
lib/storage/ lib/types/     .local-data/ 下的 JSON 存储与领域类型
xiaohongshu-makeup-advisor-latest/   妆容顾问技能（Agent 的行为来源）
.pi/extensions/             把小红书数据源注册为只读工具 xhs_* 的扩展
docs/specs/ docs/plan/      产品规格与实现方案
```

## 文档

改动前先读对应的 spec，实现与 spec 冲突时以 spec 为准：

- [09-24 小红书取数架构](./docs/specs/09-24-xhs-api-integration.md) 与 [TikHub 接口 SSOT](./docs/specs/09-24-tikhub-xhs-ssot.md)（原 Just One 版已作废）
- [09-17 Pi Agent 技能驱动运行时](./docs/specs/09-17-pi-skill-runtime.md)
- [09-21 淘宝商品卡片](./docs/specs/09-21-taobao-product-cards.md) 与 [上游接口 SSOT](./docs/specs/09-21-justoneapi-taobao-ssot.md)
- [09-22 Langfuse 全链路观测](./docs/specs/09-22-langfuse-observability.md)
- [09-23 会话上下文（双阶段流程的第二阶段）](./docs/specs/09-23-conversation-sessions.md)

`AGENTS.md` 是仓库约定（结构、命令、编码风格、提交规范）。
