import {
  extractAssistantText,
  extractToolCalls,
  summarizeToolResult
} from "../pi/events.ts";
import type { Observation, TurnTrace } from "./types.ts";

/**
 * pi 原始事件 → Langfuse observation 的纯映射。
 *
 * 观测消费的是**脱敏后的 pi 原始事件**（`parsePiJsonLine` 的产物），不是 SSE 事件：
 * SSE 是给前端的投影，信息有损（丢掉了 turn_start.timestamp，也不带工具结果的结构）。
 * 两条线并行消费同一个事件流，互不干扰。
 *
 * 这一层不 import Langfuse，所以映射逻辑可以在 L1 测试里逐条断言。
 */

export type TurnCollectorOptions = {
  /** false 时只记形状与字节数，不记正文（LANGFUSE_TRACE_INCLUDE_CONTENT=false）。 */
  includeContent?: boolean;
  /**
   * `pi.run`。bridge 在 spawn **之前**开出来，这样它的耗时就是真正的进程墙钟；
   * 不传则在 `agent_start` 时补开（单独用 collector 时用得上）。
   */
  run?: Observation | null;
  /** 收尾后推尾批。任何失败都在这里被吞掉，不冒泡进请求路径。 */
  flush?: () => Promise<void>;
  /** 测试注入时钟。 */
  now?: () => number;
  /** message 事件不带 provider/model 时的兜底，与 bridge 的取值一致。 */
  provider?: string;
  model?: string;
};

export type TurnCollector = {
  consume(event: Record<string, any>): void;
  finish(status: string): Promise<void>;
};

type ToolRun = { name: string; status: "succeeded" | "failed"; durationMs?: number; reason?: string };

type TurnRun = {
  observation: Observation;
  startedAt: number;
  tools: ToolRun[];
};

type OpenTool = {
  observation: Observation;
  name: string;
  startedAt: number;
};

/** 一次模型调用的 usage → Langfuse 的两组 key。币种与 cache token 列以真实上报核对，见 spec 6.4。 */
export function mapUsage(usage: any): { usageDetails: Record<string, number>; costDetails: Record<string, number> } {
  const usageDetails: Record<string, number> = {};
  if (!usage || typeof usage !== "object") return { usageDetails, costDetails: {} };
  if (typeof usage.input === "number") usageDetails.input = usage.input;
  if (typeof usage.output === "number") usageDetails.output = usage.output;
  if (typeof usage.totalTokens === "number") usageDetails.total = usage.totalTokens;
  if (typeof usage.cacheRead === "number") usageDetails.cache_read = usage.cacheRead;
  if (typeof usage.cacheWrite === "number") usageDetails.cache_write = usage.cacheWrite;
  if (typeof usage.reasoning === "number") usageDetails.reasoning = usage.reasoning;
  return {
    usageDetails,
    costDetails: typeof usage.cost === "number" ? { totalCost: usage.cost } : {}
  };
}

export function createTurnCollector(trace: TurnTrace | null, options: TurnCollectorOptions = {}): TurnCollector {
  // 未配置 key 时整条观测链是空实现：不建字符串、不推批、不报错。
  if (!trace) return { consume() {}, async finish() {} };
  // 非空别名：闭包里 TS 不会保留外层对可变参数的收窄。
  const root = trace;

  const now = options.now ?? (() => Date.now());
  const includeContent = options.includeContent ?? true;
  let run = options.run ?? null;
  let currentTurn: TurnRun | null = null;
  let modelCall: { observation: Observation; startedAt: number; firstDeltaAt: number | null } | null = null;
  const openTools = new Map<string, OpenTool>();
  let modelCallIndex = 0;
  let completedTurns = 0;
  let anomalies = 0;

  /** 工具/模型调用都挂在当前 turn 之下，没有 turn 时退化到 pi.run / 根节点。 */
  const parent = (): Observation => currentTurn?.observation ?? run ?? root;

  const elapsed = (startedAt: number): number => Math.max(0, Math.round(now() - startedAt));

  /** 内容开关关闭时只留形状与字节数——够回答「看到了多少」，不落正文。 */
  const content = (value: unknown): unknown => {
    if (includeContent) return value;
    const text = typeof value === "string" ? value : safeStringify(value);
    return { chars: text.length, bytes: Buffer.byteLength(text, "utf8") };
  };

  return {
    consume(event: Record<string, any>): void {
      // 观测调用一律不许冒泡进请求路径：任何一个 observation 抛错都只记一次异常计数。
      try {
        consumeEvent(event);
      } catch {
        anomalies += 1;
      }
    },

    async finish(status: string): Promise<void> {
      try {
        // 中途被打断的调用按 WARNING 收尾：trace 保持部分完成，而不是丢一个悬空 observation。
        closeModelCall("interrupted");
        for (const [toolCallId, open] of openTools) {
          open.observation.update({ level: "WARNING", statusMessage: `未收到结束事件（${status}）` });
          open.observation.end();
          currentTurn?.tools.push({ name: open.name, status: "failed", durationMs: elapsed(open.startedAt) });
          openTools.delete(toolCallId);
        }
        if (currentTurn) {
          const turn = currentTurn;
          currentTurn = null;
          turn.observation.update({ level: "WARNING", output: { tools: turn.tools }, metadata: { durationMs: elapsed(turn.startedAt) } });
          turn.observation.end();
        }
        // pi.run 到进程 close 才结束（6.3）：这样它的宽度就是真正的进程墙钟，
        // agent_end / agent_settled 只更新 output，不提前截断。
        run?.update({ output: { status, turns: completedTurns, anomalies }, metadata: { anomalies } });
        run?.end();
        root.update({ metadata: { anomalies } });
      } catch {
        // 收尾失败只丢观测数据。
      }

      try {
        await options.flush?.();
      } catch {
        // 同上：推批失败不影响已经返回的答案。
      }
    }
  };

  function consumeEvent(event: Record<string, any>): void {
    switch (event.type) {
      case "agent_start": {
        if (!run) {
          run = root.startObservation("pi.run", { metadata: { provider: options.provider, model: options.model } }, "agent");
        }
        return;
      }

      case "turn_start": {
        const index = typeof event.turnIndex === "number" ? event.turnIndex : completedTurns;
        const startedAt = now();
        currentTurn = {
          startedAt,
          tools: [],
          // 父节点是 pi.run，不是上一个 turn：turn_start 到达时上一个 turn 可能刚结束。
          observation: (run ?? root).startObservation(`pi.turn.${index}`, {
            // pi 侧的起点，用来和 bridge 侧的到达时刻做漂移对照（6.3）。
            startTime: piTimestamp(event.timestamp) ?? new Date(startedAt),
            metadata: {
              turnIndex: index,
              piTimestamp: typeof event.timestamp === "number" ? event.timestamp : undefined
            }
          }, "agent")
        };
        return;
      }

      case "turn_end": {
        if (!currentTurn) {
          anomalies += 1;
          return;
        }
        const turn = currentTurn;
        currentTurn = null;
        completedTurns += 1;
        turn.observation.update({
          // 正文不在这里重复：它已经全文记在各自的 tool observation 上。
          output: { tools: turn.tools },
          metadata: { durationMs: elapsed(turn.startedAt), toolCount: turn.tools.length }
        });
        turn.observation.end();
        return;
      }

      case "message_start": {
        if (event.message?.role !== "assistant") return;
        closeModelCall("interrupted");
        const index = modelCallIndex;
        modelCallIndex += 1;
        modelCall = {
          startedAt: now(),
          firstDeltaAt: null,
          // 从 0 开始，与 5.1 的树一致（SSE 的 model_call_started.callIndex 是给前端的投影，从 1 开始）。
          observation: parent().startObservation(`model_call.${index}`, {
            model: event.message.model ?? options.model,
            metadata: { callIndex: index, provider: event.message.provider ?? options.provider }
          }, "generation")
        };
        return;
      }

      case "message_update": {
        if (!modelCall) return;
        const assistantEvent = event.assistantMessageEvent ?? {};
        if (modelCall.firstDeltaAt === null && (assistantEvent.type === "text_delta" || assistantEvent.type === "thinking_delta")) {
          modelCall.firstDeltaAt = now();
          modelCall.observation.update({ completionStartTime: new Date(modelCall.firstDeltaAt) });
        }
        if (event.usage && typeof event.usage === "object") {
          modelCall.observation.update(mapUsage(event.usage));
        }
        return;
      }

      case "message_end": {
        if (event.message?.role !== "assistant" || !modelCall) return;
        const call = modelCall;
        modelCall = null;
        const { usageDetails, costDetails } = mapUsage(event.message.usage);
        call.observation.update({
          output: {
            text: content(extractAssistantText(event.message.content)),
            toolCalls: extractToolCalls(event.message.content).map((toolCall) => ({
              id: toolCall.id,
              name: toolCall.name,
              arguments: content(toolCall.arguments)
            }))
          },
          usageDetails,
          costDetails,
          metadata: {
            stopReason: event.message.stopReason ?? null,
            durationMs: elapsed(call.startedAt),
            // 首 token 延迟：想得久还是写得长，靠它和 output token 数对照。
            timeToFirstTokenMs: call.firstDeltaAt === null ? undefined : call.firstDeltaAt - call.startedAt
          }
        });
        call.observation.end();
        return;
      }

      case "tool_execution_start": {
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
        const name = String(event.toolName ?? "tool");
        const previous = openTools.get(toolCallId);
        if (previous) {
          // 同一个 id 的 start 没等到 end 又来一次：先收掉旧的，避免留下永不结束的观测。
          anomalies += 1;
          previous.observation.update({ level: "WARNING", statusMessage: "重复的开始事件，前一次未收到结束事件" });
          previous.observation.end();
        }
        openTools.set(toolCallId, {
          name,
          startedAt: now(),
          observation: parent().startObservation(name, { input: content(event.args ?? {}) }, "tool")
        });
        return;
      }

      case "tool_execution_end": {
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
        const open = openTools.get(toolCallId);
        // 配不上对的 end 直接忽略并计数，绝不抛错，也不给一条没有起点的观测。
        if (!open) {
          anomalies += 1;
          return;
        }
        openTools.delete(toolCallId);

        const durationMs = elapsed(open.startedAt);
        const reason = summarizeToolResult(open.name, event.result, event.isError);
        // 45s 客户端超时和服务端 context deadline exceeded 是两件事，都要留原文摘要。
        open.observation.update({
          output: content(event.result),
          level: event.isError ? "ERROR" : "DEFAULT",
          statusMessage: event.isError ? reason : undefined,
          metadata: { toolCallId, durationMs }
        });
        open.observation.end();
        currentTurn?.tools.push({
          name: open.name,
          status: event.isError ? "failed" : "succeeded",
          durationMs,
          reason: event.isError ? reason : undefined
        });
        return;
      }

      case "agent_end":
      case "agent_settled": {
        if (!run) return;
        run.update({ output: { status: event.type, turns: completedTurns } });
        return;
      }

      default:
        return;
    }
  }

  function closeModelCall(state: string): void {
    if (!modelCall) return;
    const call = modelCall;
    modelCall = null;
    call.observation.update({ level: "WARNING", metadata: { state } });
    call.observation.end();
  }
}

function piTimestamp(value: unknown): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? "";
  } catch {
    return "<unserializable>";
  }
}
