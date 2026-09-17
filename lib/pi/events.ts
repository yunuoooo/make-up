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

export function createPiEventMapper(context: PiRunContext) {
  let callIndex = 0;
  let lastUsageKey = "";

  return {
    consume(event: PiEvent): AppSseEvent[] {
      switch (event.type) {
        case "message_start":
          if (event.message?.role !== "assistant") return [];
          callIndex += 1;
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
              usage: usageData(event.message.usage)
            }
          }];

        case "tool_execution_start":
          return [{
            event: "tool_started",
            data: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              summary: summarizeToolCall(event.toolName, event.args),
              args: redactSensitive(event.args ?? {})
            }
          }];

        case "tool_execution_end":
          return [{
            event: "tool_finished",
            data: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              status: event.isError ? "failed" : "succeeded",
              summary: summarizeToolResult(event.toolName, event.result, event.isError),
              resultPreview: preview(event.result)
            }
          }];

        case "agent_start":
          return [{ event: "status", data: { phase: "agent", message: "Pi Agent 已启动" } }];
        case "agent_end":
        case "agent_settled":
          return [{ event: "status", data: { phase: "agent", message: "Pi Agent 已完成推理" } }];
        default:
          return [];
      }
    }
  };
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
    case "xhs_search_feeds":
      return `搜索「${value.keyword ?? ""}」`;
    case "xhs_get_feed_detail":
      return `打开笔记 ${String(value.feed_id ?? "").slice(0, 8)}…`;
    case "xhs_check_login_status":
      return "检查登录状态";
    default:
      return toolName;
  }
}

/** 把工具结果压缩成"看到了什么"：条数、标题、大小，或失败原因。 */
export function summarizeToolResult(toolName: string, result: unknown, isError?: boolean): string {
  const text = toolText(result);
  if (isError) return failureReason(text);

  if (toolName === "xhs_search_feeds") {
    const feeds = parseJson(text)?.feeds;
    return Array.isArray(feeds) ? `返回 ${feeds.length} 条笔记` : size(text);
  }
  if (toolName === "xhs_get_feed_detail") {
    const note = parseJson(text)?.data?.note;
    const title = typeof note?.title === "string" ? note.title : "";
    return title ? `${title.slice(0, 24)}${title.length > 24 ? "…" : ""}` : size(text);
  }
  if (toolName === "xhs_check_login_status") {
    return text.includes("已登录") ? text.split("\n")[0].slice(0, 40) : failureReason(text);
  }
  if (toolName === "read") {
    return size(text);
  }
  return size(text);
}

function failureReason(text: string): string {
  if (/aborted due to timeout|timed out/i.test(text)) return "请求超时";
  if (/context deadline exceeded/i.test(text)) return "服务端超时";
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
