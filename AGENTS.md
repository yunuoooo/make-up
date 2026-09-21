# Repository Guidelines（仓库指南）

## 项目结构与模块组织

- `app/`：Next.js App Router 页面和 API 路由。
- `frontend/`：界面组件、hooks、浏览器端类型和全局样式。样式走 Tailwind v4 + shadcn/ui，设计 token 定义在 `frontend/styles/globals.css`；`frontend/components/ui/` 只放实际用到的 shadcn 原语，需要新增时按 `components.json` 的别名生成（`@/frontend/components`、`@/frontend/lib`）。
- `lib/pi/`：Pi Agent 运行时桥接和事件映射，是 Agent 的唯一入口。
- `lib/commerce/`：淘宝商品卡片链路（技能产出机器可读商品块 → 聚合中转适配器 → 卡片补全编排）。上游字段、错误码和超时规则以 `docs/specs/09-21-justoneapi-taobao-ssot.md` 为准，换供应商只改 `lib/commerce/taobao.ts`。
- `lib/storage/`、`lib/types/`：`.local-data/` 下的 JSON 存储和领域类型。
- `xiaohongshu-makeup-advisor-latest/`：妆容顾问技能，Agent 的行为来源（`SKILL.md` + `references/`）。
- `xiaohongshu-mcp/`：小红书 MCP 服务（上游检出 + `bin/` 下的预编译二进制）。
- `.pi/extensions/`：把 MCP 注册为 pi 只读工具 `xhs_*` 的扩展。
- `scripts/`：xhs-mcp 的启动、登录和 launchd 安装脚本。
- `test/L1/`、`test/L3/`：TypeScript 运行时测试。
- `docs/specs/`、`docs/plan/`：产品规格和实现方案。`.next/`、`.local-data/` 用于生成文件或本地状态。

## 构建、测试与开发命令

执行 `npm install` 安装全部依赖，包括 pi Agent 运行时（`@earendil-works/pi-coding-agent`）。执行 `npm run dev` 启动 Next.js。Tailwind v4 通过 `postcss.config.mjs` 接入，扫描范围由 `globals.css` 里的 `@source` 白名单限定（仓库内的 `xiaohongshu-mcp/` 是上游检出，不参与扫描）。`npm run build` 构建生产版本，`npm run start` 启动生产服务，`npm run typecheck` 执行 TypeScript 类型检查。

- `npm test`：运行默认 TypeScript 测试。
- `npm run test:l1`：运行快速的前端和运行时测试。
- `npm run test:l3`：运行可选的端到端测试（会启动真实 pi 进程）；需设置 `RUN_L3_E2E=1`。
- `npm run xhs:login` / `npm run xhs:mcp`：登录小红书、启动本地 MCP 服务。

复制 `.env.example` 为 `.env`，并配置模型 API 密钥。API 密钥不得提交到 Git。

## 运行时依赖边界

部署物必须自包含：pi 二进制来自 `node_modules/.bin/pi`，pi 状态写入 `.local-data/pi`，技能从仓库目录加载，xhs-mcp 二进制从 `xiaohongshu-mcp/bin/` 按 `<os>-<arch>` 选择。不要依赖全局安装的 pi、`~/.pi` 或 `/tmp`；`PI_BIN`、`PI_CODING_AGENT_DIR`、`PI_SKILL_PATH`、`XHS_MCP_BINARY` 可覆盖默认值。

## 编码风格与命名约定

TypeScript/TSX 使用 2 个空格缩进。变量和函数使用 `camelCase`，React 组件和类型使用 `PascalCase`；路由目录使用清晰的 kebab-case。Shell 脚本使用 POSIX `sh`，常量用 `UPPER_SNAKE_CASE`。仓库未配置统一格式化或 lint 工具，提交前应保持改动聚焦并运行类型检查。

## 测试指南

TypeScript 使用 Node 内置测试运行器，测试文件命名为 `.test.ts`。行为变更应补充针对性测试，尤其关注运行时状态、SSE 契约和策略边界。L3 测试需要运行中的应用和本地 MCP 服务，日常测试不要意外启用。当前没有规定覆盖率阈值。

## 提交与合并请求规范

提交信息使用简短的 Conventional Commits 格式，例如 `feat: ...`、`fix: ...`、`docs: ...`，并使用祈使语气。每个提交只包含一个范围明确的改动。合并请求应说明行为和实现、列出已运行的验证命令、关联规格或 issue；涉及界面或 API 时附截图或请求/响应示例，并说明新增环境变量及迁移、部署注意事项。
