# 妆迹 Agent Runtime 与可观测性规范

Status: Draft
Date: 2026-09-04
Related spec: [001-mvp.md](./001-mvp.md)

## 0. 文档目的

本文是给产品、工程和评审人员使用的架构规范，记录妆迹 MVP 的 Agent 基底、运行方式、可观测性、阶段出口和后续演进原则。

本文不替代 `001-mvp.md`，不规定数据库 migration 或任务排期；但锁定 Agent runtime 的嵌入边界、事件契约和应用层职责。具体实施步骤放在 `docs/plan/`。

本文中的“OpenAI Agent Runtime”采用 OpenAI Agents SDK 的 Python 服务端 SDK（包名 `openai-agents`）。Next.js 只负责请求校验和 SSE 代理；Python SDK 负责 Agent loop、模型调用、工具调用、guardrails、handoffs（如后续需要）和运行保护。SDK 只在服务端运行，不向浏览器暴露模型凭据或 Agent 实例。

## 1. 决策摘要

妆迹 MVP 采用 OpenAI Agents SDK 作为 Agent runtime，采用类似 ReAct 的自主工具调用方式。Agent 根据当前问题、已有上下文和工具结果，自行判断是否需要澄清、搜索小红书、读取妆匣、查询淘宝或结束回答。

OpenAI Agent Runtime 只负责 Agent 的运行能力。妆迹自己的产品语义、数据模型、外部平台接入、用户隔离、回答规则和安全边界由妆迹定义。

MVP 采用 Langfuse 作为 Agent 和 LLM 可观测性平台。业务来源、证据、SKU 候选、妆匣和评测结果仍属于妆迹业务数据，需要保存在业务存储中，并通过 trace 标识与 Langfuse 关联。

Hermes 和 OpenClaw不作为整体产品底座：Hermes 的中心抽象更接近通用个人助手，OpenClaw 的中心抽象更接近多渠道 gateway；它们可以作为能力组织、权限、渠道适配和未来演进的参考。

## 2. 目标与非目标

### 2.1 目标

本方案需要支持：

- 用户用自然语言提出妆容目标。
- Agent 自主判断是否需要澄清以及需要哪些工具。
- Agent 通过小红书资料形成可追溯的妆容证据。
- Agent 把妆容特点映射到化妆品能力和 SKU 候选。
- Agent 在用户提到已有产品时读取并匹配用户妆匣。
- Agent 在需要时查询淘宝商品信息，并诚实处理占位或失败状态。
- 用户看到流式回答和易懂的处理状态。
- 工程人员可以还原 Agent 的调用链、耗时、错误、成本和来源依据。
- MVP 结束后可以在 Agent Runtime 外层增加受控工作流，而不替换 Agent runtime。

### 2.2 非目标

本方案不在 MVP 中实现：

- 图片理解和视觉试妆。
- 自动偏好学习、长期审美画像和反馈记忆。
- 多渠道消息产品。
- 自动下单、返利或电商交易闭环。
- 复杂的长时间任务、定时任务和人工审批工作流。
- 把 Hermes 或 OpenClaw 的完整个人助手能力迁移进妆迹。

## 3. 设计原则

### 3.1 MVP 先自主，边界必须可验证

MVP 不预先编码一条固定的完整工作流。Agent 可以根据问题决定工具和顺序，以验证它是否能自主完成妆容拆解、产品选择和妆匣匹配。

自主不等于无约束。以下是必须可以被测试和追踪的业务边界：

- 涉及妆容判断或 SKU 推荐时，必须以可追溯的小红书资料为依据，或明确说明资料不可用。
- 用户询问已有产品、替代方案或“不用买什么”时，必须读取该用户的妆匣。
- 没有妆匣时，不能把录入妆匣作为继续回答的前置条件。
- 没有真实淘宝结果时，不能声称获得实时价格、渠道或购买链接。
- Agent 不能访问其他用户的数据或服务端凭据。
- 工具失败时必须返回可供 Agent 继续处理的降级状态。
- 用户询问皮肤病、过敏或破损等医疗相关问题时，不得给出诊断或激进治疗建议。

### 3.2 结构化事实与自然语言分离

Agent 可以用自然语言判断和表达，但来源、证据、产品能力、SKU 和妆匣必须使用结构化领域对象表示。

用户最终看到自然语言和结构化展示区块，不应看到工具原始 JSON、系统 prompt、模型隐藏 chain-of-thought 或内部错误堆栈。

### 3.3 运行记录与业务记录分离

Langfuse 记录 Agent 的运行过程，重点是模型调用、工具调用、耗时、token、错误、版本和质量评分。

业务存储记录妆迹的事实，重点是来源、证据、候选 SKU、用户妆匣、会话消息和 eval 结果。

两者通过 `trace_id`、`agent_run_id`、`conversation_id` 和 `message_id` 关联，但不要求把完整业务原文复制到 Langfuse。

## 4. 目标架构

```text
Web Client
    |
    v
Application/API Layer
    |
    +--> OpenAI Agent Runtime
    |       |
    |       +--> XHS evidence tools --> XHS account-pool adapter
    |       +--> Beauty-kit tools ----> product storage
    |       +--> Commerce tools ------> Taobao adapter
    |       +--> Answer/validation tools
    |
    +--> Business Storage
    |       +--> users, conversations, messages
    |       +--> source_items, evidence_items
    |       +--> user_products, product_candidates
    |       +--> tool_runs, eval_cases, eval_runs
    |
    +--> Langfuse
            +--> traces, spans, generations, scores
```

OpenAI Agent Runtime 位于应用服务端，不能直接暴露给浏览器。小红书账号池、淘宝凭据、模型凭据和内部存储均属于服务端边界。

### 4.1 OpenAI Agent Runtime 的内部职责

OpenAI Agent Runtime 只覆盖以下通用能力：

| Agent 层 | SDK 能力 | 职责 |
| --- | --- | --- |
| Agent loop | `Agent`、`run` | 调用模型、识别 tool call、执行工具、把 tool result 放回上下文并继续循环 |
| 模型调用 | OpenAI Agents SDK model interface | 调用 OpenAI 模型并统一处理模型响应和 usage；其他供应商不作为 MVP 目标 |
| 工具执行 | function tools / tool schema | 工具参数校验、工具执行、错误返回和结果回传 |
| Agent 约束 | guardrails、runner 配置和应用层 policy | 对输入、工具结果和最终输出执行安全与业务约束 |
| 事件流 | SDK run events / streaming events | 发出模型增量、工具开始/结束、turn 和 agent 生命周期事件 |

OpenAI Agent Runtime 不负责妆容语义、用户授权、业务数据、来源真实性、Langfuse 业务字段或最终回答规则。

### 4.2 妆迹应用层的代码边界

目标代码结构如下，目录名是推荐边界，不要求 SDK 内部目录与其一致：

```text
app/api/chat/route.ts          HTTP/SSE 传输层
agent_service/runtime.py       创建 Agent、上下文和运行保护
agent_service/observability.py trace/span/generation 适配
.agent/SYSTEM.md               妆迹 Agent 系统规则
```

当前 `lib/agent/pipeline.ts` 是固定业务顺序的本地 pipeline。接入 OpenAI Agents SDK 后，它应被拆成可供 Agent 选择的工具实现；`route.ts` 只负责创建请求上下文、订阅运行事件、转发 SSE 和处理异常，不再硬编码完整调用顺序。

### 4.3 服务端上下文与身份注入

每次请求先由应用层创建不可由模型修改的上下文：

```text
userId（来自服务端认证）
conversationId
messageId
sessionId / traceId / agentRunId
会话摘要和当前妆匣摘要
工具超时、重试和循环预算
```

自定义工具通过闭包接收该上下文。工具参数中不得出现可任意指定的 `userId`、凭据或数据库连接。Agent 只能看到脱敏后的工具结果，不能获得 Cookie、API key 或账号池配置。

### 4.4 OpenAI Agents SDK 事件到应用层的映射

```text
SDK message/output delta             -> SSE chunk
SDK tool start event                 -> SSE status + Langfuse tool span start
SDK tool end event                   -> SSE tool summary + Langfuse span end
SDK model generation events          -> Langfuse generation
SDK agent/run end                    -> 保存最终答案并关闭 trace
```

文本增量可以直接流式转发，但不为每个 token 创建独立 trace/span。业务 `tool_runs` 继续作为 Langfuse 不可用时的本地审计兜底。

## 5. Agent 行为规范

### 5.1 自主 ReAct 循环

Agent 应支持以下运行模型：

```text
读取用户消息和上下文
  -> 判断当前还缺什么信息
  -> 选择一个工具或直接回答
  -> 读取工具结果
  -> 继续判断
  -> 输出最终回答或提出一个关键澄清问题
```

Agent 不要求每次都调用所有工具：只问妆容特点的问题可以查资料并完成拆解；询问“我手里的产品能不能用”的问题应读取妆匣并进行匹配；只有需要购买信息时才查询淘宝。

### 5.2 工具边界

MVP 工具覆盖以下能力。工具可以在实施阶段合并或拆分，但能力边界不能消失：

- 资料：搜索小红书、读取可访问笔记、导入用户粘贴内容。
- 分析：从用户目标和资料证据中提取妆容特点与产品能力。
- 商品：生成 SKU 候选、查询淘宝商品信息。
- 妆匣：读取、匹配和维护当前用户的化妆品。
- 运行：记录来源引用、工具结果和 Agent 运行状态。

工具应返回结构化的成功、降级或失败状态。工具不得把账号 Cookie、API key 或其他内部凭据作为结果返回给 Agent。

### 5.3 运行保护

MVP 必须具备基础保护：

- 单次运行有最大模型/工具循环次数。
- 单个工具有超时和有限重试策略。
- 相同输入的工具重复调用受到限制。
- 结构化输出无法解析时进入可解释的降级路径。
- 运行失败时前端能收到明确状态，不显示内部堆栈。
- Agent 结束时必须有成功、澄清、降级或失败中的一种最终状态。

SDK 的 Agent loop 会持续运行到没有新的工具调用；业务级最大 turn/工具次数由 Python runtime 通过 `Runner.run` 配置、事件计数或取消信号实现，不能假设 SDK 会自动理解妆迹的成本预算。

## 6. 可观测性规范

### 6.1 Langfuse 的职责

MVP 使用 Langfuse 追踪 LLM 和 Agent 行为，并允许通过 OpenTelemetry 或 Langfuse SDK 接入。具体 SDK 版本和初始化方式属于实施方案，不在本规范中固定。

Langfuse 不负责：

- 妆迹业务数据的最终存储。
- 用户数据隔离和认证授权。
- 任务可靠恢复和工作流调度。
- 小红书或淘宝的事实校验。

### 6.2 Trace 层级

一次用户消息对应一个根 trace，一次连续会话对应 Langfuse session。建议层级如下：

```text
looktrace.chat.turn
└── openai.agent.run
    ├── model.call
    ├── tool.search_xhs
    ├── model.call
    ├── tool.get_user_kit
    ├── model.call
    ├── tool.search_taobao
    └── final.answer
```

后续引入受控工作流时，工作流步骤位于 `openai.agent.run` 之上；现有 trace 结构应保持兼容。

### 6.3 最低追踪字段

每次运行至少能关联：

- `trace_id`
- `agent_run_id`
- `conversation_id`
- `message_id`
- 用户的匿名或受控标识
- Agent、prompt、模型和代码版本
- 模型调用次数、token、成本和延迟
- 工具名称、调用顺序、状态、重试次数和延迟
- 来源数量、证据数量、候选 SKU 数量
- 是否读取妆匣、命中多少产品、缺少多少能力
- 是否使用 fallback 或 placeholder

### 6.4 可观测性必须回答的问题

- 本轮调用了哪些模型和工具，顺序是什么？
- 妆容推荐是否真的搜索了小红书？
- 用户询问已有产品时是否读取了妆匣？
- 哪个步骤失败、重试或降级？
- 每个步骤耗时多少？本轮 token 和成本是多少？
- 最终推荐引用了哪些来源和证据？
- 使用的 Agent、prompt 和模型版本是什么？
- 这次回答是否通过对应 eval 或质量评分？

### 6.5 隐私边界

Langfuse 中不得保存：

- 小红书账号 Cookie、token 或账号池完整配置。
- 淘宝 API key、secret 或认证响应。
- 模型 API key。
- 未经脱敏的高敏感用户信息。

默认只写入脱敏输入、摘要、数量、状态、内部对象 ID 和错误码。系统不得记录模型隐藏 chain-of-thought；可以记录模型输入输出、工具调用参数、工具结果摘要和最终决策标签。

## 7. 阶段划分与出口

阶段是评审和发布的边界，不是要求代码必须按某个目录或某个类实现。每一阶段只有满足出口条件，才进入下一阶段。

### 阶段 0：方案确认与外部依赖确认

本阶段确认：

- OpenAI Agents SDK 作为 Agent runtime，而不是完整产品底座。
- MVP 使用自主 ReAct，不预先实现固定完整工作流。
- 工具、权限、来源真实性、淘宝占位和医疗边界属于硬约束。
- Langfuse 作为默认 LLM/Agent 可观测性方案。
- 小红书账号池和淘宝 API 的授权、调用方式和失败边界可被明确描述。
- MVP 的用户身份模式、数据保留和敏感数据策略已确定。

阶段出口：

- 人工 review 通过本规范的决策项。
- OpenAI Agents SDK 的具体包、版本、运行方式和许可风险已确认。
- 采用 Python `openai-agents` 服务端 SDK；具体版本、Python 要求和 API 以 runtime spike 为准。
- 已确认生产请求直接使用 SDK runner，不在 API 请求中启动 CLI 子进程。
- 小红书、淘宝、OpenAI、Langfuse 的外部依赖状态有明确负责人和可行降级方案。
- 没有会阻塞 MVP 主链路的未解决权限或凭据问题。

本阶段不做：

- 不实现全部领域工具。
- 不做长期记忆、多渠道或图片能力。
- 不因为框架自带能力而扩大 MVP 范围。

### 阶段 1：Agent runtime 最小闭环

详细执行规范：[09-05-phase-1-agent-runtime.md](./09-05-phase-1-agent-runtime.md)

本阶段验证 OpenAI Agents SDK 能在服务端运行一个最小自主 Agent：模型可以选择 mock 工具，读取工具结果，继续调用或结束，并把过程流式传递给客户端。

阶段出口：

- 一次请求可以完整经历模型调用、工具调用、工具结果和最终回答。
- Agent 可以自主决定调用工具，而不是依赖硬编码的完整业务顺序。
- 有最大循环次数、超时、失败和最终状态。
- 前端可以收到文本增量和用户可理解的状态。
- Langfuse 可以还原这次最小运行的 trace。

本阶段不做：

- 不接入真实小红书或淘宝数据。
- 不判断推荐质量。
- 不实现长期会话记忆。

### 阶段 2：资料证据闭环

本阶段接入小红书资料能力，让 Agent 能按本轮诉求搜索或读取可访问内容，并形成来源和证据对象。

阶段出口：

- 妆容相关请求可以触发小红书资料工具。
- 资料结果包含来源、摘要、SKU 提及、品类规律、冲突和不确定性。
- 来源和证据可以关联到本轮会话、消息和 Langfuse trace。
- 小红书不可读、无权限或搜索失败时，用户得到明确降级提示。
- Agent 不会把未读取的资料描述成已验证事实。

本阶段不做：

- 不承诺读取未授权内容。
- 不把单个笔记的商品清单直接当作推荐答案。
- 不实现图片解析。

### 阶段 3：妆容拆解与无妆匣推荐

本阶段验证 Agent 能把用户目标和资料证据转成妆容特点、产品能力和 SKU 候选，并在没有妆匣的情况下完成回答。

阶段出口：

- 输出包含总体妆感、底妆、眼眉、腮红/修容、唇妆、颜色、质地、重心和不确定性。
- 妆容特点先映射到品类能力，再映射到 SKU 候选。
- SKU 候选包含品牌、商品名、规格/色号、推荐理由、优先级和证据摘要。
- 淘宝信息可用时能补全价格、渠道和购买链接；不可用时明确标记 placeholder 或 degraded。
- 无妆匣用户不会被卡在录入流程。

本阶段不做：

- 不做电商下单、比价、返利或库存追踪。
- 不把实时商品信息和人工种子数据混为一谈。

### 阶段 4：妆匣匹配闭环

本阶段让 Agent 在用户询问已有产品、替代方案或“不用买什么”时读取当前用户妆匣，并给出已有产品和缺口判断。

阶段出口：

- Agent 能区分可直接使用、部分匹配、不适合和缺失能力。
- 回答明确说明看过用户妆匣，并指出具体产品和缺口理由。
- 没有合适产品时，仍能给出新增 SKU 候选。
- 用户妆匣新增、编辑、删除后的结果能影响后续匹配。
- 不同用户之间无法读取彼此的妆匣、来源或会话。

本阶段不做：

- 不做图片识别录入。
- 不做粘贴清单自动结构化。
- 不做根据反馈自动学习用户偏好。

### 阶段 5：MVP 质量、可观测性与发布验收

本阶段把前面能力合并为可评测的 MVP，并验证工具失败、来源不确定性、安全边界和运行成本。

阶段出口：

- `001-mvp.md` 中的 10 个初始 eval case 可运行。
- `EVAL-001`、`EVAL-003`、`EVAL-004`、`EVAL-005` 达到发布门槛。
- 每次模型调用、工具调用、失败、降级和最终回答都能在 Langfuse 中追踪。
- 业务记录可以从回答回溯到来源、证据、SKU、妆匣和 trace。
- 小红书和淘宝失败不会导致界面崩溃或虚构结果。
- 完成用户隔离、凭据保护、敏感字段脱敏和移动端人工 QA。
- 延迟、token、成本、工具成功率和循环次数已获得基线数据。

本阶段不做：

- 不因为可观测性需要而引入完整分布式 workflow engine。
- 不把 Langfuse score 当成唯一的产品质量判断。

### 阶段 6：受控工作流演进

本阶段是 MVP 之后的候选方向，只有当自主 Agent 在质量、成本、延迟或合规上达到问题阈值时才启动。

本阶段可以在 Agent Runtime 外层增加：

- 阶段级工具白名单。
- 阶段输入输出 schema 校验。
- 必须满足的前置条件。
- 重试、降级和人工确认。
- 工作流步骤级 trace 和 eval。

阶段出口：

- 受控模式与自主模式可以按任务或配置切换。
- 受控模式没有破坏现有工具契约、业务数据和 Langfuse trace。
- 质量、成本或合规指标相对自主模式有可证明改善。

如果未来需要长时间运行、断点恢复、定时任务、人工审批或跨服务可靠执行，再评估引入专门的 workflow engine。该系统位于 Agent Runtime 之上，而不是替代 Agent Runtime。

## 8. 主要风险

### R1：OpenAI Agents SDK 能力或版本不满足嵌入要求

OpenAI Agents SDK 的具体包、运行 API、事件模型、服务端运行方式或许可可能与预期不一致。若流式事件、工具 schema 或运行中止能力不足，集成成本会明显上升。

缓解方向：阶段 0 先做最小 runtime spike，锁定具体版本、事件映射和可替代边界，不在 spec 中假定未验证的 API。

### R2：自主 Agent 漏调关键工具

Agent 可能不搜索小红书、不读取妆匣，或者在证据不足时直接推荐。这会直接违反 MVP 的关键验收要求。

缓解方向：用工具描述、系统规则、结果校验、最大循环限制和 eval 同时约束；阶段 5 统计“应调未调”的比例。若质量不足，再引入阶段级 controller。

### R3：小红书账号池不可用或授权边界不清

账号失效、限流、内容不可读、账号池接口未交付或使用权限不清，会使核心资料链路不稳定。

缓解方向：服务端隔离账号凭据，使用可访问内容，保存来源状态，提供关键词和粘贴正文降级，并把账号池依赖作为阶段 0 的发布阻塞项。

### R4：淘宝数据不等于可靠 SKU 信息

搜索结果可能缺少精确色号、价格、渠道或购买链接，API 失败时还可能返回旧数据或占位链接。

缓解方向：区分 live、placeholder 和 degraded；记录查询时间和来源；没有真实结果时禁止使用“实时价格”等表述。

### R5：来源内容包含广告、种草或提示注入

小红书原文可能带有广告偏向，也可能包含诱导 Agent 泄露 prompt、调用不相关工具或绕过规则的内容。

缓解方向：把外部内容视为不可信资料；抽取时保留语境和不确定性；不执行来源文本中的指令；来源内容不能改变工具权限和系统规则。

### R6：用户数据隔离和敏感数据泄露

妆匣、会话、小红书来源和用户皮肤描述都可能属于敏感信息。Langfuse、日志和错误上报又会扩大数据复制面。

缓解方向：服务端身份作为唯一授权依据；Langfuse 默认只记录脱敏摘要；凭据绝不进模型、客户端或 trace；正式发布前完成跨用户访问测试和删除测试。

### R7：Agent 循环造成成本和延迟失控

自主 Agent 可能重复调用工具、反复修正或产生过长上下文，导致一次请求成本和等待时间不可预测。

缓解方向：设置最大循环次数、工具超时、重试上限、重复调用检测和 token/cost 观测；阶段 5 建立 p50/p95 和单轮成本基线。

### R8：Langfuse 记录不完整或形成供应商依赖

短生命周期服务可能在 trace flush 前结束；SDK 升级、网络故障或 Langfuse 不可用也可能造成观测缺失。

缓解方向：业务 `tool_runs` 作为最低审计兜底；请求结束前确认 flush；Langfuse 不可用时不阻塞用户主链路；保留 OpenTelemetry 或等价 exporter 的替换可能性。

### R9：实时资料导致 eval 不稳定

小红书和淘宝结果会随时间、账号状态和商品库存变化，导致同一个 eval 输入每次得到不同结果。

缓解方向：将工具行为、结构化字段、来源存在性和边界遵守作为主要 eval；对外部结果保存可重放的摘要或 fixture；不要只用商品名称精确匹配作为评分标准。

### R10：MVP 范围扩张

Agent SDK、Hermes 或 OpenClaw 可能自带超出 MVP 的能力，容易把实现目标从验证核心推荐价值扩展成通用个人助手。

缓解方向：以 `001-mvp.md` 为唯一产品范围依据；任何新增能力必须说明对核心验证的直接价值，并单独进入后续迭代。

## 9. 人工 Review 重点

以下事项必须由产品、工程和相关业务负责人确认，不能仅通过技术实现自行决定。

### 9.1 产品与 Agent 自主性

- 是否接受 MVP 让 Agent 自己拆解任务和决定工具顺序？
- 哪些行为属于绝对硬约束，哪些只是推荐策略？
- 如果 Agent 漏调小红书或妆匣，应该阻止最终回答，还是允许降级回答？
- 第一版是否允许 Agent 调用一个合并的大工具，还是必须看到细粒度步骤？
- 用户是否需要看到详细的工具状态，还是只看到简化后的进度？

### 9.2 OpenAI Agents SDK 选型

- 实际采用哪个 OpenAI Agents SDK 包、版本和模型？当前决策为 Python 包 `openai-agents`，版本和模型由 `agent_service/requirements.txt` 与环境变量锁定。
- 该版本是否允许作为 Next.js 服务端库嵌入，并支持 streaming、自定义工具、guardrails、usage 和取消运行？待 runtime spike 确认。
- SDK 的 tracing 是否能提供所需的模型/工具事件；与 Langfuse 的适配边界是什么？待确认。
- 如果 SDK 不满足服务端事件或运行保护要求，是否接受保留一个自建最小 runner？

### 9.3 小红书和淘宝外部依赖

- 平台侧账号池是否有明确授权和稳定调用方式？
- 哪些内容可以读取、保存和展示给用户？
- 小红书搜索失败时，粘贴正文是否是正式兜底还是仅开发调试能力？
- 淘宝 API 是否能提供真正的 SKU、价格、渠道和购买链接？
- 淘宝 API 不可用时，产品是否接受只给候选和搜索占位链接？

### 9.4 可观测性和隐私

- Langfuse 使用 Cloud 还是 self-host？数据驻留和保留时间是什么？
- 哪些用户输入、来源原文和妆匣字段允许进入 Langfuse？
- 是否接受 Langfuse 不可用时只保留本地业务审计记录？
- token、成本、延迟和质量分数由谁查看，保留多久？

### 9.5 发布门槛

- 是否接受阶段 0 的外部依赖确认作为 MVP 开始的前置条件？
- 10 个 eval case 的评分标准是否足以代表首版质量？
- 哪些错误必须阻止发布，哪些错误可以降级后发布？
- 真实认证是在 MVP 主链路中完成，还是先接受受限的单用户模式？
- 什么情况下从自主 ReAct 切换到 Agent Runtime 外层受控 workflow？

## 10. 评审结论记录

评审完成后应在此记录：

- 决策结果：修改后通过，待完成 runtime spike 和外部依赖确认。
- 采用的 SDK 和版本：Python `openai-agents`；版本、模型和 API 以 runtime spike 为准。
- Langfuse 部署和数据策略：待确认。
- 小红书账号池授权和降级策略：待确认。
- 淘宝 API 能力和占位策略：待确认。
- MVP 是否采用真实认证：待确认。
- 需要在阶段 0 解决的阻塞问题：待填写。
