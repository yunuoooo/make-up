import type { PiRunContext } from "../pi/events.ts";

/**
 * 观测接口。这里**不含任何 Langfuse import**：事件 → observation 的映射逻辑
 * （collector.ts）只依赖这一层，所以它能在不联网、不装后端的 L1 测试里被完整断言。
 * 真实实现与 no-op 实现见 langfuse.ts。
 */

export type ObservationType = "span" | "generation" | "agent" | "tool" | "chain";

/** Langfuse 的 observation 级别。 */
export type ObservationLevel = "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";

/**
 * 一次 observation 能上报的字段。
 *
 * 正文放 `input`/`output` 而不是 `metadata`：Langfuse 的读接口对 metadata 默认只返回 200 字，
 * 放进去等于自己把内容截断。
 */
export type TraceFields = {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: ObservationLevel;
  statusMessage?: string;
  /** 仅 generation：模型名。 */
  model?: string;
  /** 仅 generation：首 token 到达时刻。与 start 的差就是首 token 延迟。 */
  completionStartTime?: Date;
  /** 仅 generation：token 用量（Langfuse 的 key，不是 pi 的原始 key）。 */
  usageDetails?: Record<string, number>;
  /** 仅 generation：成本（pi 已经算好）。 */
  costDetails?: Record<string, number>;
  /**
   * 只在**创建** observation 时生效，`update()` 里会被忽略（起点不可改）。
   * pi 的 `turn_start` 自带 pi 侧时间戳，用它当起点才能把「模型/工具耗时」和「管道积压」分开。
   */
  startTime?: Date;
};

export type Observation = {
  id: string;
  update(fields: TraceFields): void;
  end(endTime?: Date): void;
  /** 在当前 observation 之下开一个子 observation。 */
  startObservation(name: string, fields: TraceFields, type?: ObservationType): Observation;
};

/**
 * 根 observation：一轮请求一棵 trace。
 *
 * `runContext.traceId` 与 SSE 发给前端的 `traceId` 同源，于是「前端看到的那一轮」
 * 和「Langfuse 里的那棵树」是同一个实体。`agentRunId` 等在 bridge 生成之后才有，
 * 因此是可选的——它们由 bridge 补进 observation 的 metadata。
 */
export type TurnTrace = Observation & {
  runContext: { traceId: string } & Partial<Pick<PiRunContext, "agentRunId" | "conversationId" | "messageId">>;
};
