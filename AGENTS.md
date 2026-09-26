# Repository Guidelines（仓库指南）

## 项目结构与模块组织

- `app/`：Next.js App Router 页面和 API 路由。
- `frontend/`：界面组件、hooks、浏览器端类型和全局样式。样式走 Tailwind v4 + shadcn/ui，设计 token 定义在 `frontend/styles/globals.css`；`frontend/components/ui/` 只放实际用到的 shadcn 原语，需要新增时按 `components.json` 的别名生成（`@/frontend/components`、`@/frontend/lib`）。
- `lib/pi/`：Pi Agent 运行时桥接和事件映射，是 Agent 的唯一入口。
- `lib/commerce/`：淘宝商品卡片链路（技能产出机器可读商品块 → 聚合中转适配器 → 卡片补全编排）。上游字段、错误码和超时规则以 `docs/specs/09-21-justoneapi-taobao-ssot.md` 为准，换供应商只改 `lib/commerce/taobao.ts`。
- `lib/xhs/`：小红书取数，**只有一条链路**：TikHub（`tikhub.ts`）。上游字段、两层信封与计费陷阱以 `docs/specs/09-24-tikhub-xhs-ssot.md` 为准（**换过供应商：`09-24-justoneapi-xhs-ssot.md` 已作废**）。2026-09-24 之前还有一条本地浏览器驱动的 MCP 回退路径，已随 Phase D 清账删除——`mcp-source.ts`、`xiaohongshu-mcp/`、`scripts/xhs-mcp-*`、`docs/xhs-mcp-local.md` 都不在了。架构与改动面见 `docs/specs/09-24-xhs-api-integration.md`。
- `lib/storage/`、`lib/types/`：`.local-data/` 下的 JSON 存储和领域类型。
- `xiaohongshu-makeup-advisor-latest/`：妆容顾问技能，Agent 的行为来源（`SKILL.md` + `references/`）。
- `.pi/extensions/`：把小红书数据源注册为 pi 只读工具 `xhs_*` 的扩展。工具名与**数据源实现**解耦（换供应商、换传输都不动工具名，也不动技能与提示词），`XHS_SOURCE_MODE` 现在没有回退分支，只有「api」和「没配好就降级」。
- `scripts/`：部署相关。`deploy.sh` 是**本机/应急**路径（拉代码 → 装依赖 → 校验 `.env` → 构建 → 自检 → 重启；`DEPLOY_DRY_RUN=1` 先体检），**生产不走它**——生产是 push 到 `main` 触发 CI 构建，服务器只换目录，见 `docs/specs/09-26-cicd-deploy.md`。`deploy-remote.sh` 在服务器上执行换目录/重启/回滚，`bootstrap-server.sh` 是一次性初始化，`preflight.mjs` 是两边共用的 `.env` 校验与扩展自检（**不要各抄一份**），`looktrace.service` 是 systemd 单元。脚本用 POSIX `sh`，别用 bash 专有语法。
- `.github/workflows/deploy.yml`：push 到 `main` 自动发布。它构建完直接 rsync 产物到服务器，**不经过 `actions/upload-artifact`**（重新打包会丢可执行位和软链，而 `node_modules/.bin/pi` 是软链，丢了要到运行时才炸）。
- `test/L1/`、`test/L3/`：TypeScript 运行时测试。
- `docs/specs/`、`docs/plan/`：产品规格和实现方案。`.next/`、`.local-data/` 用于生成文件或本地状态。

## 构建、测试与开发命令

执行 `npm install` 安装全部依赖，包括 pi Agent 运行时（`@earendil-works/pi-coding-agent`）。执行 `npm run dev` 启动 Next.js。Tailwind v4 通过 `postcss.config.mjs` 接入，扫描范围由 `globals.css` 里的 `@source` 白名单限定（`app/` 与 `frontend/`），仓库里其余目录不参与扫描。`npm run build` 构建生产版本，`npm run start` 启动生产服务，`npm run typecheck` 执行 TypeScript 类型检查。

- `npm test`：运行默认 TypeScript 测试。
- `npm run test:l1`：运行快速的前端和运行时测试。
- `npm run test:l3`：运行可选的端到端测试（会启动真实 pi 进程）；需设置 `RUN_L3_E2E=1`。

复制 `.env.example` 为 `.env`，并配置模型 API 密钥。API 密钥不得提交到 Git。

## 运行时依赖边界

部署物必须自包含：pi 二进制来自 `node_modules/.bin/pi`，pi 状态写入 `.local-data/pi`（含对话会话 `.local-data/pi/sessions/`），技能从仓库目录加载。生产上 `.local-data` 由 `LOOKTRACE_DATA_DIR` + `PI_CODING_AGENT_DIR` 指到发布树外面（`/srv/make-up-shared/.local-data`），这样发版换目录碰不到用户数据；生产发布树的路径 `/srv/make-up` **一个字都不能改**——会话目录名按 cwd 的绝对路径生成，换路径等于所有历史对话静默消失。小红书取数走 **TikHub**（`XHS_SOURCE_MODE=api` 且 `XHS_API_TOKEN` 非空才发请求；token 为空或模式是别的值时整条链路降级，不发请求也不伪装成真实来源），token 走请求头 `Authorization: Bearer`、不进 URL。检索不按笔记类型过滤，详情按搜索结果里的 `type` 分流到图文/视频两个端点；**视频的理解来源是口播字幕**（详情响应里的 `.srt`，解析成 `[MM:SS]` 纯文本，`lib/xhs/transcript.ts`），没有视频模型、不下载视频、不新增任何二进制或依赖。**取数不需要任何二进制**：没有浏览器、没有登录态、没有本地服务。不要依赖全局安装的 pi、`~/.pi` 或 `/tmp`；`PI_BIN`、`PI_CODING_AGENT_DIR`、`PI_SKILL_PATH` 可覆盖默认值。

## 编码风格与命名约定

TypeScript/TSX 使用 2 个空格缩进。变量和函数使用 `camelCase`，React 组件和类型使用 `PascalCase`；路由目录使用清晰的 kebab-case。Shell 脚本使用 POSIX `sh`，常量用 `UPPER_SNAKE_CASE`。仓库未配置统一格式化或 lint 工具，提交前应保持改动聚焦并运行类型检查。

## 测试指南

TypeScript 使用 Node 内置测试运行器，测试文件命名为 `.test.ts`。行为变更应补充针对性测试，尤其关注运行时状态、SSE 契约和策略边界。L3 测试需要运行中的应用与真实的 `XHS_API_TOKEN`（会真的打上游、真的计费），日常测试不要意外启用。当前没有规定覆盖率阈值。

## 提交与合并请求规范

提交信息使用简短的 Conventional Commits 格式，例如 `feat: ...`、`fix: ...`、`docs: ...`，并使用祈使语气。每个提交只包含一个范围明确的改动。合并请求应说明行为和实现、列出已运行的验证命令、关联规格或 issue；涉及界面或 API 时附截图或请求/响应示例，并说明新增环境变量及迁移、部署注意事项。
