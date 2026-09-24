# 妆迹 looktrace

小红书妆容研究 Agent。用户描述妆容需求，Agent 用 [Pi](https://github.com/earendil-works/pi-coding-agent) 运行时加载妆容顾问技能，通过小红书检索真实笔记（取数默认走本地 MCP，可切到 TikHub API），输出妆容拆解表，并按需补全可购买的商品卡片。

答案里的每个结论都要求有来源笔记和证据类型；商品卡片是可选链路（上游按次计费，默认关闭）。

## 快速开始

需要 Node 22+（测试用 `--experimental-strip-types`）。

```sh
npm install            # 含 Pi Agent 运行时，无需全局安装
cp .env.example .env   # 至少填模型 key；其余按需
npm run xhs:login      # 扫码登录小红书，只需一次
npm run dev            # http://localhost:3000
```

`npm run dev` 第一次真正调用小红书工具时，`.pi/extensions/xhs-source.ts` 会在 mcp 模式下自动拉起本地 MCP 服务（`scripts/xhs-mcp-server`），不需要单独开一个终端；切成 api 模式后就不需要这个服务了。

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

取数有两条链路，用 `XHS_SOURCE_MODE` 切换：`mcp`（默认，本机浏览器驱动的本地 MCP 服务）和 `api`（**TikHub** 的 HTTP 接口，见 [09-24 集成方案](./docs/specs/09-24-xhs-api-integration.md) 与 [TikHub SSOT](./docs/specs/09-24-tikhub-xhs-ssot.md)）。工具名两条链路共用，切换不需要改技能或提示词。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `XHS_SOURCE_MODE` | `mcp` | `api` / `mcp`；其它值按「没有数据源」降级 |
| `XHS_API_TOKEN` | 空 | TikHub 的 API Token（请求头 Bearer）。为空即未配置：不发请求，答案会说明本轮没有实时站内检索 |
| `XHS_API_DETAIL_LIMIT` | `10` | 一轮读几篇正文——**唯一的省钱杠杆**（逐次计费，取技能要求的 6–10 篇上界） |
| `XHS_MCP_URL` | `http://127.0.0.1:18060/mcp` | 本地 MCP 端点（mcp 模式） |
| `XHS_MCP_AUTH_TOKEN` | 空 | 需要时给本地服务加 Bearer 鉴权 |
| `XHS_MCP_REQUEST_TIMEOUT_SECONDS` | `45` | 单次工具调用超时 |
| `XHS_MCP_PORT` | `18060` | 服务端口 |
| `XHS_MCP_HEADLESS` | `true` | 浏览器无头模式 |

二进制默认按 `<os>-<arch>` 从 `xiaohongshu-mcp/bin/` 选，可用 `XHS_PLATFORM` / `XHS_MCP_BINARY` / `XHS_LOGIN_BINARY` / `XHS_DATA_DIR` 覆盖。

> **搜索可能被风控拦到安全验证页**，此时每次搜索都会等满 60 秒才失败，需要在手机 App 上扫码验证才能解除。根因、证据与缓解见 [09-07 第 13 节](./docs/specs/09-07-xhs-mcp-integration.md)。（api 链路没有这个问题——没有浏览器、没有登录态。）
>
> **视频笔记的详情必然超时**（上游缺陷，只影响 mcp 模式），已在工具层拦截。见 [09-07 第 12 节](./docs/specs/09-07-xhs-mcp-integration.md)。

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

**一轮的账单**：一张卡片 = 一次搜索 + 一次详情，一轮默认最多 8 张 = 16 次调用。上游**只有成功（`code=0`）才计费**，失败和重试不花钱。详情走 V8（¥0.2/次，V3 是 ¥0.6/次），搜索 V2 的单价还没核准——一轮大约 ¥5.8，算法与两个还没动的降本杠杆见 [SSOT 第 8 节](./docs/specs/09-21-justoneapi-taobao-ssot.md)。

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
| `./scripts/deploy.sh` | 部署（拉代码 → 装依赖 → 校验 `.env` → 构建 → 自检 → 重启）；先跑 `DEPLOY_DRY_RUN=1 ./scripts/deploy.sh` 体检 |
| `npm run xhs:login` | 扫码登录小红书（**仅 macOS 回退路径**；Linux 上仓库没有对应二进制） |
| `npm run xhs:mcp` | 前台启动本地 MCP 服务（排查用；日常不需要） |

## 已知限制

| 限制 | 说明 |
| --- | --- |
| 搜索可能被风控拦 | 登录态被标记后每次搜索必然等满 60s。见 [09-07 第 13 节](./docs/specs/09-07-xhs-mcp-integration.md) |
| 视频笔记读不了（**仅 mcp 模式**） | 上游 `get_feed_detail` 对视频笔记必然超时，工具层直接拒绝。api 模式没有这个问题，它检索时已限定图文。见 [09-07 第 12 节](./docs/specs/09-07-xhs-mcp-integration.md) |
| 商品卡片默认关 | 上游按次计费，要用得显式打开 `TAOBAO_CARDS_ENABLED` |
| 会话有保质期 | 服务端会话保留 30 条、30 天，超出的被清理；过期后追问会从零开始，界面会提示。见 [09-23](./docs/specs/09-23-conversation-sessions.md) |
| 单实例的会话锁 | 同一会话的并发请求返回 409，锁在进程内；多实例部署需要外部锁 |

## 目录

```text
app/                        Next.js App Router 页面与 API 路由
frontend/                   界面组件、hooks、设计 token（Tailwind v4 + shadcn/ui）
lib/pi/                     Pi 运行时桥接、事件映射与会话管理（Agent 的唯一入口）
lib/commerce/               商品卡片链路：技能的商品块 → 上游适配器 → 卡片补全
lib/xhs/                    小红书取数：TikHub 适配器（+ 迁移期的 MCP 回退传输）
lib/observability/          Langfuse trace 采集
lib/storage/ lib/types/     .local-data/ 下的 JSON 存储与领域类型
xiaohongshu-makeup-advisor-latest/   妆容顾问技能（Agent 的行为来源）
xiaohongshu-mcp/            小红书 MCP 服务（迁移期回退路径，上游检出 + bin/ 预编译二进制）
.pi/extensions/             把小红书数据源注册为只读工具 xhs_* 的扩展
docs/specs/ docs/plan/      产品规格与实现方案
```

## 文档

改动前先读对应的 spec，实现与 spec 冲突时以 spec 为准：

- [09-07 小红书 MCP 接入](./docs/specs/09-07-xhs-mcp-integration.md)（**已被 09-24 取代**；第 12/13 节的上游缺陷记录保留）
- [09-24 小红书取数架构](./docs/specs/09-24-xhs-api-integration.md) 与 [TikHub 接口 SSOT](./docs/specs/09-24-tikhub-xhs-ssot.md)（原 Just One 版已作废）
- [09-17 Pi Agent 技能驱动运行时](./docs/specs/09-17-pi-skill-runtime.md)
- [09-21 淘宝商品卡片](./docs/specs/09-21-taobao-product-cards.md) 与 [上游接口 SSOT](./docs/specs/09-21-justoneapi-taobao-ssot.md)
- [09-22 Langfuse 全链路观测](./docs/specs/09-22-langfuse-observability.md)
- [09-23 会话上下文（双阶段流程的第二阶段）](./docs/specs/09-23-conversation-sessions.md)

`AGENTS.md` 是仓库约定（结构、命令、编码风格、提交规范）。
