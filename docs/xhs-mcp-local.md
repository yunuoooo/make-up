# 本地小红书 MCP

> **迁移期文档（2026-09-24 起）**：取数正路已改为 Just One API（[09-24-xhs-api-integration.md](specs/09-24-xhs-api-integration.md)），本文描述的本地 MCP 服务是 `XHS_SOURCE_MODE=mcp` 的**回退路径**（默认值仍是它，直到 api 链路验收通过）。切默认并清账后，本文与 `xiaohongshu-mcp/`、`scripts/xhs-*` 一起删除。

本项目使用上游仓库 [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp)，固定在 `xiaohongshu-mcp/`，当前检出 v2.5.0。上游只发布预编译二进制，放在该仓库的 `bin/` 目录，按 `<os>-<arch>` 命名；脚本用 `uname` 自动选择，当前仓库内置 `darwin-arm64`。

服务地址是 `http://127.0.0.1:18060/mcp`。运行 `scripts/install-xhs-mcp-launch-agent` 后，macOS 登录时会自动启动服务并在异常退出后重启。服务使用 `.local-data/xhs-mcp/cookies.json` 保存登录状态；该目录已被 Git 忽略。

首次使用或登录失效时运行：

```sh
./scripts/xhs-mcp-login
```

手动启动服务可以运行：

```sh
./scripts/xhs-mcp-server
```

Codex CLI 已注册名为 `xiaohongshu` 的 Streamable HTTP MCP。Pi 通过 `.pi/extensions/xhs-source.ts` 在 `XHS_SOURCE_MODE=mcp` 时检查服务、按需拉起并注册统一名 `xhs_*` 工具（`xhs_source_status` / `xhs_search_notes` / `xhs_get_note_detail`）；`/xhs-status` 可查看当前模式与连接状态。注意工具名**不随数据源模式变**，换模式只换实现。

应用内的 Pi Agent 用 `lib/pi/bridge.ts` 启动，并通过 `--skill` 显式加载 `xiaohongshu-makeup-advisor-latest/`：系统提示词只声明运行时约束，研究流程、输出格式和排障步骤都来自 `SKILL.md` 与其 `references/`，模型用内置 `read` 工具按需读取。可用 `PI_SKILL_PATH` 换技能目录；技能文件缺失时本轮直接失败，不会退回系统提示词。细节见 [09-17-pi-skill-runtime.md](specs/09-17-pi-skill-runtime.md)。

部署到其他平台时，把对应 release 的二进制放进 `xiaohongshu-mcp/bin/`（例如 Linux x86_64 放 `xiaohongshu-mcp-linux-amd64` 和 `xiaohongshu-login-linux-amd64`），脚本会自动选中；也可用 `XHS_PLATFORM` 强制指定平台组合，或用 `XHS_MCP_BINARY`、`XHS_LOGIN_BINARY`、`XHS_DATA_DIR` 直接覆盖路径，均无需修改脚本。二进制缺失时脚本会列出 `bin/` 里实际可用的平台并给出下载地址。

`scripts/install-xhs-mcp-launch-agent` 只适用于 macOS（launchd）；Linux 上请用 systemd 或进程管理器托管 `scripts/xhs-mcp-server`。

Pi 运行时（`pi` 命令、`typebox`）都来自项目依赖，`npm install` 后即可运行，不需要全局安装。
