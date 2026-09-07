type CdpTarget = {
  id?: string;
  webSocketDebuggerUrl?: string;
};

type CdpMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

export type LocalBrowserSearchResult = {
  url: string;
  title: string;
  rawText: string;
  snippets: string[];
  noteLinks: string[];
  loginRequired: boolean;
};

const extractionScript = `(() => {
  const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const anchors = Array.from(document.querySelectorAll("a")).map((anchor) => ({
    text: normalize(anchor.innerText || anchor.textContent || ""),
    href: anchor.href
  }));
  const noteLinks = anchors
    .filter((item) => /xiaohongshu\\.com\\/(explore|search_result)/.test(item.href))
    .map((item) => item.href)
    .filter((href, index, list) => href && list.indexOf(href) === index)
    .slice(0, 20);
  const snippets = Array.from(document.querySelectorAll("section, article, a[href*='/explore/'], div[class*='note'], div[class*='card']"))
    .map((element) => normalize(element.innerText || element.textContent || ""))
    .filter((text, index, list) => text.length > 12 && text.length < 700 && list.indexOf(text) === index)
    .slice(0, 24);
  const rawText = normalize(document.body?.innerText || document.body?.textContent || "").slice(0, 8000);

  return {
    url: location.href,
    title: document.title || "小红书搜索结果",
    rawText,
    snippets,
    noteLinks,
    loginRequired: /登录|扫码|验证码/.test(rawText) && !/笔记|搜索|综合|用户/.test(rawText)
  };
})()`;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDebugUrl(): string {
  return (process.env.XHS_LOCAL_BROWSER_DEBUG_URL || "http://127.0.0.1:9222").replace(/\/$/, "");
}

async function createTarget(url: string): Promise<CdpTarget> {
  const endpoint = `${getDebugUrl()}/json/new?${encodeURIComponent(url)}`;
  let response = await fetch(endpoint, { method: "PUT" });

  if (!response.ok && response.status === 405) {
    response = await fetch(endpoint);
  }

  if (!response.ok) {
    throw new Error(`无法连接本机小红书浏览器：${response.status}`);
  }

  return await response.json() as CdpTarget;
}

async function closeTarget(targetId?: string): Promise<void> {
  if (!targetId) return;
  await fetch(`${getDebugUrl()}/json/close/${targetId}`).catch(() => null);
}

class CdpClient {
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();

  constructor(private readonly socket: WebSocket) {
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (!message.id) return;

      const waiter = this.pending.get(message.id);
      if (!waiter) return;

      this.pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(message.error.message || "Chrome DevTools 调用失败"));
      } else {
        waiter.resolve(message.result);
      }
    });
  }

  static async connect(webSocketUrl: string): Promise<CdpClient> {
    if (!globalThis.WebSocket) {
      throw new Error("本机小红书搜索需要 Node.js 提供 WebSocket 支持。");
    }

    const socket = new WebSocket(webSocketUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("无法连接 Chrome DevTools WebSocket。")), { once: true });
    });

    return new CdpClient(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(payload);
    });
  }

  close(): void {
    this.socket.close();
  }
}

function readEvaluationValue(result: unknown): LocalBrowserSearchResult {
  if (!result || typeof result !== "object") {
    throw new Error("本机浏览器没有返回可解析的搜索结果。");
  }

  const wrapped = result as { result?: { value?: unknown } };
  const value = wrapped.result?.value;
  if (!value || typeof value !== "object") {
    throw new Error("本机浏览器页面还没有可读取的搜索内容。");
  }

  const record = value as Record<string, unknown>;
  return {
    url: typeof record.url === "string" ? record.url : "",
    title: typeof record.title === "string" ? record.title : "小红书搜索结果",
    rawText: typeof record.rawText === "string" ? record.rawText : "",
    snippets: Array.isArray(record.snippets) ? record.snippets.filter((item): item is string => typeof item === "string") : [],
    noteLinks: Array.isArray(record.noteLinks) ? record.noteLinks.filter((item): item is string => typeof item === "string") : [],
    loginRequired: record.loginRequired === true
  };
}

export async function searchXhsWithLocalBrowser(query: string): Promise<LocalBrowserSearchResult> {
  const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}&source=web_search_result_notes`;
  const target = await createTarget(searchUrl);

  if (!target.webSocketDebuggerUrl) {
    throw new Error("本机小红书浏览器没有开放调试连接。");
  }

  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Page.navigate", { url: searchUrl });
    await wait(Number(process.env.XHS_LOCAL_BROWSER_WAIT_MS || 4500));
    const result = await client.send("Runtime.evaluate", {
      expression: extractionScript,
      returnByValue: true,
      awaitPromise: true
    });

    return readEvaluationValue(result);
  } finally {
    client.close();
    await closeTarget(target.id);
  }
}
