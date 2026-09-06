# 阶段 1：Agent Runtime 最小闭环 Spec

Status: Draft
Date: 2026-09-05
Related spec: [09-04-agent-runtime-and-observability.md](./09-04-agent-runtime-and-observability.md)

## 0. 目标

本阶段验证 OpenAI Agents SDK 能在妆迹服务端完成一次最小自主 Agent run：模型读取用户请求，自主决定是否调用 mock tool，读取工具结果后继续运行或结束，并将过程以用户可理解的事件流传递给前端。

本阶段的产物是可替换的 runtime 骨架，不接入真实小红书、淘宝或妆匣业务。

## 1. 范围

### 1.1 必须实现

- 使用 OpenAI Agents SDK 的 Python 服务端 runner；Next.js 只负责 API/SSE 代理。
- 支持一个 Agent 和至少一个 mock tool。
- Agent 可以自主选择调用 mock tool，也可以直接回答。
- 支持模型调用、工具调用、工具结果回传和最终回答。
- 支持文本增量和工具状态的 SSE 事件。
- 支持最大循环次数、单次运行超时和主动取消。
- 支持工具异常、模型异常和超限后的明确终态。
- 为每次 run 创建 `traceId`、`agentRunId`、`conversationId` 和 `messageId`。
- OpenAI Agents SDK tracing 能还原 Agent、模型和工具调用关系。
- Langfuse 适配层可以接收同一运行的摘要事件；Langfuse 不可用时不阻塞主链路。

### 1.2 不实现

- 不接入真实小红书、淘宝、数据库或用户妆匣。
- 不实现完整妆容推荐和固定业务 workflow。
- 不实现长期记忆、session 持久化、后台任务或人工审批。
- 不记录或展示模型隐藏 chain-of-thought。
- 不向浏览器暴露 OpenAI API key、trace 凭据或 SDK 内部对象。

## 2. 运行架构

```text
Web Client
    |
    | POST /api/agent-runtime/spike
    v
Application Route
    |
    +--> OpenAI Agent Runner
    |       |
    |       +--> Python OpenAI Agents SDK Agent
    |       +--> mock_lookup tool
    |       +--> run limits / abort signal
    |       +--> SDK tracing
    |
    +--> Langfuse adapter (best effort)
    +--> local runtime audit
```

推荐代码边界：

```text
app/api/agent-runtime/spike/route.ts          # Next.js SSE proxy
agent_service/runtime.py                     # Python Agent runner
agent_service/main.py                        # FastAPI endpoint
agent_service/observability.py               # OTel/Langfuse setup
agent_service/audit.py                       # local audit fallback
```

`route.ts` 只负责请求校验、创建运行上下文、转发事件和关闭响应。Agent 配置、工具和运行保护放在 runner 层；业务身份和权限由应用层提供，不能由模型通过工具参数覆盖。

## 3. Runtime Context

每次请求必须创建以下不可变上下文：

```ts
type AgentRuntimeContext = {
  userId: string;
  conversationId: string;
  messageId: string;
  traceId: string;
  agentRunId: string;
  startedAt: string;
  maxTurns: number;
  timeoutMs: number;
};
```

约束：

- `userId` 只能来自服务端请求上下文；阶段 1 可以使用固定的 `local-user` 测试身份。
- `traceId` 和 `agentRunId` 由应用层生成并贯穿 SDK、Langfuse 和本地审计。
- `maxTurns`、`timeoutMs` 只能由服务端配置决定。
- mock tool 不接受 `userId`、API key、Cookie 或数据库连接等参数。

默认运行预算：

| 项目 | 默认值 | 说明 |
| --- | ---: | --- |
| 最大 turn | 6 | 超过后进入 `limit_exceeded` |
| 单次运行超时 | 30 秒 | 使用 abort signal 终止运行 |
| mock tool 重试 | 0 次 | 阶段 1 先验证失败路径，不引入重试复杂度 |
| 单次相同 tool 输入 | 1 次 | 重复调用进入 `duplicate_call` 保护 |

默认值可以通过服务端配置调整，但必须在 trace 和测试输出中记录实际值。

## 4. Mock Tool

### 4.1 `mock_lookup`

该工具模拟“读取外部资料”的只读工具，用于验证自主 tool calling，不代表真实小红书能力。

输入：

```ts
type MockLookupInput = {
  query: string;
};
```

成功结果：

```ts
type MockLookupResult = {
  status: "succeeded";
  query: string;
  findings: Array<{
    title: string;
    summary: string;
    confidence: "mock";
  }>;
};
```

失败结果：

```ts
type MockLookupFailure = {
  status: "failed" | "degraded";
  code: "MOCK_TOOL_ERROR" | "MOCK_EMPTY_RESULT";
  message: string;
};
```

工具必须返回结构化结果。工具异常不能把内部堆栈直接传给模型、客户端或 Langfuse；runner 需要将异常转换成上述失败状态，并决定 Agent 是否可以继续回答。

## 5. Agent 行为

系统规则至少要求 Agent：

1. 先理解用户请求，再决定直接回答或调用 `mock_lookup`。
2. 调用工具后必须读取工具结果，不得虚构工具未返回的内容。
3. 工具失败时明确说明资料不可用，并允许在安全范围内降级回答。
4. 达到运行预算时停止继续调用工具，并返回可解释的降级终态。
5. 最终回答只包含普通文本或结构化业务摘要，不包含原始工具 JSON、系统规则或隐藏推理。

阶段 1 不要求每次请求都调用工具，但必须提供至少两类测试：模型自主调用工具，以及模型判断无需工具直接回答。

## 6. 事件与 SSE 契约

### 6.1 内部 Runtime Event

```ts
type RuntimeEvent =
  | { type: "run_started"; context: AgentRuntimeContext }
  | { type: "model_started" }
  | { type: "text_delta"; text: string }
  | { type: "tool_started"; toolName: string; callId: string; inputSummary: string }
  | { type: "tool_finished"; toolName: string; callId: string; status: string; outputSummary: string }
  | { type: "model_finished"; usage?: { inputTokens?: number; outputTokens?: number } }
  | { type: "run_finished"; status: "succeeded" | "degraded" | "clarification" | "failed" | "limit_exceeded" }
  | { type: "run_failed"; code: string; message: string };
```

SDK 的具体事件名称由 runtime spike 适配为以上稳定的应用层事件，前端不得依赖 SDK 原始事件名。

### 6.2 SSE 事件

接口：`POST /api/agent-runtime/spike`

请求：

```json
{
  "message": "帮我查一下适合通勤的妆容参考",
  "conversationId": "optional-conversation-id"
}
```

事件映射：

| SSE event | 数据 | 前端行为 |
| --- | --- | --- |
| `status` | `{ "phase": "model" | "tool", "message": string }` | 显示简短处理状态 |
| `chunk` | `{ "text": string }` | 追加回答文本 |
| `tool` | 工具名称、状态和摘要 | 显示工具处理结果，不显示原始 JSON |
| `result` | 最终回答、状态、run 标识和摘要 | 完成当前消息 |
| `error` | 错误码和用户可理解的消息 | 结束并显示降级错误 |

响应必须设置：

```text
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
```

## 7. 运行保护与终态

runner 必须在以下情况下停止：

- Agent 产生最终回答。
- 达到 `maxTurns`。
- 超过 `timeoutMs`。
- 请求被客户端取消。
- 模型调用失败且无法继续。
- 工具调用触发重复输入保护。

每次运行只能产生一个最终终态：

| 状态 | 使用场景 |
| --- | --- |
| `succeeded` | 完成模型调用、工具流程和最终回答 |
| `clarification` | Agent 需要用户补充关键信息 |
| `degraded` | 工具失败或资料为空，但仍生成了有限回答 |
| `limit_exceeded` | 达到 turn、重复调用或成本预算 |
| `failed` | 无法生成可交付回答 |

异常关闭时，服务端必须尽力发送 `error` 事件并关闭 stream；不得把内部异常堆栈写入响应。

## 8. 可观测性

### 8.1 OpenAI Agents SDK tracing

启用 SDK 原生 tracing，至少确认以下信息可被关联：

- Agent run 标识。
- 模型调用次数和顺序。
- 工具调用名称、参数摘要、结果状态和耗时。
- 运行终态、错误和中止原因。
- 模型 usage（如果 SDK 事件提供）。

不得记录 API key、Cookie、原始账号池配置、未脱敏敏感信息或隐藏 chain-of-thought。

### 8.2 Langfuse

阶段 1 只要求建立适配边界，不要求依赖 Langfuse 才能完成请求：

```text
looktrace.chat.turn
└── openai.agent.run
    ├── model.call
    ├── tool.mock_lookup
    └── final.answer
```

Langfuse 记录失败时：

- 用户主链路继续完成。
- 本地 runtime audit 保留 run 状态、工具名称、耗时、错误码和关联 ID。
- 不因 trace flush 失败而把请求判定为失败。

## 9. 验收标准

### 9.1 功能验收

- [ ] 一次请求可以完成 model -> tool call -> tool result -> final answer。
- [ ] Agent 可以根据请求自主选择调用或不调用 `mock_lookup`。
- [ ] 工具结果会进入后续模型上下文，并影响最终回答。
- [ ] 前端能收到文本增量、工具状态和最终结果。
- [ ] 工具失败、模型失败、超时、取消和超限都有明确终态。
- [ ] 相同 tool 输入不会无限重复调用。
- [ ] API 响应不包含 API key、内部堆栈、原始工具 JSON 或隐藏推理。

### 9.2 Trace 验收

- [ ] 一个 run 可以通过 `traceId`、`agentRunId`、`conversationId`、`messageId` 关联。
- [ ] OpenAI tracing 能看到 Agent、model 和 tool 层级。
- [ ] Langfuse 可用时能接收对应摘要或等价 trace。
- [ ] Langfuse 不可用时，用户请求和本地审计仍然成功。
- [ ] 至少记录实际 turn 数、工具调用数、耗时、终态和错误码。

### 9.3 最小测试集

| Case | 输入特征 | 期望 |
| --- | --- | --- |
| `RUNTIME-001` | 明确要求查询资料 | Agent 调用 mock tool 并引用其结果 |
| `RUNTIME-002` | 不需要外部资料的简单问题 | Agent 可直接回答，不强制调用 tool |
| `RUNTIME-003` | mock tool 返回失败 | 返回 `degraded` 或 `failed`，不虚构结果 |
| `RUNTIME-004` | mock tool 重复调用 | 触发重复调用保护并结束 |
| `RUNTIME-005` | 运行超过最大 turn | 返回 `limit_exceeded` |
| `RUNTIME-006` | 模型或网络超时 | 发送 `error`，正确关闭 SSE |

## 10. 阶段出口

阶段 1 完成的必要条件：

- `RUNTIME-001` 至 `RUNTIME-006` 可重复运行。
- 至少一次真实 OpenAI 模型调用完成完整闭环；若无 API 凭据，必须使用明确标记的 stub 结果，不能宣称阶段完成。
- 服务端和前端的 SSE 契约稳定，SDK 原始事件已隔离在 adapter 内。
- 运行保护和终态在自动测试中覆盖。
- OpenAI tracing 的实际配置、隐私选项和查看方式已记录。
- Langfuse 失败不会阻塞主链路，本地审计可以还原最小运行。
- 阶段 1 不引入真实领域工具，也不改变 `001-mvp.md` 的产品范围。

## 11. 后续进入阶段 2 的条件

只有满足阶段出口后，才接入真实小红书资料工具。阶段 2 必须复用本阶段的：

- `AgentRuntimeContext`。
- 应用层 Runtime Event 和 SSE 契约。
- 运行预算、取消和终态机制。
- OpenAI tracing 与 Langfuse 适配边界。
- 本地审计和敏感信息保护规则。

## 12. 当前开发的 Commit 计划

当前只实现 L1 的 TDD 闭环。L2 prompt 测试和 L3 端到端测试暂不编写，只保留目录占位；它们后续单独进入新的开发批次，不作为当前阶段的提交内容。

每个 commit 只包含一个可解释的变化，并在提交前运行对应验证。commit message 使用英文 Conventional Commits 格式，便于 review、cherry-pick 和回滚。

### Commit 1：文档和测试目录占位

建议 message：`docs: define phase 1 tdd test strategy`

包含：

- 本 spec 的阶段 1 契约和当前开发范围。
- TDD 分级计划。
- `test/L1/`、`test/L2/`、`test/L3/` 空目录占位。

不包含：

- 测试用例。
- 测试 runner。
- OpenAI SDK 依赖。
- 生产代码。

验证：`git diff --check`，并确认三个测试目录都存在。

### Commit 2：L1 RED

建议 message：`test: add L1 domain node contracts`

包含：

- `test/L1/` 下针对现有纯代码节点的失败测试。
- search plan、妆容拆解、SKU、妆匣匹配和淘宝 placeholder 的行为断言。
- 固定 fixture，不调用模型、网络或真实外部平台。

验证：逐个运行 L1 测试，确认失败来自尚未满足的行为，而不是 import、fixture 或测试配置错误。必须保留这次 RED 结果后才能进入 Commit 3。

### Commit 3：L1 GREEN

建议 message：`feat: satisfy L1 domain node contracts`

包含：

- 只修改使 L1 测试通过所需的 `lib/` 代码。
- 必要的纯函数抽取和确定性修复。
- 不引入 OpenAI SDK、网络调用或 Agent loop。

验证：

- L1 全部通过。
- `npm run typecheck` 通过。
- `npm run build` 通过。

### Commit 4：L1 收尾（可选）

建议 message：`refactor: stabilize L1 test fixtures`

只有在 L1 GREEN 后确实存在测试重复、fixture 混乱或命名问题时才创建此 commit。若没有独立的重构价值，直接保留 3 个 commit，不强行增加提交。

验证：L1、typecheck 和 build 继续全绿。

### 后续批次：L2 和 L3

L2/L3 不属于当前 commit 计划：

- L2 后续按“单节点 prompt RED -> prompt 实现 GREEN”拆分。
- L3 后续按“runtime/SSE RED -> runner/保护实现 GREEN -> tracing/audit”拆分。
- L2/L3 开始前必须保留当前 L1 全绿状态，并单独定义各自的失败测试。

当前依赖关系：

```text
Commit 1 文档/目录占位
    -> Commit 2 L1 RED
        -> Commit 3 L1 GREEN
            -> Commit 4 L1 收尾（可选）

后续：L2 RED/GREEN -> L3 RED/GREEN -> tracing/audit
```

禁止把 Commit 2 的失败测试和 Commit 3 的实现合并；必须先观察到 L1 正确失败，再写最小实现使其转绿。
