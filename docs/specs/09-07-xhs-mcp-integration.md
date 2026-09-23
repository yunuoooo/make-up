# 小红书 MCP 接入方案

Status: Phase 1 implemented and live-verified
Date: 2026-09-09
Related specs: [001-mvp.md](./001-mvp.md)、[09-17-pi-skill-runtime.md](./09-17-pi-skill-runtime.md)、[09-22-langfuse-observability.md](./09-22-langfuse-observability.md)
Revised: 2026-09-22 — 第 8 节「原始 MCP 响应默认不写入 Langfuse」的约束作废，现行口径见 [09-22-langfuse-observability.md](./09-22-langfuse-observability.md)
Revised: 2026-09-23 — 新增第 13 节「搜索被风控拦到安全验证页」；原第 13/14 节顺延为 14/15。

## 0. 文档目的

本文定义妆迹分阶段接入 [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) 的方案。第零阶段先在 Codex 中完成 MCP 冒烟验证，确认当前 Agent 需要的只读工具可以真实调用；第一阶段再验证“真实小红书内容能否进入 Agent 上下文，并由 Agent 基于帖子和评论自行判断妆容与化妆品”；结构化证据、来源落库和 SKU 业务联动放到后续阶段。

本文是接入设计和评审依据，不包含本次实现代码、部署脚本或账号登录操作。第零阶段的 Codex 配置和手工调用记录不属于生产集成实现。

## 1. 决策摘要

### 1.1 推荐方案

将 `xiaohongshu-mcp` 作为外部数据服务。先在第零阶段由 Codex 作为 MCP client 验证上游工具；通过后，再由 Python runtime 通过 `MCPServerStreamableHttp` 连接其 Streamable HTTP 端点。Agent 仍然只看到妆迹自己的业务工具 `search_xhs_evidence`。第一阶段的工具结果不是最终的结构化证据，而是一个受控的原始内容上下文包：

```text
Looktrace Agent
    -> search_xhs_evidence(query)
        -> XHS MCP: search_feeds
        -> XHS MCP: get_feed_detail（获取帖子正文和评论）
        -> 原始帖子上下文包（受控截断、脱敏）
        -> Agent 自己判断妆容特点和化妆品
```

不建议把上游 MCP server 直接配置到 `Agent(mcp_servers=[...])`。上游同时提供发布、评论、点赞、收藏和删除 cookies 等工具，直接暴露会扩大 Agent 的权限面。第一阶段由本地 `search_xhs_evidence` 统一调用 MCP，并把白名单内的原始内容整理成上下文。

### 1.2 必须保持的原则

- `search_xhs_evidence` 继续是 Agent 的稳定业务工具名和唯一 XHS 入口。
- `XHS_SOURCE_MODE=mock` 仍可用于单元测试和无外部依赖的本地开发。
- `XHS_SOURCE_MODE=mcp` 时，MCP 不可用必须返回 `degraded`/`failed`，不能静默回退到 mock 并伪装成真实来源。
- MCP 返回的 `feed_id`、`xsec_token` 等外部字段只在服务端短期使用；token 不进入 prompt、业务来源、trace metadata 或客户端响应。
- 第零阶段和第一阶段只允许验证或使用只读工具：`check_login_status`、`search_feeds`、`get_feed_detail`。实际 Agent 业务路径默认只使用后两个。
- 第一阶段允许原始帖子正文和评论进入模型上下文，但必须经过字段白名单、数量上限、字符上限和敏感字段清理。
- 未完成第零阶段的真实工具调用验收，不得开始第一阶段的应用代码接入。

## 2. 当前实现差距

- `agent_service/tools/xhs.py` 的 `search_xhs_evidence` 当前根据关键词匹配固定预设，未发起网络请求。
- `agent_service/runtime.py` 当前注册本地 function tools，没有 MCP client 或 MCP server 生命周期管理。
- `lib/adapters/xhs.ts` 也使用本地 preset，主要服务旧 TypeScript pipeline 和 `/api/sources/xhs/search`。
- `openai-agents==0.3.3` 已提供 `MCPServerStreamableHttp`、`connect()`、`call_tool()` 和 `cleanup()`，无需更换当前 Agent SDK。

因此，第一阶段的核心不是重新实现小红书抓取或建立完整证据模型，而是增加 MCP client、原始内容上下文适配器和运行生命周期。

## 3. 外部服务契约

### 3.1 服务地址与协议

上游服务使用 Streamable HTTP MCP：

```text
MCP endpoint: http://127.0.0.1:18060/mcp
Authorization: Bearer <AUTH_TOKEN>（启用鉴权时）
```

上游默认可关闭鉴权，但非本机部署必须设置 `AUTH_TOKEN`。服务启动后必须先完成小红书登录；`check_login_status` 可用于健康检查，搜索和详情均依赖登录状态。

### 3.2 第零阶段和第一阶段允许的上游工具

| 上游工具 | 用途 | Agent 是否直接可见 | 备注 |
| --- | --- | --- | --- |
| `check_login_status` | 检查账号状态 | 否 | 启动检查和故障诊断使用 |
| `search_feeds` | 按关键词搜索笔记 | 否 | 由业务 adapter 调用。结果每条带 `noteCard.type`（`normal`/`video`），是调用方能否安全读取详情的前置判据，见第 12 节 |
| `get_feed_detail` | 读取笔记详情和评论 | 否 | 由 adapter 按需调用。**对视频笔记必然超时**，见第 12 节 |
| `user_profile` | 读取用户主页 | 否 | 第一阶段不纳入证据链，可后续增加 |
| `publish_content` 等写工具 | 发布、互动或账号操作 | 否 | 第一阶段禁止调用 |

上游 `get_feed_detail` 需要 `feed_id` 和 `xsec_token`，这两个值必须来自同一次搜索或受信任的 MCP 返回，不能由用户消息直接传入。

**调用前置判据**：只对 `noteCard.type === "normal"` 的条目调 `get_feed_detail`。`video` 条目在 `xiaohongshu-mcp v2.5.0` 上必然卡满 60s 才失败（播放器持续改动 DOM，`MustWaitDOMStable` 永不成立），失败机制、证据与解除条件见第 12 节。

## 4. 第零阶段：Codex MCP 冒烟验证

### 4.1 目标与范围

第零阶段是进入应用开发前的外部依赖验证。目标是确认 Codex 能连接正在运行的 `xiaohongshu-mcp`，完成 MCP 初始化，并成功调用第一阶段真正需要的搜索和详情工具。

本阶段不做以下事情：

- 不修改 `agent_service/`、`app/` 或 `lib/` 代码。
- 不把 MCP server 注册到妆迹 Agent runtime。
- 不把帖子内容写入妆迹业务存储或 session。
- 不调用发布、评论、点赞、收藏、删除 cookies 等副作用工具。
- 不以 Codex 的成功调用替代后续 Python runtime 的集成测试。

### 4.2 前置条件

1. 按上游项目说明启动 `xiaohongshu-mcp`，默认地址为 `http://127.0.0.1:18060/mcp`。
2. 在上游服务中完成小红书登录，并确认账号状态正常。
3. 如果启用了 `AUTH_TOKEN`，准备仅用于 Codex MCP 连接的 `Authorization: Bearer <AUTH_TOKEN>` 请求头。
4. 在 Codex 的 MCP 配置中登记该 Streamable HTTP server。配置示意：

```text
server name: xiaohongshu-mcp
url: http://127.0.0.1:18060/mcp
headers: Authorization: Bearer <AUTH_TOKEN>（启用鉴权时）
```

token 不得提交到仓库、写进 prompt、截图或普通日志。若 Codex 当前环境无法连接本机地址，应先解决连接方式，不得直接跳过第零阶段进入应用实现。

### 4.3 手工调用顺序

必须按以下顺序调用，并保存脱敏后的结果摘要：

1. `check_login_status`：确认 MCP server 可连接且账号已登录。
2. `search_feeds`：使用一个与妆容业务相关的关键词，例如 `低饱和通勤妆 油皮`。
3. 从搜索结果中选取一条结果的 `feed_id` 和对应 `xsec_token`，仅在当前 Codex/MCP 调用链内传给 `get_feed_detail`。
4. `get_feed_detail`：确认能够获取帖子标题、正文或标签，以及评论列表。
5. 重复执行一次搜索或详情调用，确认同一个 MCP session 不会只在首次调用时可用。

不得把 `xsec_token` 展示给用户或复制到持久化配置。验证结果只记录工具名、HTTP/MCP 成功状态、字段计数、正文/评论是否存在和耗时。

### 4.4 第零阶段验收标准

第零阶段通过必须同时满足：

- Codex 能发现并初始化 `xiaohongshu-mcp` MCP server。
- `check_login_status` 返回已登录状态。
- `search_feeds` 能返回至少一条可用于详情查询的结果，包含 `feed_id` 和 `xsec_token`。
- `get_feed_detail` 使用搜索结果中的临时凭据成功返回帖子内容和评论字段。
- 至少一次重复调用成功，证明连接或 session 可以稳定复用。
- 未调用任何写工具，且写工具不进入本次验证的 allowlist。
- 鉴权失败、未登录、服务停止等失败路径能被识别，不被误判为“搜索无结果”。
- 没有 token、Cookie、二维码 Base64 或完整帖子内容进入 Codex 配置、仓库文件和普通日志。

建议记录以下验证表，不记录敏感内容：

| 检查项 | 结果 | 记录内容 |
| --- | --- | --- |
| MCP 初始化 | pass/fail | server 名称、端点是否可达 |
| 登录状态 | pass/fail | 是否已登录，不记录账号凭据 |
| `search_feeds` | pass/fail | 返回条数、是否包含必要字段 |
| `get_feed_detail` | pass/fail | 是否有正文、标签、评论及字段数量 |
| 重复调用 | pass/fail | 调用次数、总耗时 |
| 写工具隔离 | pass/fail | allowlist 工具名 |

只有以上验收全部通过，才允许进入 Phase 1。若失败，应先归类为连接、鉴权、登录、上游返回格式或账号风控问题，并修复后重新执行，不得用 mock 结果代替验收。

## 5. 代码边界与运行生命周期

推荐代码边界：

```text
agent_service/xhs_mcp.py       MCP client 创建、连接、调用、cleanup
agent_service/tools/xhs.py     search_xhs_evidence 业务工具和结果转换
agent_service/schemas.py       XHS 内部结果 schema（如需要）
agent_service/runtime.py       runtime 生命周期和工具注册
agent_service/main.py          FastAPI startup/shutdown 钩子
agent_service/guardrails.py    XHS 结果安全和大小校验
```

生命周期要求：

1. 服务启动时按 `XHS_SOURCE_MODE` 判断是否创建 MCP client。
2. `mcp` 模式启动时连接并初始化 MCP session；连接失败应记录服务状态，但不阻塞 mock 模式启动。
3. 启动检查可调用 `check_login_status`，不能把 cookies 或二维码内容写入日志。
4. 每次业务调用使用已连接的 session，设置请求和读取超时；不为每个 tool call 重建连接。
5. FastAPI shutdown 时调用 `cleanup()`，释放 HTTP stream 和 MCP session。
6. 连接断开后允许一次受控重连；不得在 Agent tool loop 内无限重试。

如果采用 SDK 的 `Agent(mcp_servers=[...])` 作为内部实现，仍必须使用工具白名单过滤，并由 runtime 显式负责 `connect()`/`cleanup()`。本方案的默认实现优先直接调用 `call_tool()`，以便统一处理上游响应和妆迹业务契约。

## 6. 配置

在 `.env.example` 增加以下配置：

```env
XHS_SOURCE_MODE="mcp"                  # mock | mcp
XHS_MCP_URL="http://127.0.0.1:18060/mcp"
XHS_MCP_AUTH_TOKEN=""
XHS_MCP_REQUEST_TIMEOUT_SECONDS="75"
XHS_MCP_SSE_READ_TIMEOUT_SECONDS="120"
XHS_MCP_SEARCH_LIMIT="5"
XHS_MCP_DETAIL_LIMIT="2"
AGENT_TIMEOUT_SECONDS="180"
```

配置约束：

- 第一阶段本地运行默认使用 `mcp`；隔离测试必须显式构造 `mock` 设置，不能让运行时静默回退。
- `mcp` 模式下 `XHS_MCP_URL` 必须是 HTTPS 或本机回环地址；生产环境禁止使用无鉴权的公网 HTTP。
- token 只能从服务端环境变量读取，不允许出现在请求 body、tool 参数或前端配置中。
- `XHS_MCP_SEARCH_LIMIT` 默认 5，`XHS_MCP_DETAIL_LIMIT` 默认 2，最大值分别限制为 10 和 5，避免一次用户请求触发过多浏览器操作。
- 上游搜索页面内部最多等待 60 秒；客户端默认给单次 MCP 75 秒，总 Agent 180 秒。工具错误允许在健康 MCP 连接上重试一次，传输超时不自动重试。

## 7. 第一阶段：原始帖子上下文

### 7.1 输入

业务工具仍只接受：

```json
{ "query": "低饱和通勤妆 油皮" }
```

工具不得接受 `userId`、`feed_id`、`xsec_token`、Cookie、URL 任意列表或 MCP 参数。查询应在 adapter 内截断长度、去除控制字符并限制最大结果数量。

### 7.2 调用流程

1. 校验 query 非空并生成本次 tool run 标识。
2. 调用 `search_feeds(keyword=query, filters=...)`。
3. 解析 MCP text/content 中的搜索结果；解析失败返回 `XHS_MCP_INVALID_RESPONSE`。
4. 对搜索结果去重，保留最多 `XHS_MCP_SEARCH_LIMIT` 条候选。
5. 对候选调用 `get_feed_detail(feed_id, xsec_token)`，获取帖子正文、标签、作者展示名和评论。
6. 将每条结果整理为原始帖子上下文，保留原文语义，不做化妆品抽取、不生成置信度、不改写成结论。
7. 只保留允许字段，截断单条帖子、单条评论和总上下文大小，清除 Cookie、token、内部错误和无关控制字段。
8. 将上下文包作为 `ToolResult.data.raw_posts` 返回给 Agent，由 Agent 自己判断帖子中提到的妆容特点、化妆品和评论共识。

### 7.3 第一阶段结果结构

第一阶段不要求生成 `EvidenceItem` 或置信度，结果重点是给模型可读的原始内容。为满足现有 `AgentAnswer` 契约，Agent 仍可以根据帖子元数据生成最小的帖子级 `sources` 引用：

```json
{
  "status": "succeeded",
  "data": {
    "raw_posts": [
      {
        "post_id": "feed_xxx",
        "title": "笔记标题",
        "author_name": "作者展示名",
        "text": "帖子正文原文",
        "tags": ["通勤妆", "低饱和"],
        "comments": [
          {"author_name": "评论者", "text": "评论原文"}
        ],
        "source_url": "https://www.xiaohongshu.com/explore/<feed_id>"
      }
    ]
  }
}
```

`post_id` 可以作为服务端临时关联 ID，但 `xsec_token` 不得进入结果。`source_url` 不得携带 `xsec_token`。第一阶段允许 Agent 在最终回答中引用帖子标题或链接，但不能把模型自行推断的化妆品当成 MCP 已验证字段。

### 7.4 第一阶段 Agent 行为

Agent 收到 `raw_posts` 后负责：

- 总结帖子共同的妆容特点和差异。
- 从帖子正文、标签和评论中识别被提到的化妆品、品类或产品能力。
- 区分“帖子明确提到”“评论提到”和“Agent 根据内容推断”三种来源。
- 对无法确认的品牌、色号、价格和功效保持不确定，不补写为事实。
- 在回答中引用帖子标题或来源链接，但不输出原始 JSON、`feed_id` 或 `xsec_token`。

第一阶段不要求 Agent 把识别结果写入 `EvidenceItem`，也不要求自动生成 SKU 候选。Agent 的结构化最终回答仍需通过现有 `AgentAnswer` 校验；`sources` 只保留帖子级引用，`sku_candidates` 只能标记为 `placeholder`，不得冒充实时商品。帖子中明确提到的产品可以在 `answer_text` 或临时展示字段中表达，但不能被当成已验证的商品候选。

## 8. 错误、降级与安全策略

建议错误码：

| 错误码 | 场景 | 终态建议 |
| --- | --- | --- |
| `XHS_MCP_UNAVAILABLE` | 连接失败、服务未启动 | `degraded` |
| `XHS_MCP_UNAUTHORIZED` | token 错误或权限失败 | `failed` 或 `degraded` |
| `XHS_NOT_LOGGED_IN` | 上游账号未登录 | `degraded` |
| `XHS_MCP_TIMEOUT` | 请求或读取超时 | `degraded` |
| `XHS_MCP_TOOL_FAILED` | MCP 连接正常，但小红书页面加载或工具执行失败 | `degraded` |
| （视频笔记超时） | `get_feed_detail` 对视频笔记必然超时，见第 12 节 | 不应发生——调用前按 `noteCard.type` 过滤掉 |
| `XHS_MCP_INVALID_RESPONSE` | 返回无法解析或字段不符合预期 | `degraded` |
| `XHS_EMPTY_RESULT` | 搜索无结果 | `degraded` |
| `XHS_RESULT_TOO_LARGE` | 返回内容超过边界 | `degraded` |

硬性要求：

- MCP 失败时不能使用 mock 结果冒充真实来源。
- Agent 的最终回答必须表明来源不可用或结果不完整，不得声称“根据小红书笔记”而没有 `sources`。
- 帖子正文与评论可以进入 Langfuse trace，形态为**脱敏后的全文**（记录字段见 [09-22-langfuse-observability.md](./09-22-langfuse-observability.md) 第 6.2 节）。两者都不进入普通日志（console / 文件日志）。
- 不记录 `xsec_token`、Cookie、二维码 Base64：这三类值必须在进入 trace、日志和答案之前脱敏，由 `lib/pi/events.ts` 的 `redactSensitive`（入口）与 Langfuse span processor 的 `mask`（出口）两层保证。
- 上游 v2.5.0 会在 info 日志输出含 `xsec_token` 的详情 URL；本地必须通过 `npm run xhs:mcp` 启动，以便在日志出口脱敏，禁止直接持久化原始输出。
- 第三方文本视为不可信外部输入，不能改变系统规则、工具权限或输出 schema。
- 发布、评论、点赞、收藏、删除 cookies 等副作用工具不进入当前 Agent 的 tool list。

### 8.1 第一阶段上下文边界

“原始帖子”指保留原始语义的清洗后字段，不等于无上限透传上游响应。建议初始限制：

| 项目 | 第一阶段默认值 | 说明 |
| --- | ---: | --- |
| 搜索候选数 | 5 | 从 `search_feeds` 结果中选择 |
| 详情帖子数 | 2 | 对候选调用 `get_feed_detail` |
| 单篇正文 | 8,000 字符 | 超出部分截断并标记 `truncated` |
| 单篇评论数 | 20 | 优先保留高相关或前序评论 |
| 单条评论 | 500 字符 | 超出部分截断 |
| 总上下文 | 30,000 字符 | 超出时减少帖子或评论数量 |

这些是服务端预算，不交给 Agent 或用户覆盖。实际数值可以通过配置调整，但必须在 tool run 摘要中只记录计数和截断状态，不记录内容。

## 9. 与现有代码的迁移关系

### 9.1 Python Agent 主链路

`agent_service/tools/xhs.py` 的 mock preset 改为根据 `XHS_SOURCE_MODE` 选择实现，但对外仍保持 `search_xhs_evidence` 名称和 `ToolResult` 结构。第一阶段的 MCP 分支只返回 `raw_posts`，不要求复用旧 preset 的 `sources/evidence` 生成逻辑。现有 `agent_service/runtime.py` 的工具注册方式和 guardrails 保持不变。

### 9.2 TypeScript 旧路径

`lib/adapters/xhs.ts` 和 `/api/sources/xhs/search` 当前仍会返回 mock preset。它们不能在 UI 中标记为真实小红书来源。切换 Agent 主链路后有两个可选处理：

- 短期保留并明确标记 `mode=mock`，只用于兼容旧页面和测试。
- 后续将该 API 改为调用 Python 的受控内部接口，避免两套 XHS 解析和来源契约长期分叉。

本 spec 推荐先完成 Python Agent 链路，再单独处理旧 TypeScript API，不在同一个改动中重写两条路径。

## 10. 测试与验收

### 10.1 单元测试

- mock 模式行为和现有测试继续通过。
- MCP text content 的 JSON 解析、字段缺失、重复 feed 去重、帖子/评论截断和总上下文预算有测试。
- `search_feeds` 成功、空结果、未登录、超时、鉴权失败和非法响应均映射到规定错误码。
- 详情单条失败时保留其他成功候选，并在上下文中标记详情不可用。
- Agent 能基于 `raw_posts` 识别帖子中明确提到的化妆品，并区分帖子原文、评论和推断。
- token 不出现在 `ToolResult`、AgentAnswer、trace metadata 和日志摘要中。
- 写工具名称不会出现在当前业务 Agent 的 MCP allowlist 中。

### 10.2 集成测试

使用一个可控的 MCP stub server 验证：

- `connect()`、工具调用和 `cleanup()` 生命周期。
- 正确发送 `/mcp` 地址和 `Authorization` header。
- MCP session 复用、超时和一次重连。
- 上游返回多个 content block 时只提取允许的文本/结构化内容。

### 10.3 L3 验收

在真实 `xiaohongshu-mcp`、已登录账号和模型 API key 下验证：

1. 用户请求“帮我找低饱和通勤妆参考”能够触发 `search_xhs_evidence`。
2. Agent 上下文中包含受控的帖子正文、标签和评论，而不是只有 preset 摘要。
3. Agent 能根据上下文回答帖子中提到的妆容特点和化妆品，并标明不确定性。
4. Agent 不会调用发布、评论、点赞、收藏等写工具。
5. MCP 停止后请求返回可解释的 `degraded`，不会出现预设 mock 来源。
6. `/api/chat` 的 SSE、最终 `looktrace.answer.v1` 和 Langfuse/tool audit 仍符合现有契约。

## 11. 分阶段交付

### Phase 0：Codex MCP 冒烟验证

在 Codex 中配置 `xiaohongshu-mcp` 的 Streamable HTTP MCP server，完成 `check_login_status`、`search_feeds` 和 `get_feed_detail` 的真实只读调用。验证 MCP 地址、鉴权、登录状态、`feed_id`/`xsec_token` 传递、帖子正文和评论返回，以及重复调用稳定性。不修改妆迹代码，不进入 Agent runtime。

阶段出口：三个必需工具均能正常调用，返回字段满足 Phase 1 的上下文需求；写工具未被调用；敏感数据未进入配置、仓库和日志。

### Phase 1：搜索结果与原始上下文

增加配置、MCP client wrapper、连接生命周期和只读工具白名单。实现 `search_feeds` + `get_feed_detail`，把帖子正文、标签和评论以受控 `raw_posts` 放入 Agent 上下文。Agent 自己判断妆容特点和化妆品。保留 mock 模式。

阶段出口：真实帖子和评论可进入上下文；Agent 能基于上下文回答；MCP 失败不产生伪造来源；所有 token 和 cookie 不泄露。

### Phase 2：上下文质量与详情扩展

优化搜索过滤、详情选择、评论相关性、重复帖子处理、分页和上下文预算。允许按用户问题选择更多详情字段，但仍不做最终结构化证据抽取。

阶段出口：在固定上下文预算内稳定获得高相关帖子和评论，单条详情失败不会污染整个结果。

### Phase 3：结构化证据与来源落库

增加 `SourceReference`、`EvidenceItem` 的规范化抽取和业务落库。此阶段才引入置信度、证据 ID、来源状态和可追溯的结构化字段；模型判断必须能回指原始帖子和评论。

阶段出口：结构化结果与原始内容一致，来源和证据可以在 answer、业务存储和 trace 之间关联。

### Phase 4：产品能力与 SKU 联动

在证据稳定后，再增加化妆品品类归一化、SKU 候选、妆匣匹配和淘宝查询。实时价格、库存和购买链接必须由独立的淘宝工具提供，不能从小红书帖子推断。

阶段出口：Agent 能区分小红书内容证据、用户已有产品和淘宝实时商品，不把帖子提及直接当成可购买 SKU。

### Phase 5：切换与旧路径治理

在明确环境中将 `XHS_SOURCE_MODE` 切换为 `mcp`；观察稳定性后决定是否收敛 `/api/sources/xhs/search` 的旧 mock 路径。

## 12. 上游已知缺陷：视频笔记的 `get_feed_detail` 必然超时

**状态**：上游 `xiaohongshu-mcp v2.5.0` 未修；已在技能层加规避。**这是临时对策，不是修复。** 定位于 2026-09-22，证据见 12.2。

### 12.1 现象与根因

`get_feed_detail` 对**视频笔记**会一直卡到 60s 的 context deadline 才失败（日志 `Tool handler panicked: context deadline exceeded`）；图文笔记正常（8–11s）。客户端 `.pi/extensions/xiaohongshu-mcp.ts` 的 `AbortSignal.timeout(45s)` 更早，所以外部只看到 45s 超时。

> **顺带一处 drift**：本文第 6 节预定客户端单次给 **75 秒**（「上游搜索页面内部最多等待 60 秒；客户端默认给单次 MCP 75 秒」），但 `.env`/`.env.example` 里是 `XHS_MCP_REQUEST_TIMEOUT_SECONDS="45"`。45 < 60 意味着**我们永远先于服务端放弃**，也就永远看不到服务端返回的真实错误（`工具 xxx 执行时发生内部错误: context deadline exceeded`），只能看到自己抛的 `The operation was aborted due to timeout`。按第 6 节改回 75 秒能拿到更有信息量的错误，但改变不了视频笔记必然失败这件事——修的是可观测性，不是可用性。

panic 栈指向确切调用点：

```text
go-rod.(*Page).MustWaitDOMStable()
  ← xiaohongshu.(*FeedDetailAction).GetFeedDetailWithConfig.func1()
     xiaohongshu/feed_detail.go:112
```

`MustWaitDOMStable` 等的是「DOM 连续静止」。视频笔记的播放器**自动播放**并持续改动 DOM，该条件永不成立。用 MutationObserver 实测（同机同时刻）：

| 笔记类型 | `<video>` | 每秒 DOM 变更（第 1–8 秒） | 是否静止 |
| --- | --- | --- | --- |
| 视频 | 1 个，playing t=7.7s | 400 40 8 14 8 13 9 9 | ❌ 一直在变 |
| 图文 | 0 个 | 365 48 2 0 0 0 0 0 | ✅ 第 3 秒起静止 |

### 12.2 证据链（单变量定位）

| 结论 | 证据 |
| --- | --- |
| 与网络无关 | 同一详情 URL 用 curl（带 MCP 自己的 cookie）**0.13s** 返回 200 + 正确标题 |
| 与 token / 登录无关 | 同上；`check_login_status` 始终正常 |
| 与限流无关 | 连续 22 次详情全部成功，无翻转 |
| 与浏览器启动无关 | 同一 Chromium 冷启动到 CDP 就绪 **0.2–0.6s** |
| **唯一变量是笔记类型** | V/N 交叉测试（顺序不成变量）：视频 **0/7** 成功，图文 **7/7** 成功 |
| 失败在 MCP 侧而非小红书侧 | 同一篇视频笔记、同一 token、同一时刻：MCP ❌ 75s 超时；普通 Chromium ✅ **1.6s** 加载完成 |

### 12.3 影响

- 真实一轮 22.8 分钟里，**82.1%**（1125s）花在 25 次失败的小红书调用上，其中详情失败独占 75.6%。
- **卡死的请求不会因客户端断开而停止**：实测有 224s、448s 才返回的调用；期间拖垮后续所有请求（连搜索也一起 60s 失败）。
- `韩系氧气妆` 的搜索结果里视频常占 45–66%，撞上概率很高。

### 12.4 临时对策（已落在工具层）

约束放在 **`.pi/extensions/xiaohongshu-mcp.ts`** 的 `xhs_get_feed_detail` 里，**不放在技能里**：

- 扩展在 `xhs_search_feeds` 返回时记录 `feed_id → noteCard.type`；`get_feed_detail` 收到已知是 `video` 的 `feed_id` 时直接返回一句说明（含 `details.reason = "video-note"`），**一次上游请求都不发**。
- 类型未知（不是本次搜索返回的）按原样放行，避免因解析失败误伤。
- `get_feed_detail` 的工具描述里补了一句本地约束，模型不必先撞一次才知道。

**为什么放工具层而不是技能层**：

| | 技能层 | 工具层（现在） |
| --- | --- | --- |
| 效力 | 行为引导，模型可以忽略 | 强制拦截，模型绕不过去 |
| 代价 | 模型仍可能试探一次，白烧 45–60s | 0 成本，不发请求 |
| 归属 | 把上游缺陷写成了产品行为 | 缺陷的规避跟着有缺陷的那个工具 |

技能（`SKILL.md` / `references/research-method.md`）保持原样，不写这条——它的职责是业务行为（读几篇、输出格式、只读边界），不是替上游的 bug 打补丁。

实测（技能复原、只留工具层拦截）：端到端 **2.6 分钟**，`/test/L1/xhs-mcp-extension.test.ts` 钉住了「视频笔记不发上游请求」这条不变量。

**代价不变**：丢掉大部分「跟练」类内容（搜索结果里视频常占 45–66%），来源广度变窄。

### 12.5 解除条件

以下两条**都**满足才可撤掉技能层的约束：

1. 上游修掉 `feed_detail.go:112` 的 `MustWaitDOMStable`（改成等特定元素出现，或对 `<video>` 先暂停 / 不等待）；
2. 用同一批视频笔记验收：**从 0/7 变成全部成功，且耗时回到 10s 量级**。只变快不算，**必须是失败率归零**。

换成新的 MCP 实现时，按同一条验收。是否解除由维护者判定，**不要让模型自行试探视频笔记**。

## 13. 搜索被风控拦到安全验证页，必然等满 60 秒

**状态**：不是上游 bug，是小红书风控对自动化搜索的响应；**当前没有代码层解法**。定位于 2026-09-23，证据见 13.2。

### 13.1 现象与根因

`search_feeds` 只有两种结局，没有中间态：要么 ~5s 成功，要么必然卡满 60s 后 panic。panic 栈：

```text
go-rod.(*Page).MustWait()
  ← xiaohongshu.(*SearchAction).Search
     xiaohongshu/search.go:110
```

第 110 行等的是 `window.__INITIAL_STATE__ !== undefined`（对该二进制 `strings` 确认过这个字面量确实在里面）。

**关键：这不是「页面加载慢」。** 用 CDP 挂在 MCP 自己的浏览器上实测，失败时页面 1 秒内就 `readyState=complete`、`__INITIAL_STATE__` 已存在、DOM 抖动 3 秒内归零——但浏览器停在的**根本不是搜索页**：

```text
https://www.xiaohongshu.com/website-login/captcha?…&verifyType=124&verifyBiz=461
title = "安全验证"
```

该页不定义 `__INITIAL_STATE__`，等待条件永远不成立，于是等满 60s。

> **定位过程中的一个坑**：MCP 每次调用都 `newBrowser()` 新建浏览器，而 `defer b.Close()` 关不掉它，进程会一直泄漏。所以用探针排查时，**同时活着的浏览器里既有当前调用的、也有几分钟前遗留的**，很容易把遗留浏览器的页面状态当成当前调用的。13.2 里"真实链路复验"那一行是按关键词+时间对齐到当前调用之后才成立的。

### 13.2 证据链（单变量定位）

用**同一个内置 Chromium、同一套 30 个启动参数、同一关键词**，只切换 cookie，**交替对照**（排除"请求太频繁"这类时间相关解释）：

| 条件 | 结果 |
| --- | --- |
| 不带 cookie | 成功 4/4（~350ms） |
| 带全部 19 条 cookie | 失败 4/4 → 安全验证页 |
| 只带登录身份 5 条（`web_session,webId,a1,gid,id_token`） | 失败 4/4 |
| 只带风控/设备 14 条 | 成功 4/4 |
| **只带 `web_session` 一条** | **失败 4/4** |
| 只带 `id_token` | 成功 4/4 |
| 只带 `a1,webId,gid` | 成功 4/4 |

**唯一变量是 `web_session`（登录态）：有它必失败，去掉它必成功。** 真实链路复验：连续 5 次搜索全部 60.6s 失败，探针采样 20 次停在 captcha 页。

同时排除掉的其他解释：

| 假设 | 反证 |
| --- | --- |
| 无头模式被识别 | 旧 `--headless` 与新 `--headless=new` **都**跳验证页 |
| 新设备指纹可疑 | 同一 profile 连跑 4 次仍全部失败 |
| 会话已失效 | `check_login_status` 返回 ✅ 已登录 |
| 账号被全站封禁 | 首页、个人页正常，**只有搜索接口**被挑战 |
| 等一等会自愈 | 静置 30 分钟、期间不发任何请求，重测仍是验证页 |
| 页面加载慢 | 失败时页面 1s 内 complete 且 `__INITIAL_STATE__` 已在 |

### 13.3 影响

- **搜索必须登录，所以不能靠"不带 `web_session`"绕过**：匿名访问搜索页时页面直接显示「登录后查看搜索结果」，`search.feedCount` 为 0。去掉 cookie 只是把 60s 超时换成 0 条结果。
- 账号被标记后**每一次**搜索都失败，每次烧 60s；一轮多关键词搜索的端到端时间因此推到十几分钟以上。
- 触发面是累积的：实测同一天内从"约一半失败"恶化到"全部失败"（期间有大量自动化调用，含本次定位的复现测试）。

### 13.4 缓解（都不是修复）

| 手段 | 性质 |
| --- | --- |
| 工具层识别 `/website-login/captcha` 后立即失败 | 与根因无关，纯省时间：每次失败从 60s 降到 1s。**待做** |
| 固定复用同一个浏览器 profile | 现在每次调用都 `newBrowser()` 新建，等于每轮都拿"全新设备 + 老登录态"去搜索，是风控最强的信号。**待验证**（需先解除当前标记，否则测不出效果） |
| 手机 App 扫码通过验证 | 解除**当前**标记的唯一路径；不防再次触发 |
| 换非浏览器自动化的数据源 | 根治方向：只要还是自动化打网页搜索接口，就是持续的猫鼠游戏 |

### 13.5 解除条件

扫码恢复后，用同一批关键词验收：**连续 20 次搜索失败率为 0，且每次都拿到非空结果**。只变快不算。恢复后应同时做"固定复用 profile"的改造，否则会被再次标记。

## 14. 待评审问题

- 第零阶段是否由开发者手工在 Codex 中执行，还是需要补充可重复的 MCP Inspector 验证脚本？
- 第一阶段是否接受“最多 3 条详情 + 评论进入上下文”的延迟和 token 成本？
- 第一阶段的默认帖子、正文、评论和总上下文上限是否需要调整？
- 第二阶段是否需要分页或评论相关性排序？
- 第三阶段再引入 `confidence` 时，优先规则分数还是模型辅助抽取？
- 真实环境的小红书 MCP 服务放在同机、局域网还是独立容器？这会影响 `XHS_MCP_URL`、账号持久化和浏览器运行环境。
- `/api/sources/xhs/search` 是否需要在本次接入中同步切换，还是先保持兼容 mock？
- 是否需要把 `check_login_status` 暴露成管理员健康检查接口，而不是仅在服务启动时调用？

## 15. 阶段出口

满足第零阶段条件后，才允许开始第一阶段应用接入；满足第一阶段条件后，可在开发或内部环境使用 `XHS_SOURCE_MODE=mcp`；满足第五阶段条件后，才允许把生产默认环境切换为 MCP：

- 第零阶段的 Codex MCP 冒烟验证全部通过。
- 第一阶段的 stub 和真实 L3 测试通过。
- 真实帖子正文和评论能够进入受控 Agent 上下文，并通过上下文预算限制。
- Agent 能正确区分帖子明确提及、评论提及和自身推断。
- 登录失效、MCP 停止、超时和非法响应都有明确降级结果。
- 读工具白名单生效，写工具在 Agent 侧不可见、不可调用。
- `xsec_token`、Cookie 和二维码数据不会进入客户端、业务存储、Langfuse 或普通日志。
- 后续阶段的结构化来源、证据和 SKU 结果能映射到 `looktrace.answer.v1`，且不存在无来源的“真实小红书”声明。
