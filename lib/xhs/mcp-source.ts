import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

/**
 * 本地 `xiaohongshu-mcp` 的传输层：**迁移期的回退路径**，`XHS_SOURCE_MODE=mcp` 时使用。
 *
 * 取数正路是 Just One API（同目录的 justoneapi.ts）；这条链路在上游缺陷清账（spec
 * `09-24-xhs-api-integration.md` 第 10 节的 Phase D）时整体删除。它只做传输——
 * 工具名、闸门和给模型看的文案都在 `.pi/extensions/xhs-source.ts`。
 */

const DEFAULT_MCP_URL = "http://127.0.0.1:18060/mcp";
const START_SCRIPT = "scripts/xhs-mcp-server";

/** 只读白名单：写工具（发布、评论、点赞、收藏、删除 cookies）永远不进这条链路。 */
export const READ_ONLY_TOOLS = new Set(["check_login_status", "search_feeds", "get_feed_detail"]);

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
};

export type McpSource = {
  endpoint: string;
  /** 首次调用时确保服务已拉起（进程内只做一次），失败抛出可读错误。 */
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; raw: unknown }>;
};

export type McpSourceOptions = {
  /** 测试注入，默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
};

type JsonRpcResponse = {
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
};

/** 工具的 content 块拼成文本；非文本块原样 JSON，避免丢信息。 */
export function toolResultText(result: any): string {
  if (Array.isArray(result?.content)) {
    return result.content
      .map((block: any) => (block?.type === "text" ? block.text : JSON.stringify(block)))
      .join("\n");
  }
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

export function createMcpSource(options: McpSourceOptions = {}): McpSource {
  const env = process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const mcpUrl = env.XHS_MCP_URL ?? DEFAULT_MCP_URL;
  const rootDir = process.cwd();
  const timeoutMs = Number(env.XHS_MCP_REQUEST_TIMEOUT_SECONDS ?? 45) * 1000;

  // 上游的 Chromium 驱动是有状态的，两个页面操作重叠就会超时——串行执行，
  // 与 Just One API 那条无状态链路不同（那边不需要队列）。
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

  async function postMcp(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    };
    const token = env.XHS_MCP_AUTH_TOKEN;
    if (token) headers.authorization = `Bearer ${token}`;

    const response = await fetchImpl(mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = (await response.json()) as JsonRpcResponse;
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
    if (body.error) throw new Error(body.error.message ?? "MCP request failed");
    return body.result;
  }

  async function ensureServer(): Promise<void> {
    const healthUrl = mcpUrl.replace(/\/mcp$/, "/health");
    try {
      const health = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(1000) });
      if (health.ok) return;
    } catch {
      // 健康检查不可用就在下面拉起本地服务。
    }

    await access(`${rootDir}/${START_SCRIPT}`);
    const child = spawn(`${rootDir}/${START_SCRIPT}`, [], {
      cwd: rootDir,
      detached: true,
      stdio: "ignore",
      env: process.env
    });
    child.unref();

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const health = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(500) });
        if (health.ok) return;
      } catch {
        // 浏览器驱动的服务启动慢，继续轮询。
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for ${mcpUrl}`);
  }

  let ensured: Promise<void> | null = null;

  /** 拉起只做一次；失败不缓存，下一次调用还能重试（服务可能是慢启动）。 */
  function ensureOnce(): Promise<void> {
    if (!ensured) {
      ensured = ensureServer().catch((cause) => {
        ensured = null;
        throw cause;
      });
    }
    return ensured;
  }

  return {
    endpoint: mcpUrl,

    async callTool(name, args) {
      await ensureOnce();
      const result = await executeSerially(() => postMcp("tools/call", { name, arguments: args }));
      return { text: toolResultText(result), raw: result };
    }
  };
}
