import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MCP_URL = process.env.XHS_MCP_URL ?? "http://127.0.0.1:18060/mcp";
const ROOT_DIR = process.cwd();
const START_SCRIPT = `${ROOT_DIR}/scripts/xhs-mcp-server`;

type JsonRpcResponse = {
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
};

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
};

const READ_ONLY_TOOLS = new Set(["check_login_status", "search_feeds", "get_feed_detail"]);

async function postMcp(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const token = process.env.XHS_MCP_AUTH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    signal: AbortSignal.timeout(Number(process.env.XHS_MCP_REQUEST_TIMEOUT_SECONDS ?? 45) * 1000),
  });
  const body = (await response.json()) as JsonRpcResponse;
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  if (body.error) throw new Error(body.error.message ?? "MCP request failed");
  return body.result;
}

async function ensureServer(): Promise<void> {
  try {
    const health = await fetch(MCP_URL.replace(/\/mcp$/, "/health"), {
      signal: AbortSignal.timeout(1000),
    });
    if (health.ok) return;
  } catch {
    // Start the local service below when the health check is unavailable.
  }

  await access(START_SCRIPT);
  const child = spawn(START_SCRIPT, [], {
    cwd: ROOT_DIR,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const health = await fetch(MCP_URL.replace(/\/mcp$/, "/health"), {
        signal: AbortSignal.timeout(500),
      });
      if (health.ok) return;
    } catch {
      // Keep polling while the browser-backed server starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${MCP_URL}`);
}

function toolName(name: string): string {
  return `xhs_${name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

function toolResultText(result: any): string {
  if (Array.isArray(result?.content)) {
    return result.content
      .map((block: any) => (block?.type === "text" ? block.text : JSON.stringify(block)))
      .join("\n");
  }
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

// 有的笔记（实测同一篇 7 次尝试全部卡死）永远读不出来。记住它们，
// 让模型立刻换下一篇，而不是每次再烧一个完整的超时窗口。
const unreadableFeeds = new Map<string, string>();

/**
 * feed_id → noteCard.type，从 search_feeds 的返回里记下来。
 *
 * 上游 v2.5.0 的 `get_feed_detail` 打开笔记页后会等「DOM 连续静止」
 * （`go-rod.(*Page).MustWaitDOMStable`，见 `xiaohongshu/feed_detail.go:112`）。
 * 视频笔记的播放器自动播放、每秒改动 DOM 8–14 次，这个条件**永不成立**，
 * 只能等满 60 秒的 context deadline 才失败（实测视频 0/7 成功、图文 7/7）。
 *
 * 约束放在**工具层**而不是技能里：技能是行为引导，模型可以忽略；放在这里
 * 则是在发出请求之前就挡掉，一次上游调用都不发，模型也绕不过去。
 */
const noteKinds = new Map<string, string>();

/** 工具返回里 details 的形状；跳过类会多带 skipped 与 reason。 */
type ToolDetails = { upstreamTool: string; skipped?: boolean; reason?: string };

/** 从 search_feeds 的返回里解析出每条笔记的 id 与类型。 */
function rememberNoteKinds(result: unknown): void {
  try {
    const parsed = JSON.parse(toolResultText(result));
    for (const feed of Array.isArray(parsed?.feeds) ? parsed.feeds : []) {
      const id = typeof feed?.id === "string" ? feed.id : "";
      const kind = typeof feed?.noteCard?.type === "string" ? feed.noteCard.type : "";
      if (id && kind) noteKinds.set(id, kind);
    }
  } catch {
    // 解析不出来就不记：类型未知时按原样放行，不因为解析失败而误拦。
  }
}

function isTimeout(error: unknown): boolean {
  const value = error as { name?: string; message?: string } | null;
  return value?.name === "TimeoutError" || /aborted due to timeout|timed out/i.test(value?.message ?? "");
}

export default async function xiaohongshuMcpExtension(pi: ExtensionAPI) {
  let status = `connected: ${MCP_URL}`;
  // The upstream Chromium driver is stateful and times out when two page actions overlap.
  let toolQueue = Promise.resolve();

  async function executeSerially<T>(operation: () => Promise<T>): Promise<T> {
    const previous = toolQueue;
    let release: () => void = () => {};
    toolQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  try {
    await ensureServer();
    const listed = (await postMcp("tools/list")) as { tools?: McpTool[] };
    for (const upstreamTool of listed.tools ?? []) {
      if (!READ_ONLY_TOOLS.has(upstreamTool.name)) continue;
      const name = toolName(upstreamTool.name);
      pi.registerTool({
        name,
        label: `XHS ${upstreamTool.name}`,
        description: upstreamTool.name === "get_feed_detail"
          ? `${upstreamTool.description ?? ""}\n\n本地约束：只对搜索结果里 noteCard.type 为 "normal" 的图文笔记调用。`
            + `视频笔记会被本地直接拒绝（上游读取视频笔记必卡满 60 秒才超时），不要尝试。`
          : upstreamTool.description ?? `Call Xiaohongshu MCP tool ${upstreamTool.name}.`,
        parameters: (upstreamTool.inputSchema ?? Type.Object({})) as any,
        async execute(_toolCallId, params) {
          const args = (params ?? {}) as Record<string, unknown>;
          const feedId = typeof args.feed_id === "string" ? args.feed_id : "";
          // 跳过类返回会多带 skipped/reason：把 details 标成同一个类型，
          // 否则各分支的推断结果对不上。
          const details: ToolDetails = { upstreamTool: upstreamTool.name };
          // 视频笔记在这里就挡掉，不发上游请求——详见 noteKinds 的说明。
          if (upstreamTool.name === "get_feed_detail" && feedId && noteKinds.get(feedId) === "video") {
            return {
              content: [{
                type: "text",
                text: `笔记 ${feedId} 是视频笔记，已跳过。`
                  + "本地上游读取视频笔记会卡满 60 秒才超时（播放器持续改动 DOM，页面等待条件永不成立），"
                  + "请改用搜索结果里 noteCard.type 为 normal 的图文笔记，不要在视频笔记上继续尝试。"
              }],
              details: { ...details, skipped: true, reason: "video-note" },
            };
          }
          if (upstreamTool.name === "get_feed_detail" && feedId && unreadableFeeds.has(feedId)) {
            return {
              content: [{
                type: "text",
                text: `笔记 ${feedId} 本次运行中读取失败过（${unreadableFeeds.get(feedId)}），已跳过。`
                  + "请改用搜索结果里的其他笔记，不要重试这一篇。"
              }],
              details: { ...details, skipped: true },
            };
          }

          let result: any;
          try {
            result = await executeSerially(() => postMcp("tools/call", {
              name: upstreamTool.name,
              arguments: args
            }));
          } catch (error) {
            if (upstreamTool.name === "get_feed_detail" && feedId && isTimeout(error)) {
              unreadableFeeds.set(feedId, "读取超时");
            }
            throw error;
          }
          // 搜索是笔记类型的唯一来源，每次返回都刷新一遍缓存。
          if (upstreamTool.name === "search_feeds") rememberNoteKinds(result);
          return {
            content: [{ type: "text", text: toolResultText(result) }],
            details,
          };
        },
      });
    }
  } catch (error) {
    status = `unavailable: ${String(error)}`;
    pi.registerTool({
      name: "xhs_mcp_status",
      label: "XHS MCP Status",
      description: "Report why the local Xiaohongshu MCP server could not be loaded.",
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: "text", text: String(error) }],
          details: { endpoint: MCP_URL },
        };
      },
    });
  }
  pi.registerCommand("xhs-status", {
    description: "Show Xiaohongshu MCP connection status",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.notify(status, status.startsWith("connected") ? "info" : "warning");
    },
  });
}
