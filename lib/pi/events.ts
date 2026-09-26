export type PiRunContext = {
  traceId: string;
  agentRunId: string;
  conversationId: string;
  messageId: string;
  provider: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
};

export type AppSseEvent = {
  event: string;
  data: Record<string, unknown>;
};

type PiEvent = Record<string, any>;

export function parsePiJsonLine(line: string): PiEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return redactSensitive(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export type PiEventMapperOptions = {
  /** 测试注入时钟；默认墙钟。 */
  now?: () => number;
};

export function createPiEventMapper(context: PiRunContext, options: PiEventMapperOptions = {}) {
  const now = options.now ?? (() => Date.now());
  let callIndex = 0;
  let lastUsageKey = "";
  let modelCallStartedAt: number | null = null;
  // 工具耗时只能在 bridge 边界测墙钟：pi 的 tool_execution_end 不带时长字段。
  const toolStartedAt = new Map<string, number>();

  /** 配对成功才算时长；配不上对就不给数字，避免编一个看起来像实测的值。 */
  const elapsed = (startedAt: number | null | undefined): number | undefined =>
    startedAt === null || startedAt === undefined ? undefined : Math.max(0, Math.round(now() - startedAt));

  return {
    consume(event: PiEvent): AppSseEvent[] {
      switch (event.type) {
        case "message_start":
          if (event.message?.role !== "assistant") return [];
          callIndex += 1;
          modelCallStartedAt = now();
          return [{
            event: "model_call_started",
            data: {
              traceId: context.traceId,
              agentRunId: context.agentRunId,
              provider: event.message.provider ?? context.provider,
              model: event.message.model ?? context.model,
              callIndex,
              systemPrompt: context.systemPrompt,
              userPrompt: context.userPrompt
            }
          }];

        case "message_update": {
          const output: AppSseEvent[] = [];
          const assistantEvent = event.assistantMessageEvent ?? {};
          if (assistantEvent.type === "text_delta" && typeof assistantEvent.delta === "string") {
            output.push({ event: "text_delta", data: { text: redactSensitive(assistantEvent.delta) } });
          }
          // 思维链按增量透出，前端先看到"怎么想的"，再看到最终答案。
          if (assistantEvent.type === "thinking_delta" && typeof assistantEvent.delta === "string") {
            output.push({ event: "thinking_delta", data: { text: redactSensitive(assistantEvent.delta) } });
          }
          if (assistantEvent.type === "thinking_end") {
            output.push({ event: "thinking_end", data: {} });
          }
          // toolcall_end 在工具真正执行前到达，可以先告诉用户"准备查看什么"。
          if (assistantEvent.type === "toolcall_end" && assistantEvent.toolCall) {
            output.push({
              event: "tool_planned",
              data: {
                toolCallId: assistantEvent.toolCall.id,
                toolName: assistantEvent.toolCall.name,
                summary: summarizeToolCall(assistantEvent.toolCall.name, assistantEvent.toolCall.arguments)
              }
            });
          }
          if (event.usage && typeof event.usage === "object") {
            const usage = usageData(event.usage);
            const usageKey = JSON.stringify(usage);
            if (usageKey !== lastUsageKey) {
              lastUsageKey = usageKey;
              output.push({ event: "model_usage", data: usage });
            }
          }
          return output;
        }

        case "message_end":
          if (event.message?.role !== "assistant") return [];
          return [{
            event: "model_call_finished",
            data: {
              provider: event.message.provider ?? context.provider,
              model: event.message.model ?? context.model,
              stopReason: event.message.stopReason ?? null,
              usage: usageData(event.message.usage),
              ...durationField(elapsed(modelCallStartedAt))
            }
          }];

        case "tool_execution_start":
          if (typeof event.toolCallId === "string") toolStartedAt.set(event.toolCallId, now());
          return [{
            event: "tool_started",
            data: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              summary: summarizeToolCall(event.toolName, event.args),
              args: redactSensitive(event.args ?? {})
            }
          }];

        case "tool_execution_end": {
          const startedAt = typeof event.toolCallId === "string" ? toolStartedAt.get(event.toolCallId) : undefined;
          if (typeof event.toolCallId === "string") toolStartedAt.delete(event.toolCallId);
          return [{
            event: "tool_finished",
            data: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              status: event.isError ? "failed" : "succeeded",
              summary: summarizeToolResult(event.toolName, event.result, event.isError),
              resultPreview: preview(event.result),
              ...durationField(elapsed(startedAt))
            }
          }];
        }

        case "agent_start":
          return [{ event: "status", data: { phase: "agent", message: "Pi Agent 已启动" } }];
        case "agent_end":
        case "agent_settled":
          return [{ event: "status", data: { phase: "agent", message: "Pi Agent 已完成推理" } }];
        // turn 的边界不给前端加事件类型（SSE 契约不变），但必须显式处理、
        // 不落 default：观测侧靠它切成 pi.turn.N，落 default 就等于把它丢了。
        case "turn_start":
        case "turn_end":
          return [];
        default:
          return [];
      }
    }
  };
}

/** 配不出时长时整个字段不出现，而不是给 0——0 会被读成「瞬间完成」。 */
function durationField(durationMs: number | undefined): { durationMs: number } | Record<string, never> {
  return durationMs === undefined ? {} : { durationMs };
}

/** 助手正文全文（按 content block 拼接 text 部分）。 */
export function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: string; text?: string } => Boolean(item && typeof item === "object"))
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("");
}

/** 一次模型调用产出的 toolCall 列表；args 已由 parsePiJsonLine 脱敏。 */
export function extractToolCalls(content: unknown): Array<{ id: unknown; name: unknown; arguments: unknown }> {
  if (!Array.isArray(content)) return [];
  return content
    .filter((item): item is Record<string, any> => Boolean(item && typeof item === "object" && item.type === "toolCall"))
    .map((item) => ({ id: item.id, name: item.name, arguments: item.arguments ?? {} }));
}

function fileName(value: unknown): string {
  const path = typeof value === "string" ? value : "";
  const name = path.split("/").filter(Boolean).pop() ?? path;
  return name || "文件";
}

/** 把工具调用翻译成可读的一行，供前端灰色过程区展示。 */
export function summarizeToolCall(toolName: string, args: any): string {
  const value = args ?? {};
  switch (toolName) {
    case "read":
      return `读取 ${fileName(value.path)}`;
    case "xhs_search_notes":
      return `搜索「${value.keyword ?? ""}」`;
    case "xhs_get_note_detail":
      return `打开笔记 ${String(value.noteId ?? "").slice(0, 8)}…`;
    case "xhs_source_status":
      return "检查数据源状态";
    default:
      return toolName;
  }
}

/**
 * 工具主动拒绝时的说明（工具层闸门与空结果）。
 *
 * 这些不是故障——未知 noteId、预算用尽、没有搜索结果都是预期内的结果，
 * 前端要显示成一句人话，而不是「调用失败」。
 */
const REFUSAL_LABELS: Record<string, string> = {
  "not-configured": "数据源未配置",
  "empty-result": "没有结果",
  "collection-failed": "上游没采集到内容",
  "budget-exhausted": "已到本轮取数上限",
  "unknown-note": "笔记不在本轮搜索结果里",
  "quota-exhausted": "上游配额用尽",
  "auth-failed": "上游凭据失效",
  "bad-argument": "参数不完整",
  // 视频详情成功、只是没拿到字幕。三个都是预期内结果，不是故障。
  "no-voice": "视频没有人声",
  "no-transcript": "视频没有字幕",
  "transcript-failed": "字幕没取到"
};

/** 把工具结果压缩成"看到了什么"：条数、标题、大小，或失败原因。 */
export function summarizeToolResult(toolName: string, result: unknown, isError?: boolean): string {
  const text = toolText(result);
  if (isError) return failureReason(text);

  const payload = parseJson(text);
  if (typeof payload?.reason === "string") {
    return REFUSAL_LABELS[payload.reason] ?? payload.reason;
  }

  if (toolName === "xhs_search_notes") {
    return Array.isArray(payload?.notes) ? `返回 ${payload.notes.length} 条笔记` : size(text);
  }
  if (toolName === "xhs_get_note_detail") {
    const note = payload?.note;
    const title = typeof note?.title === "string" ? note.title : "";
    return title ? `${title.slice(0, 24)}${title.length > 24 ? "…" : ""}` : size(text);
  }
  if (toolName === "xhs_source_status") {
    const calls = payload?.calls ?? {};
    const limits = payload?.limits ?? {};
    const label = payload?.mode === "api" ? "api" : "未启用";
    return `${label} · search ${calls.search ?? 0}/${limits.searchPages ?? "?"} · detail ${calls.detail ?? 0}/${limits.detailLimit ?? "?"}`;
  }
  if (toolName === "read") {
    return size(text);
  }
  return size(text);
}

function failureReason(text: string): string {
  if (/aborted due to timeout|timed out/i.test(text)) return "请求超时";
  if (/context deadline exceeded/i.test(text)) return "服务端超时";
  if (/配额|余额|限额|额度|限流/.test(text)) return "上游配额用尽";
  if (/凭据|权限不足|无权/.test(text)) return "上游凭据失效";
  if (/笔记不可访问|无法浏览/.test(text)) return "笔记不可访问";
  return text.replace(/\s+/g, " ").slice(0, 80) || "调用失败";
}

function size(text: string): string {
  if (!text) return "";
  return text.length >= 1024 ? `${(text.length / 1024).toFixed(1)} KB` : `${text.length} 字`;
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toolText(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : ""))
      .join("");
  }
  return typeof result === "string" ? result : "";
}

function usageData(usage: any): Record<string, unknown> {
  if (!usage || typeof usage !== "object") return {};
  const output: Record<string, unknown> = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens", "cost"]) {
    if (usage[key] !== undefined) output[key] = usage[key];
  }
  return output;
}

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length > 2400 ? `${text.slice(0, 2400)}…` : text;
}

// read 工具没有任何路径限制，模型理论上能读到 .env；把环境里的密钥值也纳入脱敏，
// 避免密钥经由工具结果、文本增量或最终答案流向客户端。
const SECRET_ENV_KEY = /(API_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i;

export function buildSecretPattern(env: Record<string, string | undefined> = process.env): RegExp | null {
  const secrets = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !SECRET_ENV_KEY.test(key)) continue;
    secrets.add(value);
  }
  if (secrets.size === 0) return null;
  const alternation = [...secrets]
    .sort((left, right) => right.length - left.length)
    .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(alternation, "g");
}

let cachedSecretPattern: RegExp | null | undefined;

function secretPattern(): RegExp | null {
  if (cachedSecretPattern === undefined) cachedSecretPattern = buildSecretPattern();
  return cachedSecretPattern;
}

export function redactSensitive<T>(value: T): T {
  if (typeof value === "string") {
    const redacted = value
      .replace(/([?&]xsec_token=)[^&\s"']+/gi, "$1[redacted]")
      .replace(/((?:xsec_token|xsecToken|access_token|authorization|cookie)\s*=\s*)([^&\s"']+)/gi, "$1[redacted]")
      .replace(/((?:\\?"?)(?:xsec_token|xsecToken|access_token|authorization|cookie)(?:\\?"?)\s*:\s*\\?"?)([^"\\,}]+)(\\?"?)/gi, "$1[redacted]$3")
      .replace(/((?:xsec_token|xsecToken|access_token|authorization|cookie)\s*:\s*)([^\s,}]+)/gi, "$1[redacted]")
      .replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]");
    const secrets = secretPattern();
    return (secrets ? redacted.replace(secrets, "[redacted]") : redacted) as T;
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item)) as T;
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase();
      const sensitive = normalizedKey === "xsectoken"
        || normalizedKey === "xsec_token"
        || normalizedKey === "access_token"
        || normalizedKey === "cookie"
        || normalizedKey === "cookies"
        || normalizedKey === "authorization"
        || normalizedKey.endsWith("authorization");
      output[key] = sensitive
        ? "[redacted]"
        : redactSensitive(item);
    }
    return output as T;
  }
  return value;
}
