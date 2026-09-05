# 妆迹 MVP Agent 与可观测性实施计划

Status: Draft
Date: 2026-09-04
Related spec: [001-mvp.md](../specs/001-mvp.md)、[09-04-agent-runtime-and-observability.md](../specs/09-04-agent-runtime-and-observability.md)

## 0. 实施目标

在不预先编码完整固定工作流的前提下，搭建一个基于 OpenAI Agents SDK 的自主 ReAct Agent：Agent 可以自行判断工具调用顺序，完成小红书资料检索、妆容拆解、SKU 推荐、淘宝信息补全和妆匣匹配。

同时接入 Langfuse，确保每次模型调用、工具调用和最终回答都能追踪，并能和妆迹业务数据关联。

本文件是实施计划，不修改 `docs/specs/001-mvp.md` 的产品范围和验收口径。

## 1. 实施前确认

- [ ] 锁定 `@openai/agents` 的版本、模型和运行 API。
- [ ] 确认 OpenAI Agents SDK 是否支持服务端 TypeScript/Node 运行、流式事件、自定义工具、guardrails、usage 和取消运行。
- [ ] 确认 Codex 的调用方式、模型名、结构化输出能力和 token usage 字段。
- [ ] 创建 Langfuse project，确定 Cloud 或 self-host 方案。
- [ ] 确认 Langfuse 环境变量、数据保留策略和脱敏策略。
- [ ] 确认小红书账号池接口、淘宝 API 认证方式和测试凭据交付时间。
- [ ] 确认 MVP 是否继续使用本地单用户模式，还是先接入真实认证。

## 2. OpenAI Agent 骨架

### 2.1 建立运行上下文

定义一次 Agent run 的服务端上下文：

- `userId`
- `conversationId`
- `messageId`
- 当前用户消息
- 会话历史摘要
- 当前回合工具结果
- 当前用户妆匣摘要
- `traceId` 和 `agentRunId`
- Agent、prompt、模型和代码版本

只把当前任务需要的字段送入模型上下文，避免把所有原始业务记录直接拼进 prompt。

### 2.2 接入 OpenAI Agent 模型循环

实现服务端 OpenAI Agent runner：

- 接收上下文和工具列表。
- 消费 SDK 的模型/工具/文本事件。
- 把工具调用路由到妆迹工具实现。
- 把文本增量转成前端 SSE 事件。
- 在最大循环次数后结束运行并返回降级状态。
- 处理模型调用失败、工具调用失败和结构化输出失败。

第一版不加入外层固定 workflow controller，先让 Agent 自己决定调用顺序。

### 2.3 工具最小集合

优先实现 5 个高层工具，避免 MVP 初期工具数量过多：

1. `search_xhs_evidence`
2. `analyze_look`
3. `get_user_kit_and_match`
4. `recommend_skus_and_search_taobao`
5. `compose_or_validate_answer`

如果 SDK 的 tool calling 更适合细粒度工具，再拆分为：

```text
search_xhs
read_xhs_note
get_user_products
match_owned_products
recommend_sku_candidates
hydrate_taobao_offers
```

拆分标准是模型是否能稳定选择工具，而不是追求工具数量。

## 3. 领域工具实现

### 3.1 小红书资料工具

- 对接账号池搜索/读取接口。
- 支持按本轮用户诉求生成搜索词。
- 保存来源摘要和可追溯引用。
- 将来源内容整理为妆容特点、SKU 提及、品类规律、冲突和不确定性。
- 账号池不可用时返回降级结果，提示换关键词或粘贴正文。
- 不向 Agent 或客户端返回 Cookie、token 和账号池内部配置。

### 3.2 妆容拆解工具

- 接收用户目标和小红书证据摘要。
- 输出 `LookFeatureSet` 或等价结构。
- 输出产品能力，而不只输出审美形容词。
- 标记来源不足、广告语境、肤色差异和文字无法判断的内容。
- 结构化解析失败时返回可解释的低置信度结果。

### 3.3 SKU 和淘宝工具

- 先根据产品能力产生候选 SKU。
- 根据候选 SKU 和目标妆效生成淘宝检索词。
- 接入真实淘宝 API 后补全价格、渠道和购买链接。
- API 未配置或查询失败时明确标记 placeholder/degraded。
- 禁止把搜索占位链接或旧数据描述成实时商品结果。

### 3.4 妆匣工具

- 只读取当前用户的产品。
- 用户提到已有产品、替代或“不用买”时必须触发。
- 区分可直接使用、部分匹配、不适合和缺失能力。
- 用户没有产品时返回空结果并允许 Agent 继续推荐。
- CRUD 操作和 Agent 读取都使用同一用户隔离策略。

## 4. Langfuse 接入

### 4.1 Trace 生命周期

- 请求进入时创建 `looktrace.chat.turn` trace。
- 一个 Agent run 创建 `openai.agent.run` span。
- 每次模型调用创建 generation。
- 每次工具调用创建 tool span/observation。
- 最终回答创建 final observation，并结束 agent span 和 trace。
- 任何未捕获异常都记录 error status 和错误码。
- Serverless/短生命周期环境在响应结束前完成 flush。

### 4.2 事件映射

| OpenAI Agents SDK 事件 | Langfuse 记录 | 前端行为 |
|---|---|---|
| 模型开始 | generation start | 可选显示思考阶段状态 |
| 工具调用 | tool span start | 显示对应的用户可理解状态 |
| 工具结果 | tool span end | 更新来源/候选数量 |
| 文本增量 | generation/output update | SSE 增量渲染 |
| 运行结束 | final observation | 保存最终答案 |
| 运行异常 | error status | 显示降级错误提示 |

不要为每个文本 token 创建独立 span。文本增量只作为 generation 输出更新或前端 SSE 事件。

### 4.3 记录字段

每次 trace 至少记录：

- 用户和会话的受控标识。
- Agent、prompt、模型和代码版本。
- 模型调用次数、token、成本和延迟。
- 工具名称、调用顺序、状态、重试次数和延迟。
- 来源数量、证据数量、候选 SKU 数量。
- 是否读取妆匣、命中多少产品、缺少多少能力。
- 是否使用了 fallback 或 placeholder。

Langfuse 中只保存脱敏输入和摘要；业务原文通过业务存储中的对象 ID 关联。

## 5. 业务存储与关联

在现有数据模型基础上补充或确认以下关联字段：

- `messages.trace_id`
- `tool_runs.trace_id`
- `tool_runs.agent_run_id`
- `source_items.trace_id` 或通过 conversation/message 关联
- `product_candidates.trace_id` 或通过 conversation/message 关联
- `eval_runs.trace_id`

一次 Agent run 的所有业务记录必须能回溯到对应用户、会话和消息。查询业务数据时始终以服务端认证得到的 user identity 做过滤，不能信任客户端传入的任意 user ID。

## 6. Eval 和运行验证

### 6.1 工具行为检查

为至少以下行为建立自动检查：

- 妆容推荐是否调用小红书资料工具。
- 用户询问已有产品时是否读取妆匣。
- 无妆匣时是否仍然返回 SKU 候选。
- 淘宝不可用时是否正确标记占位。
- 来源不足时是否暴露不确定性。
- 皮肤问题请求是否触发安全边界。
- Agent 是否超过最大循环次数。

### 6.2 Langfuse score

将既有 10 个 eval case 的结果和 Langfuse trace 关联，并记录：

- 是否调用了必需工具。
- 是否产生来源和证据。
- 是否完成产品能力到 SKU 的映射。
- 是否完成妆匣优先匹配。
- 是否正确处理工具失败。
- 人工或自动整体评分。

业务数据库保留正式 `eval_runs`，Langfuse 用于查看运行细节和比较不同模型/prompt 版本。

## 7. 实施阶段

### Phase 1：运行时验证

- 安装并验证 OpenAI Agents SDK 的最小 server-side runner。
- 用一个 mock tool 跑通模型调用、tool call、tool result 和 final answer。
- 验证 SSE 事件和异常关闭行为。

### Phase 2：领域工具接入

- 接入小红书证据工具。
- 接入妆容拆解和 SKU 推荐工具。
- 接入妆匣读取和匹配工具。
- 接入淘宝查询和 placeholder/degraded 分支。

### Phase 3：Langfuse 与业务审计

- 建立 trace/span/generation 映射。
- 补齐 trace 与业务记录的关联字段。
- 加入 token、成本、延迟、重试和失败状态。
- 完成敏感字段脱敏和 flush 验证。

### Phase 4：质量验证

- 跑通 10 个 eval case。
- 检查自主 Agent 是否漏调关键工具。
- 调整工具描述、系统规则、最大循环次数和结果校验。
- 检查小红书和淘宝失败时前端是否稳定降级。

### Phase 5：受控化准备

MVP 验证完成后再评估：

- 工具白名单。
- 结构化输出 schema 校验。
- 阶段级 controller。
- 预算和成本限制。
- 重试与断点恢复。
- Langfuse 中的 workflow step 层级。

## 8. 完成标准

实施完成时应满足：

- OpenAI Agent 能自主选择并调用领域工具。
- 前端能看到流式文本和用户可理解的状态。
- 一轮 Agent run 能在 Langfuse 中还原完整调用链。
- 业务记录能关联来源、证据、SKU、妆匣和 trace。
- 工具失败、淘宝占位和小红书不可读都有可解释降级。
- 不会跨用户读取妆匣、会话或来源。
- 10 个 eval case 可运行，并能关联到对应 trace。
- 不需要引入 Hermes 或 OpenClaw 才能完成 MVP 主链路。
