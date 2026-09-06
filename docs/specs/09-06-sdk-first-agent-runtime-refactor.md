# 妆迹 SDK-first Agent Runtime 重构规范

Status: Draft  
Date: 2026-09-06  
Related specs: [09-04-agent-runtime-and-observability.md](./09-04-agent-runtime-and-observability.md), [09-05-phase-1-agent-runtime.md](./09-05-phase-1-agent-runtime.md), [001-mvp.md](./001-mvp.md)

## 0. 文档目的

本文定义妆迹从“TypeScript 固定 pipeline + Python runtime spike”迁移到“Python OpenAI Agents SDK 作为唯一 Agent 执行入口”的目标架构和实施边界。

本文解决的是 Agent runtime 重构，不扩大妆迹产品范围。小红书、妆匣和淘宝仍然是妆迹自己的业务能力；OpenAI Agents SDK 负责通用的 Agent 编排、工具循环、会话上下文、结构化输出、运行事件和 tracing。

## 1. 决策摘要

### 1.1 目标决策

- Python `openai-agents` runtime 是唯一的 Agent 执行入口。
- Next.js 只负责鉴权、请求校验、SSE 转发、业务存储和客户端取消传播。
- 小红书、妆匣、淘宝能力全部以 SDK function tools 暴露给 Agent。
- 同一 `conversationId` 使用服务端持久化 session，Agent 不依赖浏览器提交完整历史。
- 使用 `Runner.run_streamed()` 产生真实模型和工具事件；禁止把最终文本切片伪装成流式输出。
- 最终业务结果使用结构化 schema 校验；自然语言展示文本是结构化结果的一部分，而不是唯一事实载体。
- 输入、工具结果和输出的安全与业务约束使用 guardrails 和应用层 policy 双重校验。
- handoffs 暂不作为第一阶段必需能力，仅保留扩展边界。
- 旧 `lib/agent/pipeline.ts` 在迁移完成后退出主链路，不再与 SDK Agent 并行决定业务结果。

### 1.2 当前问题

当前实现存在以下结构性问题：

- `/api/chat` 调用固定的 TypeScript pipeline，未使用 Agents SDK。
- `/api/agent-runtime/spike` 虽然调用 `Runner.run`，但没有 session，跨用户轮次没有上下文记忆。
- Python runtime 在 Agent 完成后才把最终文本切成 chunk，当前 SSE 不是模型真实流式输出。
- 领域工具、业务顺序、回答拼装和权限边界分散在应用代码中，SDK 只承担了最小的 tool loop。
- 结构化领域对象没有成为 Agent 的最终输出契约。

## 2. 范围

### 2.1 本次重构必须实现

- 一个服务端 Python Agent runtime。
- 一个持久化 conversation session 实现，开发环境可使用 SQLite，生产环境使用 PostgreSQL 或 Redis-backed store。
- 以下业务能力的 SDK tools：小红书证据、妆匣读取/匹配、淘宝商品、来源与运行记录。
- SDK 原生 streamed run 到稳定应用事件的适配层。
- 结构化最终结果、输入 guardrail、工具结果校验和输出 guardrail。
- 用户身份与 conversation 的服务端授权隔离。
- 从现有两条入口迁移到一个 Agent 入口。
- 单元、集成、端到端和多轮上下文验收。

### 2.2 本次重构不实现

- 图片理解、试妆或视觉模型。
- 自动下单、返利、库存追踪。
- 后台长任务、定时任务、人工审批和 workflow engine。
- 自动学习用户偏好或长期审美画像。
- 多 Agent handoff 的完整产品化；只保留未来可接入的边界。
- 模型隐藏 chain-of-thought 的记录或展示。

## 3. 目标架构

```text
Web Client
    |
    | POST /api/chat + SSE
    v
Next.js API Layer
    |  鉴权、输入校验、conversation 授权、SSE 代理
    v
Python Agent Runtime
    |
    +--> Session Store
    |       +--> conversation items
    |       +--> compacted summary
    |
    +--> OpenAI Agents SDK Runner
    |       +--> Looktrace Agent
    |       +--> streamed model/tool events
    |       +--> structured final output
    |       +--> guardrails
    |
    +--> Domain Tools
    |       +--> search_xhs_evidence
    |       +--> get_user_products / match_user_products
    |       +--> search_taobao_offers
    |       +--> save_evidence / save_tool_run
    |
    +--> Business Storage / Langfuse
```

### 3.1 代码边界

```text
app/api/chat/route.ts                    HTTP、鉴权、SSE 代理
agent_service/main.py                    FastAPI、请求生命周期、取消
agent_service/runtime.py                 Agent factory、Runner、事件适配
agent_service/context.py                 RuntimeContext、授权后的依赖
agent_service/sessions.py                session store 与历史压缩
agent_service/schemas.py                 Pydantic tool/result schemas
agent_service/guardrails.py              输入、工具结果、输出校验
agent_service/tools/xhs.py               小红书工具
agent_service/tools/beauty_kit.py        妆匣工具
agent_service/tools/taobao.py            淘宝工具
agent_service/tools/records.py            业务记录工具
agent_service/observability.py           Agents tracing/Langfuse
lib/agent/pipeline.ts                    迁移期间保留，切流后删除主入口
```

Next.js 不创建 Agent、调用模型、执行工具或拼接最终答案。Python runtime 不接受客户端传入的 API key、Cookie、数据库连接或任意 `userId` 作为工具参数。

## 4. 责任分界

| 能力 | OpenAI Agents SDK | 妆迹应用层 |
| --- | --- | --- |
| Agent loop | 调用模型、识别 tool call、回传 tool result、继续运行 | 设置业务预算和终态映射 |
| Session | 通过 SDK session 接口读取/写入会话 items | 提供持久化实现、租户隔离、摘要和保留策略 |
| Tool schema | 参数 schema、调用协议、工具执行入口 | 业务查询、权限、超时、重试、结果脱敏 |
| Streaming | streamed run、模型增量、工具生命周期事件 | 转成稳定 SSE，不暴露 SDK 原始事件名 |
| Structured output | 约束最终 Agent output | 定义业务 schema、版本、落库和降级 |
| Guardrails | 执行 SDK guardrail 生命周期 | 定义医疗、来源、用户隔离和产品政策 |
| Tracing | Agent/model/tool span | 关联业务 ID、Langfuse 字段和本地审计 |
| 业务语义 | 不负责 | 妆容、来源、SKU、妆匣和回答边界 |

## 5. Runtime Context 与 Session

### 5.1 服务端运行上下文

每个请求创建不可由模型修改的上下文：

```python
class RuntimeContext:
    user_id: str
    conversation_id: str
    message_id: str
    trace_id: str
    agent_run_id: str
    started_at: str
    max_turns: int
    timeout_seconds: float
    tool_budget: dict[str, int]
```

该对象通过 Agents SDK 的 run context 注入工具。它不是用户可见 prompt，也不自动作为模型文本上下文；工具只能读取其中经过授权的依赖。

### 5.2 Conversation 与 session

- `conversationId` 由服务端创建或校验归属，客户端只能引用自己有权限的会话。
- session key 必须包含 `userId` 作用域，不能只用客户端提供的字符串。
- session 保存用户消息、Agent 最终结果、工具调用及工具结果中允许进入上下文的内容。
- trace、业务消息和 session item 是不同存储概念，但通过 `conversationId`、`messageId` 和 `traceId` 关联。
- SDK session 是 Agent 的上下文来源；Langfuse session 只是观测分组，不能替代 Agent session。
- 历史超过预算时，先保留最近轮次，再将旧轮次压缩成服务端摘要。摘要必须标记来源和不确定性，不能把推测写成用户事实。
- session 读写失败时不得静默当成新会话；应返回明确的 `SESSION_UNAVAILABLE` 或进入受控降级模式。

开发实现可以先采用 SDK 提供的 SQLite session；生产实现必须使用共享、可备份、带 TTL/容量策略的持久化 store。禁止使用 Python 进程内列表作为生产 session。

### 5.3 多轮验收语义

以下对话必须在同一 session 中成立：

```text
用户：帮我做一个低饱和通勤妆
Agent：给出妆容拆解和资料依据
用户：那油皮要换哪些？
Agent：理解“那”指向上一轮通勤妆，并只调整油皮相关的质地、底妆和持妆建议
```

第二轮 trace 的输入和 session 读取记录必须能证明历史被使用，但不得记录隐藏推理。

## 6. Domain Tools

### 6.1 工具清单

第一阶段注册以下工具，工具可拆分但不能恢复成固定 pipeline：

| Tool | 类型 | 触发场景 | 结果重点 |
| --- | --- | --- | --- |
| `search_xhs_evidence` | 只读 | 需要妆容资料或来源依据 | 来源、摘要、证据、置信度、失败状态 |
| `get_user_products` | 只读 | 用户提到已有产品、替代或“不用买” | 当前用户妆匣及字段脱敏结果 |
| `match_user_products` | 只读 | 已有产品和目标妆效匹配 | 可用、部分匹配、不适合、缺口 |
| `search_taobao_offers` | 只读 | 需要 SKU、价格或购买渠道 | 商品、色号、价格状态、渠道、链接状态 |
| `save_evidence` | 写入 | Agent 确认本轮使用的来源 | 业务 evidence ID 与 trace 关联 |
| `save_tool_run` | 写入 | 每次工具结束 | tool run 摘要、状态、延迟、错误码 |

`save_evidence` 和 `save_tool_run` 是否暴露给模型需要单独评估；如果只是审计副作用，优先由 runtime 在事件结束后写入，而不是让 Agent 自主决定是否调用。

### 6.2 工具契约

每个工具必须满足：

- 输入使用严格 schema；不得接受 `userId`、API key、Cookie 或任意数据库查询语句。
- 结果使用结构化 schema，包含 `status: succeeded | degraded | failed`。
- 业务失败返回可解释的错误码和可供 Agent 继续判断的摘要。
- 外部原始响应在工具边界截断、脱敏和规范化。
- 工具内部异常不直接进入模型或客户端。
- 权限、超时、重试和重复调用保护由应用层执行。
- 只读工具不能修改用户数据；写入工具必须有明确幂等键。

### 6.3 工具选择原则

Agent 可以跳过不需要的工具，但不能违反硬约束：

- SKU 推荐必须有来源依据，或明确说明资料不可用。
- 用户问已有产品时必须读取妆匣；无法读取时不得声称已经检查。
- 淘宝不可用时不得声称实时价格、库存或购买链接。
- 医疗、过敏、破损等问题不能通过商品工具伪装成普通推荐。

## 7. Structured Output

### 7.1 最终结果 schema

最终 Agent output 使用版本化 Pydantic schema，建议结构如下：

```python
class AgentAnswer(BaseModel):
    schema_version: Literal["looktrace.answer.v1"]
    status: Literal["succeeded", "clarification", "degraded", "failed"]
    answer_text: str
    clarification_question: str | None
    look_features: LookFeatureSet
    sources: list[SourceReference]
    sku_candidates: list[SkuCandidate]
    owned_product_match: OwnedProductMatch
    uncertainty: list[str]
    tool_run_ids: list[str]
```

业务事实必须来自结构化字段；`answer_text` 只负责面向用户的表达。客户端不能自行从自然语言中解析 SKU、来源或妆匣判断。

### 7.2 输出约束

- 所有来源引用必须引用本次工具返回的来源 ID。
- 所有 SKU 必须标记 `live`、`placeholder` 或 `unavailable` 状态。
- 没有足够信息时输出 `clarification`，而不是填充猜测字段。
- schema 校验失败时不得把原始模型文本当作成功结果；进入一次受控修复或 `failed`/`degraded` 终态。
- schema 版本变更必须兼容前端和业务存储迁移。

## 8. Guardrails

### 8.1 输入 guardrails

输入 guardrails 至少覆盖：

- 空输入和超长输入。
- 医疗诊断、治疗承诺、过敏和皮肤破损风险。
- prompt 注入、要求泄露系统规则或内部凭据。
- 跨用户读取妆匣、来源或会话的请求。
- 与妆容/产品无关且不应触发高成本工具的请求。

输入被拒绝时返回明确的 `clarification` 或 `failed`，不进入外部搜索工具。

### 8.2 工具结果 guardrails

- 来源结果必须有来源 ID、抓取状态和不确定性。
- 工具结果不能包含凭据、Cookie、内部堆栈或未脱敏个人信息。
- 淘宝结果必须区分实时、缓存和占位数据。
- 妆匣结果必须带授权用户作用域。
- 工具返回 schema 失败时，runtime 终止该工具分支并允许安全降级。

### 8.3 输出 guardrails

- 推荐类回答必须有来源或明确的资料不可用说明。
- 不得声称未调用的工具已经调用，也不得声称未返回的事实已经验证。
- 不得输出系统 prompt、工具原始 JSON、API key 或隐藏推理。
- 医疗边界、价格状态和来源不确定性必须在最终结果中保留。
- 输出 guardrail 失败时优先进入 `degraded`，不能无限重复模型修复。

## 9. Streaming 与 SSE

### 9.1 执行要求

runtime 使用 `Runner.run_streamed()`。SDK 原始事件只在 Python adapter 内部处理，前端只依赖稳定的应用事件。

禁止：

- 等待最终答案后再切片制造 chunk。
- 把 SDK 私有事件名直接暴露到浏览器。
- 将每个 token 写成独立业务记录。

### 9.2 应用事件

```text
run_started    { run, conversation }
status         { phase, message }
text_delta     { text }
tool_started   { toolName, callId, inputSummary }
tool_finished  { toolName, callId, status, outputSummary }
result         { answer, status, run }
error          { code, message }
```

`result.answer` 必须是通过 schema 校验的结构化结果。若客户端需要逐字展示，`text_delta` 只用于展示；最终业务状态以 `result` 为准。

### 9.3 取消和断连

- 浏览器断开连接时，Next.js 将 abort 传播到 Python runtime。
- Python runtime 取消 Runner、停止工具调用并 flush 观测数据。
- 取消只能产生一个终态：`cancelled`；不得在取消后继续写入新的模型或工具调用。
- SSE 代理不能吞掉 runtime 的最终错误码。

## 10. Handoffs 边界

第一阶段只使用一个主 Agent。不要为了体现 SDK 能力提前拆分多个 Agent。

未来只有在以下情况之一成立时才引入 handoff：

- 不同领域需要完全不同的工具白名单和系统规则。
- 单个 Agent 的工具描述已经导致选择质量下降。
- 需要明确的领域责任转移和独立 trace。

handoff 的输入输出必须仍然使用结构化 schema和同一个用户 session；handoff 不能绕过鉴权、guardrails 或工具预算。

## 11. 可观测性

### 11.1 Trace 层级

```text
looktrace.chat.turn
└── agents.run
    ├── model.generation
    ├── tool.search_xhs_evidence
    ├── model.generation
    ├── tool.get_user_products
    └── final.output
```

每次运行至少关联：`userId`（脱敏）、`conversationId`、`messageId`、`agentRunId`、`traceId`、模型、schema 版本、session item 数量、工具顺序、usage、延迟、终态和错误码。

### 11.2 数据边界

Langfuse 可以保存用于排障的输入、工具参数摘要和最终输出，但不得保存 API key、Cookie、完整账号池配置或隐藏 chain-of-thought。业务事实仍保存于妆迹业务存储，Langfuse 只通过 ID 关联。

Langfuse 不可用不能阻塞用户请求；本地 audit 至少保留 run 状态、工具调用摘要、延迟和错误码。

## 12. 迁移计划

### 阶段 A：冻结边界

- 将 `/api/agent-runtime/spike` 更名为稳定的 `/api/chat` runtime 入口。
- 明确 `lib/agent/pipeline.ts` 只作为迁移参考，不再新增业务逻辑。
- 锁定 Agents SDK、Python、模型 provider 和 streaming API 版本。
- 为所有领域对象建立 Python schema 和 TypeScript 展示类型。

出口：只有一个被前端调用的 runtime 入口，旧 pipeline 仍可回滚但不再产生主结果。

### 阶段 B：Session 与 context

- 实现 session store 接口和 SQLite 版本。
- 将 `userId + conversationId` 作为授权键。
- 引入历史摘要、最大 item 数和容量测试。
- 增加“第二轮引用第一轮”的集成测试。

出口：服务重启后同一会话仍能正确理解后续追问。

### 阶段 C：工具迁移

- 把 `searchXhsEvidence`、`listUserProducts`、`hydrateTaobaoOffers` 等能力包装成 SDK tools。
- 每个工具先通过 schema、权限、失败和超时测试，再加入 Agent tool list。
- 移除 `runLooktraceAgent` 中的固定调用顺序。

出口：工具调用顺序由 Agent 决定，业务代码只提供能力和硬约束。

### 阶段 D：真实 streaming

- 用 `run_streamed` 替换最终文本切片。
- 建立 SDK event adapter 和 SSE 契约测试。
- 验证工具开始、工具结束、文本增量和最终结果的顺序。

出口：客户端在模型运行期间能收到事件，而不是等待最终答案后才看到 chunk。

### 阶段 E：Structured output 与 guardrails

- 建立 `AgentAnswer` v1。
- 接入输入、工具结果和输出 guardrails。
- 将前端从自然语言解析切换为结构化 `result.answer`。

出口：schema、引用、商品状态、妆匣匹配和安全边界均有自动测试。

### 阶段 F：切流与删除旧路径

- 前端只请求新的 Python Agent 入口。
- 观察一段时间的质量、延迟、工具命中率和成本。
- 删除 `/api/chat` 旧 pipeline 中的重复业务编排。
- 保留领域 adapters 和业务 storage，不删除真实业务能力。

出口：仓库中不存在第二套会决定最终答案的 Agent 编排路径。

## 13. 测试与验收

### 13.1 必须覆盖的测试

- `SESSION-001`：同一 session 的追问能使用前一轮上下文。
- `SESSION-002`：不同用户不能读取同一 conversation。
- `SESSION-003`：历史摘要不会把推测写成用户事实。
- `TOOL-001`：Agent 能自主调用小红书工具。
- `TOOL-002`：已有产品问题必须调用妆匣工具。
- `TOOL-003`：购买问题才调用淘宝工具。
- `TOOL-004`：工具失败进入 `degraded`，不虚构结果。
- `STREAM-001`：运行期间收到真实 text/tool 事件。
- `STREAM-002`：断连会取消 Runner，不产生后续 tool call。
- `OUTPUT-001`：最终结果符合 schema v1。
- `OUTPUT-002`：缺少来源时不能输出成功推荐。
- `GUARD-001`：医疗风险请求不会进入商品工具。
- `GUARD-002`：提示词注入不能泄露系统规则和凭据。
- `RUNTIME-001`：超过 turn、超时、重复 tool call 都有唯一终态。

### 13.2 发布门槛

- 主链路只有一个 Agent runtime 入口。
- 多轮 session 测试通过，并覆盖服务重启后的持久化读取。
- 真实 streaming 事件顺序稳定，不能依赖 SDK 私有事件名。
- 所有领域工具都有 schema、权限、超时和失败测试。
- structured output 校验失败不会被当成成功答案。
- Langfuse 不可用时主链路仍可完成，audit 能还原运行摘要。
- OpenAI provider 路径通过完整验收；DeepSeek 或其他兼容 provider 必须另行通过 tool calling、structured output 和 streaming 兼容性测试，不能仅凭 Chat Completions 可调用就视为兼容。

## 14. 主要风险与取舍

### R1：Agent 自主性降低确定性

固定 pipeline 的顺序更容易测试。迁移后用工具 schema、guardrails、硬约束、eval 和运行预算约束自主行为；如果某个任务质量持续不足，再在 Agent 外增加受控 workflow，而不是恢复第二套隐藏 pipeline。

### R2：Session 历史增加 token 和隐私成本

使用最近轮次、服务端摘要、字段脱敏和容量上限。session store 与 Langfuse 分开管理，删除会话时定义两边的保留策略。

### R3：第三方 provider 对 SDK 高级能力支持不完整

先以 OpenAI provider 作为 SDK 兼容基线。DeepSeek 等 provider 必须以真实 tool calling、streaming、结构化输出和错误路径测试为准；不通过时应降级到明确的 provider 能力子集，而不是伪装成完整兼容。

### R4：业务规则被 prompt 取代

授权、来源真实性、医疗边界、商品状态和写入幂等性必须由代码和 guardrails 强制执行，不能只写在 system instructions 中。

## 15. 官方参考

- [OpenAI Agents SDK Sessions](https://developers.openai.com/agents/sdk/sessions)
- [OpenAI Agents SDK Streaming](https://developers.openai.com/agents/sdk/streaming)
- [OpenAI Agents SDK Guardrails](https://developers.openai.com/agents/sdk/guardrails)
- [OpenAI Agents SDK Handoffs](https://developers.openai.com/agents/sdk/handoffs)
- [OpenAI Agents SDK Tracing](https://developers.openai.com/agents/sdk/tracing)
