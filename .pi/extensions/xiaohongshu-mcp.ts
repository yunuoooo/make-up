import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
        description: upstreamTool.description ?? `Call Xiaohongshu MCP tool ${upstreamTool.name}.`,
        parameters: (upstreamTool.inputSchema ?? Type.Object({})) as any,
        async execute(_toolCallId, params) {
          const args = (params ?? {}) as Record<string, unknown>;
          const feedId = typeof args.feed_id === "string" ? args.feed_id : "";
          if (upstreamTool.name === "get_feed_detail" && feedId && unreadableFeeds.has(feedId)) {
            return {
              content: [{
                type: "text",
                text: `笔记 ${feedId} 本次运行中读取失败过（${unreadableFeeds.get(feedId)}），已跳过。`
                  + "请改用搜索结果里的其他笔记，不要重试这一篇。"
              }],
              details: { upstreamTool: upstreamTool.name, skipped: true },
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
          return {
            content: [{ type: "text", text: toolResultText(result) }],
            details: { upstreamTool: upstreamTool.name },
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
    handler: async (_args: unknown, ctx: { ui: { notify: (message: string, level: string) => void } }) => {
      ctx.ui.notify(status, status.startsWith("connected") ? "info" : "warning");
    },
  });
}
