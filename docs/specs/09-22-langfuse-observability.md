# 全链路 Trace：阶段输入输出与耗时（Langfuse）

Status: Implemented（2026-09-22）—— 验证记录见第 12 节
Date: 2026-09-22
Related specs: [001-mvp.md](./001-mvp.md) · [09-17-pi-skill-runtime.md](./09-17-pi-skill-runtime.md) · [09-21-taobao-product-cards.md](./09-21-taobao-product-cards.md)

## 0. 文档目的

一轮回答要跑 15 分钟，但**没有任何一处耗时落盘**。「哪里慢」目前只能靠事后凑痕迹做残差推断（第 3 节就是一次这样的推断），误差几十秒，也回答不了「第 12 次工具调用为什么比第 11 次慢」。

本文规定一轮请求的**全部阶段**——Agent 运行、每个 turn、每次模型调用、每次工具调用、淘宝卡片补全——都上报到 Langfuse，每个阶段带**具体的 input/output** 和**耗时**。落地后「哪里慢」是查出来的，不是推出来的。

本文只定义可观测性，不改 Agent 行为、不改答案形态、不改 SSE 契约（新增字段除外）。

## 1. 需求

1. 每轮请求一棵 trace，能一眼看出各阶段耗时占比。
2. 阶段粒度到**单次**模型调用与**单次**工具调用，因为瓶颈常常是某几类调用而不是整体。
3. 每个阶段记录具体的 input 和 output，且能回答「这次调用看到了什么、返回了什么、花了多久」。
4. 记录每次模型调用的 token 与成本（pi 已经算好 cost）。
5. 记录工具失败的原因与次数（45s 超时和服务端 `context deadline exceeded` 是两件事）。
6. 记录淘宝卡片阶段：整批耗时、每张卡片的搜索/详情耗时、缓存命中、失败原因。
7. 观测链路不得影响产品请求：Langfuse 挂掉、慢、没配 key，答案照常返回。
8. 不得把 `xsec_token`、Cookie、Authorization、任何密钥值写进 trace。

## 2. 范围

**做**：Langfuse TS SDK v5 接入（单例 + flush）、pi 原始事件 → observation 的映射、耗时测量、usage/cost 映射、淘宝适配器的调用观测点、SSE 增加 `durationMs`、脱敏与降级、L1 测试。

**不做**：本地 JSONL / metrics 文件（Langfuse 是唯一事实来源，不搞第二套口径）、Langfuse Prompt Management（技能文件是行为来源，见 [09-17](./09-17-pi-skill-runtime.md)）、LLM-as-a-judge 评分、数据集与实验、把 trace 数据回灌进模型上下文、把 traceId 之外的 trace 细节透给前端、自动埋点（auto-instrumentation）。

自动埋点不做是有原因的：模型调用发生在 pi 子进程里，`@langfuse/openai` 之类的包装器包不到它。**pi 的 JSON 事件流是唯一事实来源**，所以观测是事件驱动的手动 `startObservation`。

## 3. 现状

### 3.1 链路里已有的东西

`app/api/chat/route.ts` → `runPiAgent`（`lib/pi/bridge.ts`）spawn pi，读它的 stdout（JSONL），经 `createPiEventMapper` 转成 SSE。`result` 之后由 `attachProductCards` 补淘宝卡片。

`lib/pi/bridge.ts` 已经生成了 `traceId`/`agentRunId`/`conversationId`/`messageId`，并把 `traceId` 通过 SSE 发给了前端——**但没有任何后端接收方**。这是一条现成的、未接线的 trace 主键。

### 3.2 已有痕迹的残差归因（2026-09-21 那轮）

> **本节是「没有 trace 时只能这样」的现场记录，数字已被实测取代**：落地后的两轮真实 trace 见 **12.2**。推断在总量上接近，但切分错了约 20 倍（模型那行推断 150–220s，实测 ~100s）。保留它是为了让第 10 节的验收基线有出处，**不要拿它当现状**。

跑完一轮 `韩系氧气妆`（真实 pi + 真实小红书 MCP + 真实淘宝 token），运行窗口 23:30:02 → 23:46:47 = **1005s**。没有 trace，只能用 SSE 流、轮询锚点和缓存里的落盘时间戳做推断：

| 归因 | 耗时 | 占全程 | 依据强度 |
| --- | ---: | ---: | --- |
| 15 次 XHS 调用吃满 45s 客户端超时 | 675s | 67% | 硬下限 |
| 21 次成功的 XHS 调用（单次 4–16s） | ~100–250s | 10–25% | 实测区间 |
| 24 次模型调用（含最终答案） | ~150–220s | ~15–20% | 残差推断 |
| 淘宝卡片补全（8 张） | 38s | 3.8% | 缓存时间戳 |

675s 是硬下限：16 次工具失败里 15 次是 `AbortSignal.timeout(45s)` 到点才 abort（失败文案 `The operation was aborted due to timeout`），另 1 次是模型编了个路径去 `read`（ENOENT）。`.pi/extensions/xiaohongshu-mcp.ts` 把 MCP 调用串行化，**一个超时会把它后面排队的兄弟调用一起堵住**，所以每次超时都实打实占掉 45s 墙钟。

> 当时写的「单轮最多并发 2 个工具调用」**是错的**（2026-09-22 实测更正）：扩展用一条 promise 链 `executeSerially` 把调用**完全串行化**，并发是 1。这不是小差别——它意味着一次超时会连带拖慢后面的兄弟，详见 12.2.1。

结论对不对先不论——**模型与工具的切分误差几十秒，这是本文要消灭的东西**。

### 3.3 为什么现在无法真 trace

三个缺口，都是事实层面的：

1. **pi 的 `tool_execution_end`、`message_end` 不带时长字段**（已核 `pi-coding-agent/dist/core/extensions/types.d.ts`：整个事件类型定义里 `timestamp` 只出现一次，就在 `turn_start` 上）。
2. **bridge 没有打点**。`lib/pi/events.ts` 的 `consume` 对 `turn_start`/`turn_end` 直接走 `default` 丢弃，其余事件也没有记录到达时间——而它同时看得到 start 和 end，配对就是时长。
3. **淘宝适配器没有可注入的观测点**，`buildProductCards` 的耗时只能靠外部猜。

第 1 条的补救是第 6.3 节：**耗时在 bridge 侧测墙钟**，并用 `turn_start.timestamp` 做对齐校验。

## 4. 已确认的决策

| 决策点 | 选择 | 理由 |
| --- | --- | --- |
| Trace 后端 | Langfuse，用 `@langfuse/tracing` + `@langfuse/otel`（v5，当前 5.11.1） | 用户指定。**不用** `langfuse`/`langfuse-node` 这些 unscoped 包——那是 v3 legacy；v5 是 OTel 重建的当前 GA |
| 观测方式 | 手动 `startObservation`，事件驱动 | 模型调用在 pi 子进程，SDK 包不到 provider；JSON 事件流是唯一事实来源 |
| 阶段划分 | turn / generation / tool / cards / card / 单次 HTTP | 与「哪里慢」的归因维度一一对应 |
| 耗时来源 | bridge 收到事件的墙钟差值；`turn_start.timestamp` 做漂移对照 | pi 的事件不带时长（3.3 第 1 条） |
| traceId | 由现有 `trace_<uuid>` 经 `createTraceId(seed)` 派生 32 位 hex | SSE 已把这个 id 给到前端，Langfuse 里能直接对上。注意 `lib/pi/bridge.ts` 现在用 `randomUUID()`（带连字符，36 位），**不能直接当 trace id**；被删掉的 Python 版用的是 `uuid4().hex`（32 位）——TS 这版相对它是个回退，`createTraceId(seed)` 一并修掉 |
| generation 的 input | 记**本轮新增的上下文摘要**（上一次输出 + 期间工具结果摘要），不记完整 prompt | **是拿不到，不是省流量**：pi 的 JSON 流不暴露请求体（`before_provider_request` 只发给扩展）。generation 的 output 与每个 tool 的 output 都是全文，按时间串起来就能还原本轮进过模型的全部内容（系统提示词除外），所以这里不构成信息缺口 |
| 内容记录粒度 | **全文**（脱敏后，不截断、不摘要）；`LANGFUSE_TRACE_INCLUDE_CONTENT=false` 时只记形状与字节数 | 需求要「具体 input/output」，截断会让「模型到底看到了什么」失真；已核 `@langfuse/core` 客户端不做任何截断 |
| 正文放哪个字段 | `input` / `output`，**不放 metadata** | Langfuse 读接口对 metadata 默认砍到 200 字（`expandMetadata` 才拿全），放 metadata 等于自己截断 |
| 笔记正文进 trace | 进，**全文**（脱敏后） | [09-07](./09-07-xhs-mcp-integration.md) 第 8 节「原始 MCP 响应默认不写入 Langfuse」的旧禁令**已作废**（2026-09-22 修订该文档） |
| 本地 JSONL | 不做 | 单一事实来源；避免两套口径互相打架 |
| 初始化时机 | Next.js `instrumentation.ts` 里起 NodeSDK 单例，`globalThis` 守卫 | 进程级只初始化一次；dev 的 HMR 会重复求值模块 |
| 上报模式 | `exportMode: "batched"` + 每轮结束 `forceFlush()`（带上限超时） | 长驻服务用批量；但一轮结束时必须把尾批推出去，不能让用户等 |

## 5. Trace 结构与数据流

### 5.1 一棵 trace 的形状

```text
looktrace.chat.turn                    agent    一轮请求（根 observation）
├─ pi.run                              agent    spawn → 进程退出
│  ├─ pi.turn.0                        agent    一个 turn（模型调用 + 它触发的工具）
│  │  ├─ model_call.0                  generation
│  │  ├─ read                          tool
│  │  ├─ model_call.1                  generation
│  │  ├─ xhs_search_notes              tool
│  │  ├─ xhs_get_note_detail           tool   ← 45s 的那次一眼可见
│  │  └─ …
│  ├─ pi.turn.1                        agent
│  └─ …
└─ taobao.cards                        chain    答案落地后的卡片补全
   ├─ taobao.card  兰蔻|菁纯臻颜精华粉底液   span
   │  ├─ taobao.search                 tool
   │  └─ taobao.detail                 tool
   └─ …
```

`pi.run` 与 `taobao.cards` 是**兄弟**而不是父子：卡片补全发生在 pi 进程退出之后，不是 Agent 的一部分。这一点决定了耗时归因的读法——「答案什么时候可用」看 `pi.run` 结束，「用户什么时候拿到全部内容」看 `looktrace.chat.turn` 结束。

### 5.2 数据流

```text
instrumentation.ts：起 NodeSDK + LangfuseSpanProcessor（单例，globalThis 守卫）
        ↓
app/api/chat/route.ts：startTurnTrace() → 根 observation（input = 用户消息）
        ↓
runPiAgent({ …, trace })：spawn pi
        ↓
每一行 stdout JSON（parsePiJsonLine 已脱敏）
        ↓
   ┌────────────────┴────────────────┐
   ↓                                 ↓
createPiEventMapper → SSE        trace.consume(rawEvent) → observation
   ↓                                 ↓
前端（新增 durationMs）           Langfuse
        ↓
attachProductCards(…, trace)：taobao.cards / taobao.card / taobao.search|detail
        ↓
trace.end() + forceFlush()
```

**关键点：观测消费的是脱敏后的 pi 原始事件，不是 SSE 事件。** SSE 是给前端的投影，信息有损（例如它丢掉了 `turn_start.timestamp`，也不带工具原始结果的结构）。两条线并行消费同一个事件，互不干扰。

## 6. 契约

### 6.1 观测接口

为了让「映射逻辑」可测且不把 Langfuse 拖进 `lib/commerce/`，分三层：

```ts
// lib/observability/types.ts —— 不含任何 Langfuse import
export type TraceFields = {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
};

export type Observation = {
  id: string;
  update(fields: TraceFields): void;
  end(endTime?: Date): void;
  startObservation(name: string, fields: TraceFields, type: ObservationType): Observation;
};

export type TurnTrace = Observation & {
  runContext: Pick<PiRunContext, "traceId" | "agentRunId" | "conversationId" | "messageId">;
};

// lib/observability/collector.ts —— 纯映射，事件进、observation 出
export function createTurnCollector(trace: TurnTrace, options?: { includeContent?: boolean }): {
  consume(event: Record<string, any>): void;   // 喂 pi 原始事件
  finish(status: string): Promise<void>;       // 收尾 + flush
};
```

`lib/observability/langfuse.ts` 提供两种实现：真实 Langfuse 实现，和 key 缺失时的 **no-op 实现**（同 `TAOBAO_API_TOKEN` 未配置的安静降级：不发请求、不抛错、不打印假数据）。

### 6.2 pi 事件 → observation 映射

`lib/pi/bridge.ts` 在现有 `mapper.consume(parsed)` 旁边并列调用 `trace.consume(parsed)`。映射表：

| pi 事件（JSON 流） | 观测动作 | observation | 记录字段 |
| --- | --- | --- | --- |
| `agent_start` | 开始 | `pi.run` | metadata: provider / model / skillPath |
| `turn_start` | 开始 | `pi.turn.<turnIndex>` | **startTime = `event.timestamp`**；metadata.turnIndex |
| `message_start`（assistant） | 开始 | `model_call.<callIndex>` | model = `message.model`；metadata.callIndex / provider；记录到达时刻为 start |
| `message_update`（首个 delta） | 更新 | 同上 | `completionStartTime` = 首个 `text_delta`/`thinking_delta` 的到达时刻 |
| `message_update`（usage） | 更新 | 同上 | usageDetails（终值以 `message_end` 为准） |
| `message_end`（assistant） | 结束 | 同上 | output = 助手正文**全文** + 本次 toolCall 列表；usageDetails + costDetails；metadata.stopReason |
| `tool_execution_start` | 开始 | `<toolName>`（`asType: "tool"`） | input = `args`（已脱敏）；metadata.toolCallId |
| `tool_execution_end` | 结束 | 同上 | output = `result` **全文**（已脱敏，不截断）；level = `isError ? "ERROR" : "DEFAULT"`；statusMessage = 失败原因摘要 |
| `turn_end` | 结束 | `pi.turn.<turnIndex>` | output = 本 turn 的工具清单（工具名 / 状态 / 耗时）；**正文不在这里重复**——它已经全文记在各自的 tool observation 上 |
| `agent_end` / `agent_settled` | 更新 | `pi.run` | output = { status, turns }；**不结束**，结束点见 6.3（进程 close） |
| 进程 close | 结束 | `pi.run`，随后 `looktrace.chat.turn` | `pi.run` output = { status, turns, anomalies }；根 output = 最终答案 + 卡片状态 |

`turn_start` 落到 `pi.turn` 上是这次改造的第一个直接收益：它自带 pi 侧时间戳，且 `turn_end` 与它成对，**每个 turn 的时长不再需要推断**。

### 6.3 耗时怎么算

pi 只有 `turn_start` 带时间戳，所以：

| observation | start | end |
| --- | --- | --- |
| `pi.run` | spawn 之前 | `close` 事件 |
| `pi.turn.N` | `turn_start.timestamp`（pi 侧） | `turn_end` 的到达时刻（bridge 侧） |
| `model_call.N` | `message_start` 到达时刻 | `message_end` 到达时刻 |
| `<toolName>` | `tool_execution_start` 到达时刻 | `tool_execution_end` 到达时刻 |
| `taobao.search` / `taobao.detail` | 发起前（`performance.now()`） | 返回/抛错 |
| `taobao.card` | 进入 `handle(ref)` | 卡片产出或失败 |

**诚实标注**：除 `pi.turn` 的起点外，耗时都在 bridge 边界测，包含 JSON 管道与 readline 的传输延迟。同一台机器上这是毫秒级，可以忽略；但正因为如此，`turn_start.timestamp` 同时记进 metadata 作为**漂移对照**——若 `turn_end` 到达时刻与 `turn_start.timestamp + 实测时长` 差出几百毫秒，说明管道在积压，此时模型/工具时长要按比例打折看。

### 6.4 usage 与 cost 映射

pi 的 `message_end.message.usage` 字段为 `input` / `output` / `cacheRead` / `cacheWrite` / `reasoning` / `totalTokens` / `cost`，映射到 Langfuse generation：

```ts
usageDetails: { input, output, total: totalTokens, cache_read: cacheRead, cache_write: cacheWrite, reasoning }
costDetails:  { totalCost: cost }
```

两个待实测确认点（写进第 14 节）：Langfuse UI 对 cache token 的 key 归一化、以及 `cost` 的币种是否按 USD 解释。**实现后用一次真实上报核对 UI 的 token/cost 列**，对不上只改这一处映射。

### 6.5 淘宝卡片阶段

`lib/commerce/taobao.ts` 增加一个**纯观测**的回调，不引入 Langfuse 依赖：

```ts
export type TaobaoCallInfo = {
  endpoint: "search" | "detail";
  durationMs: number;
  ok: boolean;
  code?: number;          // 业务码（见 SSOT 第 3 节）
  requestId?: string;     // 上游 requestId，用于对账
  keyword?: string;       // search 才有
  itemId?: string;        // detail 才有
  tag?: string;           // 调用方贴的归属标签，见下
};
// createTaobaoClient({ …, onCall?: (info: TaobaoCallInfo) => void })
// searchItems(keyword, { page, signal, tag }) / getItemDetail(itemId, { signal, tag })
```

**`tag` 是归属而不是内容**：并发是 2，两张卡片同时在跑，只有发起方认得出哪次调用属于自己。`lib/commerce/cards.ts` 在 `handle(ref)` 里给每次调用贴上 `productKey(ref)`，观测层据此把 `taobao.search` / `taobao.detail` 挂到**所属** `taobao.card` 之下而不是整批之下；认不出归属时退到整批之下——不丢观测，也不编一个错的父节点。适配器不解释 tag 的含义。

**注意：`TaobaoCallInfo` 里没有 URL**——token 走 query 参数，URL 永远不进观测数据（沿用 `lib/commerce/taobao.ts` 顶部注释的既有纪律）。

`app/api/chat/route.ts` 的 `attachProductCards` 把回调接到 trace 上：`taobao.search` / `taobao.detail` 各是一条 `tool`，挂在所属 `taobao.card` 之下。`taobao.card` 自己记 `metadata.cacheHit` 与 `metadata.detailLevel`（`detail` / `search` 回退）——**回退率**就是从前那个「详情没取到但卡片还是出了」的隐性失败，现在它是一条可统计的记录。

`taobao.cards` 整批的 output 为 `{ status, cardCount, failed: [{ brand, name, reason }] }`。

### 6.6 traceId 贯通与 SSE

- 根 observation 的 trace id = `await createTraceId(bridge 生成的 traceId)`，用 `startObservation(name, {}, { parentSpanContext: { traceId, spanId, traceFlags } })` 固定（`createTraceId` 的文档化用法）。
- 于是 `trace_<uuid>` 在三个地方是同一个实体：SSE 的 `status`/`result` 事件、Langfuse 的 trace URL、服务端日志。
- SSE 侧**只新增 `durationMs`**：`tool_finished` / `model_call_finished` / `result` 带上本次耗时，前端「过程区」可以直接显示「12.4s」。不新增事件类型，不透传 trace 内部结构。
- SSE 的 `resultPreview` 维持现有 2400 字 `preview()` 上限**不变**：前端契约和 Langfuse 是两回事——trace 记全文，SSE 记预览。**不要为了「统一」把 SSE 也改成全文**，那等于把整篇笔记塞进每个浏览器事件里。

## 7. 配置

```bash
# Langfuse 可观测性。两个 key 都为空 = 完全不上报（不发请求、不报错），
# 与 TAOBAO_API_TOKEN 的降级约定一致。
LANGFUSE_PUBLIC_KEY=""
LANGFUSE_SECRET_KEY=""
LANGFUSE_BASE_URL="https://cloud.langfuse.com"
LANGFUSE_TRACING_ENVIRONMENT="development"
# 可选：建议填 git sha，便于 trace 与发布对应
# LANGFUSE_RELEASE=""
# 内容记录开关：false 时只记形状与字节数（条数、长度、码值），不记正文
LANGFUSE_TRACE_INCLUDE_CONTENT="true"
```

`flushAt` / `flushInterval` / `timeout` 用 SDK 默认；每轮结束的 `forceFlush()` 加**上限超时**（`Promise.race`，默认 2s），Langfuse 慢不能让请求挂着。

## 8. 隐私与边界

三层，从内到外：

1. **入口脱敏**：pi 事件在 `parsePiJsonLine` 里已经被 `redactSensitive` 处理（`xsec_token` / Cookie / Authorization / Bearer / env 密钥值）。观测消费的就是这一份，不另开一条未脱敏的通路。
2. **出口兜底**：`LangfuseSpanProcessor` 传 `mask: ({ data }) => redactSensitive(data)`，上报前再过一遍。
3. **密钥自保护**：`LANGFUSE_SECRET_KEY` 的变量名匹配现有的 `buildSecretPattern` 规则（`SECRET`），**它的值会自动进入脱敏集合**——模型就算 `read` 到 `.env` 把 key 念出来，也进不了 trace、SSE 和答案。这一点已经被 `test/L1/pi-events.test.ts` 用 `LANGFUSE_SECRET_KEY` 作为样例断言过。

边界：

- 不记 `xsec_token`、Cookie、Authorization、签名 URL、任何密钥值。
- 不记淘宝请求 URL（token 在 query 里）。
- 不记 pi 的完整系统提示词（静态、每次都一样、又长）：只在 `pi.run` 的 metadata 里记 `systemPromptHash`（sha256 前 12 位）与长度，用于确认「技能/提示词版本变了」。
- 小红书笔记正文**属于工具 output**，随 `tool_execution_end` 以**脱敏后的全文**上报。[09-07](./09-07-xhs-mcp-integration.md) 第 8 节原先禁止「原始 MCP 响应写入 Langfuse」，该约束已于 2026-09-22 作废并在该文档中改掉——它写于 Codex 探索阶段，当时还没有「按阶段核对 input/output」的需求。

修订后**只剩一条内容纪律**：`xsec_token`／Cookie／二维码 Base64 永不进 trace（入口 `redactSensitive` + 出口 `mask` 两层）。原先那句「未截断的原始响应不落盘」也一并取消——trace 要的就是未截断的原文。`LANGFUSE_TRACE_INCLUDE_CONTENT=false` 是唯一的内容开关，用于需要时只记形状与字节数。

## 9. 失败与降级

| 情况 | 行为 |
| --- | --- |
| key 未配置 | no-op 实现，零网络调用，答案照常 |
| NodeSDK 初始化失败（版本/打包问题） | 捕获并降级为 no-op，记一条 `console.warn`，不影响请求 |
| Langfuse 不可达 / 超时 | SDK 内部重试与丢弃；`forceFlush()` 有上限超时；**任何观测调用都包 try/catch，绝不冒泡进请求路径** |
| 事件与 observation 配不上对（如 `tool_execution_end` 没有对应 start） | 忽略该事件并记 metadata 异常计数，不抛错 |
| 进程被 kill（用户取消） | `agent_end` 已把 `pi.run` 收尾；trace 保持部分完成状态，`level: "WARNING"` |

「观测不阻塞产品请求」是硬约束，沿用旧 Python 版 `observability.py` 的同名约定。

## 10. 怎么用它回答「哪里慢」

trace 落地后，第 3.2 节那张表从「残差推断」变成「查询结果」：

| 问题 | 在 Langfuse 里怎么看 |
| --- | --- |
| 全程时间花在哪 | trace 详情页的 waterfall：`pi.run` vs `taobao.cards` 的宽度对比 |
| 是哪一类调用慢 | 按 name 过滤 `xhs_*`，看 duration 分布——**贴着 45s 上限的那一簇就是超时**，与 4–16s 的成功簇一眼可分 |
| 模型 vs 工具 | `model_call.*` 总时长 vs 工具总时长，按 name 聚合 |
| 排队还是执行 | 同一 turn 内两个工具 bar 的**重叠**说明并发（上限 2）；一个 45s bar 后面紧跟另一个 bar 说明被串行队列堵住 |
| 模型慢在哪 | `completionStartTime` 到 start 的差值 = 首 token 延迟；与 output token 数对照，区分「想得久」和「写得长」 |
| 回退率 | `taobao.card` 中 `metadata.detailLevel = "search"` 的占比 |
| 成本 | 按 `costDetails.totalCost` 聚合，配合 `usageDetails.cache_read` 看缓存命中率 |

**这张表已经跑过一遍，实测结果见 12.2.1**——`韩系氧气妆` 那条 trace 的卡点是小红书调用的 45s 客户端超时：37 次里 **25 次失败，独占 82.1% 的端到端时间**（其中详情失败 1035s、占 75.6%），模型只占 7.4% 且从不失败。

**用第 3.2 节做验收基线**（保留当时的数，用于对照）：同一轮 `韩系氧气妆` 重跑，trace 里应该出现一批 45s 左右的工具（当时推断 15 条 ≈675s）、若干 `model_call`、若干 `taobao.card`。**数量级对不上说明映射有错，先修映射再谈优化**；具体数字以 12.2 的实测为准——两轮真实跑的条数与当时推断并不一致（37/33 次而非 15 次），但「超时占绝对多数」这个定性结论是一致的。

## 11. 测试计划

L1（`node --test`，不联网、不 spawn）：

- `test/L1/observability-collector.test.ts`：喂合成的 pi 事件序列，断言产出的 observation 序列——`turn_start` 开出 `pi.turn` 且 startTime 等于事件时间戳、`tool_execution_start/end` 配出带 duration 的 tool、`message_end` 的 usage 正确映射、失败工具 `level: "ERROR"` 且 statusMessage 是失败摘要、缺 start 的 end 被忽略且计数。
- 脱敏：构造带 `xsec_token=…`、`Authorization: Bearer …`、`sk-…` 的事件，断言交给 sink 的所有字段里都不含原值（复用 `pi-events.test.ts` 的断言风格）。
- 全文：构造一条 >2400 字的工具结果与一条 >2000 字的助手正文，断言交给 sink 的 output **等于原文全长**——这条测试是为了防止有人顺手复用 `preview()` 又把内容截掉。
- no-op：key 未配置时零调用、零抛错；注入会抛错的假 sink，断言 `runPiAgent` 仍正常完成。
- `test/L1/taobao-cards.test.ts` 增补：`onCall` 收到 search/detail 两条记录，字段与失败码正确，且**记录里不含 URL**。
- `test/L1/pi-bridge.test.ts` 增补：SSE 的 `tool_finished` / `result` 带 `durationMs`。

L3（`RUN_L3_E2E=1`，可选，需真实 key 与网络）：跑一轮真实 pi，断言 Langfuse 上存在一条 trace，包含 `pi.run`、≥1 个 `pi.turn`、≥1 个 `model_call`、`read`，且 `pi.run` 的耗时与进程墙钟一致。**不进默认测试集**（日常测试不联网）。

**实现时的调整**：这条 L3 断言需要一个能读回 trace 的 Langfuse 客户端，而它既依赖真 key 又依赖真网络，日常跑不起来。落地版改成 `test/L1/observability-export.test.ts`——真实 SDK 打本机假 OTLP 端点，断言导出侧的树形、traceId 派生、usage/cost 与 mask。它覆盖了原 L3 断言里可自动化的部分（第 12 节），代价是「`pi.run` 耗时与进程墙钟一致」这一条只在第 12 节的 HTTP 全链路验证里人工确认过一次。

## 12. 验证记录

已实现并验证（2026-09-22）。

| 验证 | 命令 / 方式 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过 |
| 默认测试集 | `npm test` | 65 项，64 通过，0 失败（1 项为未启用的 L3） |
| L1 测试 | `npm run test:l1` | 64 项全通过（含本文第 11 节列出的全部断言） |
| 生产构建 | `npm run build` | 通过；`@opentelemetry/sdk-node` **不需要**加进 `serverExternalPackages`（第 14.4 条已确认） |
| SDK 导出接缝 | `test/L1/observability-export.test.ts`：真实 SDK → 本机假 OTLP 端点（只走 loopback，不需要真 key） | 9 个 span 的树形、traceId 派生、usage/cost、脱敏 mask、trace 级 name/input/output 全部断言通过 |
| 卡片归属 | `test/L1/observability-cards.test.ts`：串行与并发 2 两种情况 | `taobao.search` / `taobao.detail` 挂在发起它的那张卡片之下，且起点按实测时长回填 |
| HTTP 全链路 | `next start`（`LANGFUSE_BASE_URL` 指向本机假端点）+ `POST /api/chat` | 导出 1 棵 trace：`looktrace.chat.turn`（`app_root=true`，input = 用户消息，output = 答案 + 卡片状态）+ 其子 `pi.run`；SSE `result` 带 `durationMs`；技能缺失的失败路径同样留下完整 trace |
| **真实验收** | 真实小红书 MCP + 真实模型 + 真实 Langfuse，`POST /api/chat` 跑完整一轮，再用 Langfuse 读接口按 `traceId` 拉回 | **见 12.2**：109 条 observation，每个环节的 input/output 与耗时都能直接读出来 |

### 12.1 实现期发现（写回契约）

0. **2026-09-22 真实验收跑出来的三个缺陷**（一轮真实小红书 MCP + 真实模型 + 真实 Langfuse，见 12.3，均已修复并加测试）：
   - **`taobao.search` / `taobao.detail` 的宽度是 0ms**。`onCall` 是调用**结束后**才回调的，直接开一个 span 再立刻 `end()` 等于零宽——waterfall 里看不见上游耗时。改法：用适配器实测的 `durationMs` 回填 `startTime`（`lib/observability/cards.ts`）。修复前那轮的数据没丢，真实耗时仍在 `metadata.durationMs` 里。
   - **trace 级的 `name` 是空的**。TS SDK 只打 `langfuse.internal.is_app_root`，后端据此能把 span 名当 trace 名，但**不会**提升 input/output；Python SDK 打的是 `langfuse.internal.as_root`，两者不是一回事。现在显式写 `langfuse.trace.name`。
   - **trace 级的 `input` / `output` 是空的**。同上，要在根 span 上额外写一份 trace 级属性（`setTraceIO`，input 在建 trace 时写、output 在收尾时镜像）。三个机制是逐一上报核对出来的：`setTraceIO` → 只有 I/O；显式 `langfuse.trace.*` → 三个都有；`internal.as_root` → 只有 name。

   修复前后各跑了一轮真实请求，同一个项目里并排可见：修复前那条 `name=''`、`io=(False,False)`；修复后 `name='looktrace.chat.turn'`、input = 用户消息、output = 答案。这三条只影响**读起来方不方便**，不影响数据完整性——叶子 observation 的 input/output/耗时本来就是对的。

1. **SDK 的子节点方法会丢 `startTime`**（第 6.3 节差点失效）。`observation.startObservation(name, attrs, opts)` 内部只转发 `asType` 与 `parentSpanContext`。因此 `lib/observability/langfuse.ts` 改为调用**模块级** `startObservation` 并显式传 `parentSpanContext`，把 `startTime` 一路带到 SDK。若沿用方法式调用，`pi.turn.N` 的起点会退化成「bridge 收到事件的时刻」，第 6.3 节的漂移对照就没了。`test/L1/observability-export.test.ts` 直接断言了导出侧 `turn.start == turn_start.timestamp`。
2. **metadata 里的数字到 Langfuse 是字符串**。SDK 只让字符串原样通过，数字/布尔会被 JSON 序列化：`durationMs`、`anomalies`、`cacheHit` 读出来是 `"47120"` / `"0"` / `"false"`。按 metadata 聚合时要按字符串处理；span 自身的 duration 仍是数字，waterfall 用的是它。
3. **出口 `mask` 不覆盖 metadata**。processor 只对 `input` / `output`（以及 trace 级同名属性）调用 `mask`；metadata 被摊平成 `langfuse.observation.metadata.<key>`，不在替换名单里。所以「正文只放 input/output、不放 metadata」（第 4 节）不只是为了不被截断，也是脱敏纪律的要求。`statusMessage` 同样不在 `mask` 覆盖范围内，因此它只放由脱敏后事件派生的短摘要。
4. **`mediaUploadEnabled` 显式设为 `false`**。SDK 默认为 `true`，开启时会把 base64 内联媒体抽出来上传到 Langfuse——二维码 Base64 正是这样漏出去的。这一条是内容纪律的硬线，不是可调项。
5. **`pi.run` 的结束点是进程 close，不是 `agent_end`**（第 6.2 节与 6.3 节冲突，按 6.3 与第 5.1 节的「spawn → 进程退出」标签取 close）：`agent_end` / `agent_settled` 只更新 `pi.run` 的 output。cancel 路径同样走到 close，`finish()` 兜底并按 `WARNING` 收尾。
6. **`model_call.<n>` 是 0 基的全局序号**（与第 5.1 节的树一致）。SSE 的 `model_call_started.callIndex` 是 1 基的前端投影，两者不同源。
7. **每轮两次 `forceFlush()`**：`collector.finish()` 结束时一次（保证卡片阶段再久也不会丢掉 Agent 侧的 trace），根 observation 结束后再一次。两次都在 `result` 事件之后，且各有 2s 上限，用户不会因为观测而多等。
8. **未配置 key 时零开销**：`startTurnTrace()` 返回 `null`，此时 collector 是空实现，连正文字符串都不拼。降级与 `TAOBAO_API_TOKEN` 一致。


### 12.2 真实验收（2026-09-22，真实小红书 MCP + 真实模型 + 真实 Langfuse）

一轮「我想画韩系氧气妆」，`pi.run` 墙钟 **1325.3s**，根 trace **1369.5s**，109 条 observation。**全程无推断**：所有数字都是从 Langfuse 读接口按 `traceId` 拉回来的。

#### 12.2.1 延时卡点（第一轮，1369.5s 去哪了）

**先把两个口径分清，否则百分比会自相矛盾：**

- **调用时间**＝叶子 observation 的 `latency` 之和（trace 上直接可读）。它**含排队等待**：bridge 量的是 `tool_execution_start` → `tool_execution_end`，而 `.pi/extensions/xiaohongshu-mcp.ts` 用一条 promise 链把 MCP 调用**串行化**，排在后面的调用要等前面的跑完才开始——这段等待被算进了它的 `latency`。所以各模块加起来**超过** 100%（小红书 132%），**不能当占比读**。
- **独占执行（墙钟）**＝每次调用真正占用处理器的时间。串行队列下**墙钟 = Σ 各自独占执行**，排队等待不产生额外墙钟，只是把同一段时间记到了另一个调用头上。这一列加起来正好 100%。

| 模块 | 次数 | 调用时间 | 占根 trace | **独占执行（墙钟）** | **占根 trace** |
| --- | ---: | ---: | ---: | ---: | ---: |
| **小红书 · 失败** | **25** | 1494.1s | 109.1% | **1125.0s**（= 25 × 45s） | **82.1%** |
| ↳ `xhs_get_note_detail` 失败 | 23 | 1404.1s | 102.5% | 1035.0s | 75.6% |
| ↳ `xhs_search_notes` 失败 | 2 | 90.0s | 6.6% | 90.0s | 6.6% |
| **小红书 · 成功** | 12 | 318.0s | 23.2% | 98.6s | 7.2% |
| **模型调用** `model_call.*` | 21 | 101.8s | 7.4% | **101.8s** | **7.4%** |
| **淘宝卡片** `taobao.*` | 8 张 | 81.9s | 6.0% | 43.9s（整批墙钟） | 3.2% |
| `read` | 3 | ≈0s | 0% | ≈0s | 0% |
| 进程启动 / JSON 管道 / turn 间隙 | — | — | — | ≈0.3s | 0.02% |

`taobao.*` 在 `pi.run` 之外（卡片补全是它的兄弟），所以是加在根 trace 上的。

**独占执行这一列就是答案：**

```text
根 trace  1369.5s
├─ 小红书 · 失败 25 次    1125.0s   82.1%   ← 其中详情 1035s、搜索 90s
├─ 小红书 · 成功 12 次      98.6s    7.2%
├─ 模型调用 21 次          101.8s    7.4%   （0 失败）
└─ 淘宝卡片  8 张           43.9s    3.2%
```

**四分之三的端到端时间花在 23 次读不到的详情上。**

两个口径给出的答案几乎相同，这不是巧合：失败调用的 trace 耗时里超标的那些（50–60s、90s）**不是它自己跑的，是排队等前面超时的兄弟白等的**。所以「独占执行 = 45s × 次数」是准确的墙钟口径，而 trace 上的 1494.1s 是含重复计入的调用时间口径。两者都指向 82%：

| 口径 | 算法 | 结果 |
| --- | --- | ---: |
| 调用时间 | 失败 1494.1s ÷ 小红书总 1812.1s | **82.5%** |
| 独占执行（墙钟） | 失败 1125s ÷ 根 trace 1369.5s | **82.1%** |

第二轮的形状相同、程度轻些：失败 14 次 × 45s = 630s，占根 trace 960.5s 的 **65.6%**。

失败耗时的分布（按 5s 分桶实测）——**这些「超标」全是排队等待，不是重试**：

```text
 45–50s  ████████████ 12      ← 没排队，自己跑满 45s 超时
 50–55s  ████          4      ← 等了兄弟 5–10s，再跑满 45s
 55–60s  ██            2      ← 同上
 90–95s  ███████       7      ← 等了兄弟 ~45s（兄弟也超时了），再跑满 45s
```

**卡点就两条：**

1. **37 次小红书调用里 25 次失败（68%）**，失败原因 100% 是 45s 客户端超时（`XHS_MCP_REQUEST_TIMEOUT_SECONDS=45`）。这是唯一的系统性卡点，独占 **82.1%** 的端到端时间。
2. **成功的调用也不快**：搜索均值 35.1s、详情均值 26.0s——远高于 §3.2 当时记的「单次 4–16s」。

**根因已于 2026-09-22 定位（trace 只是把它量出来，定位靠另做的单变量实验）**：失败全部来自**视频笔记**——上游 `get_feed_detail` 打开页面后等「DOM 连续静止」（`go-rod.(*Page).MustWaitDOMStable`，`xiaohongshu/feed_detail.go:112`），而视频播放器自动播放、每秒改动 DOM 8–14 次，该条件**永不成立**，只能等满 60s 的 context deadline。

| 笔记类型 | 成功 | 失败 |
| --- | ---: | ---: |
| 视频 | **0** | **7** |
| 图文 | **7** | **0** |

V/N 交叉测试（顺序不成变量）；同一篇视频笔记、同一 token、同一时刻，普通 Chromium **1.6s** 就能打开——所以不是网络、token 或登录问题。第 2 条里的「搜索也慢」是同一原因的次生现象：详情卡住时占着共享浏览器，排在后面的搜索只能等。完整证据链、临时对策和解除条件见 [09-07 第 12 节](./09-07-xhs-mcp-integration.md)。

**这也说明第 10 节那张表只到「哪一类调用慢」为止**：它能告诉你「贴 45s 上限的那一簇是超时、详情是最大的一块」，但**答不了「为什么是这一类」**——那需要离开 trace 去做控制变量实验。trace 负责把问题缩小到可实验的规模，这是它的价值边界。

峰值 50.6s 的搜索、60.5s 的详情，我用 `curl` 直接打 `127.0.0.1:18060/mcp`（绕开 agent / pi / 观测层）复现过：同一个关键词一次 7.8s、一次 60.5s。慢在 MCP，不在链路。

> **两处更正**（都是先写错、被自己的数据推翻的）：
> 1. 我一开始说「慢的是详情接口，不是搜索接口」——**不成立**。两类接口都会超时、都慢；详情只是因为被调了 6 倍次数（31 vs 5）才在绝对量上占大头。
> 2. 我一开始把 90s 的条目解释成「重试翻倍，多烧 315s」——**也不成立**。扩展里每个工具只发一次 `postMcp`（`cards.ts` 的 `withRetry` 只管淘宝），**没有任何重试**；90s = 排队等兄弟 45s + 自己超时 45s。而且排队等待不额外消耗墙钟，所以「多烧 315s」这个说法本身是错的。
>
> 两次都是「按耗时猜」而不是「按 `level`/`name` 聚合 + 读代码」造成的。

#### 12.2.2 与第 3.2 节残差推断的对照

| 环节 | 实测 | 第 3.2 节的残差推断 |
| --- | ---: | ---: |
| 小红书调用 37 次 | 25 次失败 1494.1s（45–50s×12、50–60s×6、90s×7）；12 次成功 318.0s | 15 次超时 675s + 21 次成功 100–250s |
| 模型调用 21 次 | **101.8s**（均值 4.8s，最长 41.0s 即最终答案那次） | 24 次 ≈150–220s |
| `pi.turn` 21 个 | 1325.2s | — |
| `taobao.card` 8 张 | 81.9s，回退率 0%，1 张 `code=301` 失败 | 8 张 ≈38s |
| 根 trace | 1369.5s | 1005s（总量对得上，切分完全对不上） |

**结论**：§3.2 的残差推断在总量上接近，但**模型那行错了 20 倍**（推断 150–220s、占 15–20%，实测 101.8s、占 7.4%）——瓶颈几乎全是小红书调用超时。这正是本文要消灭的误差。

`xhs_search_notes` 成功时能拿到 20 条笔记，26KB 全文进 trace（超过 SSE 的 2400 字预览上限）——正文完整性这一条也在真实链路上确认了。

> **2026-09-24 注**：这是 MCP 链路（当时叫 `xhs_search_feeds`，原始响应直接透传）的观察值。换成 Just One API 后工具返回的是**受控映射后的形状**，体积量级变小，这个 26KB 与 2400 字预览上限的关系需要重测——见 [09-24-xhs-api-integration.md](./09-24-xhs-api-integration.md) 第 6.5 节。

#### 12.2.3 第二轮（修复后重跑）

同一个 prompt，两次跑出的是同一个定性结论，量级也接近：

| | 第一轮 | 第二轮 |
| --- | ---: | ---: |
| 根 trace / `pi.run` | 1369.5s / 1325.3s | 960.5s / 959.8s |
| 小红书调用 | 37 次，**25 次失败**，独占 **1125s = 82.1%** | 33 次，**14 次失败**，独占 **630s = 65.6%** |
| ↳ 详情接口 | 31 次：23 失败 / 8 成功（成功均值 26.0s） | 27 次：14 失败 / 13 成功（成功均值 41.5s） |
| ↳ 搜索接口 | 5 次：2 失败 / 3 成功（成功均值 35.1s） | 5 次：0 失败 / 5 成功（成功均值 46.0s） |
| 模型调用 | 21 次 101.8s（0 失败） | 16 次 96.9s（0 失败） |
| `taobao.card` | 8 张 81.9s | 2 张 1.1s |
| trace 级 name / I/O | 空（修复前） | 齐全（修复后） |

两轮里模型都只占约 7–10% 且从不失败；小红书调用的失败率是 68% 与 42%。

#### 12.2.4 第三轮（只在技能层规避视频笔记之后）

根因定位后，技能层加了「只读 `noteCard.type === "normal"` 的条目」（见 12.2.1 与 [09-07 第 12 节](./09-07-xhs-mcp-integration.md)），其余代码未动，同一 prompt 再跑一轮：

| | 第一轮 | 第三轮（加约束） |
| --- | ---: | ---: |
| 根 trace / 端到端 | 1369.5s = **22.8 分** | 222.0s = **3.7 分** |
| 详情调用 / 失败 | 31 / **23** | 11 / **0** |
| 搜索 / 失败 | 5 / 2 | 4 / 0 |
| 读了视频笔记 | —（未统计） | **0 次** |
| 模型调用 | 21 次 101.8s | 7 次 93s（其中最终答案 80s） |
| 小红书工具独占 | 1223s（89%） | 129s（58%） |

**6.2× 提速，零超时。** 模块占比也随之翻转——瓶颈从「工具超时」变成「模型写答案」：

```text
第三轮根 trace 222s
├─ 小红书工具  独占 129s   58%    （第一轮 1223s / 89%）
└─ 模型调用      93s       42%    （其中最终答案 80s，现在单项最大）
```

这一轮同时说明了本文的用处变了：**前两轮 trace 是用来「发现哪里慢」的，第三轮 trace 是用来「确认改对了」的**——详情调用数、失败数、`pi.run` 宽度三个数直接给出验收结论，不需要再推断。

代价见 [09-07 12.4](./09-07-xhs-mcp-integration.md)：该轮搜索结果里视频占 66%，全部排除意味着来源广度变窄。这是临时规避，不是终局。

### 12.3 尚未验证

- **第 14.1 / 14.2 条**（Cloud vs self-host 的保留策略、UI 的 cache token 列与币种）需要对照 Langfuse 界面确认，未做；第 14.3 条的客户端侧已由 12.2 的真实数据回答。
- 第 14.6 条的 `completionStartTime` 是否被 UI 画成 TTFT，未核对。

## 13. 实现清单

| 文件 | 改动 |
| --- | --- |
| `lib/observability/types.ts` | 新增：观测接口，无 Langfuse 依赖 |
| `lib/observability/collector.ts` | 新增：pi 事件 → observation 纯映射 |
| `lib/observability/langfuse.ts` | 新增：Langfuse 实现 + NodeSDK 单例 + no-op 降级 |
| `lib/observability/cards.ts` | 新增：`taobao.cards` 那棵子树，按 `tag` 把上游调用挂回所属卡片 |
| `instrumentation.ts` | 新增：Next.js 进程级初始化（`NEXT_RUNTIME === "nodejs"` 守卫） |
| `lib/pi/bridge.ts` | 增 `options.trace`；在事件循环里并行喂 collector；SSE 加 `durationMs` |
| `lib/pi/events.ts` | `turn_start`/`turn_end` 不再落 `default`（至少喂观测）；`durationMs` 字段 |
| `app/api/chat/route.ts` | 建根 trace；给 `attachProductCards` 传 trace |
| `lib/commerce/taobao.ts` | 增 `onCall` 观测回调；调用可带 `tag` 供上层归属 |
| `lib/commerce/cards.ts` | 在 `handle(ref)` 外开合 `taobao.card`；给上游调用贴卡片 tag |
| `.env.example` | Langfuse 变量 |
| `package.json` | `@langfuse/tracing`、`@langfuse/otel`、`@opentelemetry/sdk-node`、`@opentelemetry/api` |

## 14. 待确认

1. **Langfuse 部署形态**：Cloud 还是 self-host？影响 `LANGFUSE_BASE_URL` 与数据保留策略。
2. **usage/cost key 归一化**（第 6.4 节）：实现后需用一次真实上报核对 UI，确认 cache token 列与币种。映射本身已由 `test/L1/observability-export.test.ts` 钉住（`{input, output, total, cache_read, cache_write, reasoning}` / `{totalCost}`），待确认的只是 UI 认不认这组 key。
3. **单事件摄取上限**：`@langfuse/core` 客户端不做截断（已核），服务端对单条 observation 的 payload 大小是否有上限、超限是拒绝还是截断，需用一轮真实数据（11 篇笔记全文 + 5003 字答案）确认。若不接受，再决定是分片还是降级为只记形状。**注意**：超限时优先考虑 `LANGFUSE_TRACE_INCLUDE_CONTENT=false`（只记形状与字节数），而不是在代码里加截断——截断会让「模型到底看到了什么」失真，那是这份 spec 要消灭的东西。
4. ~~Next.js 打包 OTel~~ **已确认不需要**：`npm run build` 通过，`@opentelemetry/sdk-node` 无需进 `serverExternalPackages`（第 12 节）。
5. **`durationMs` 是否要进前端**：本 spec 只到 SSE 字段，已经落地。过程区显示「12.4s」是前端的事，需要的话另开。
6. **`completionStartTime` 是否被 UI 当成首 token 延迟**：SDK 已接受该字段（导出可见 `langfuse.observation.completion_start_time`），但 UI 是否据此画出 TTFT 未核对；若 UI 不认，首 token 延迟仍有 `metadata.timeToFirstTokenMs`（字符串）可读。
