import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import xhsSourceExtension from "../../.pi/extensions/xhs-source.ts";

/**
 * 工具层的不变量。两条链路各测一遍：
 *
 * - **api（正路）**：三道闸门都必须在**发出请求之前**拦住——未知 noteId、详情预算用尽、未配凭据；
 *   配额类错误要整批停止。技能是行为引导，模型可以忽略；工具层是硬拦，模型绕不过去。
 * - **mcp（迁移期回退）**：老行为不能变——视频笔记拦在本地不发请求、未知 feed_id 照旧放行、
 *   读不出来的笔记不重复撞超时。唯一的变化是 `xsec_token` 由扩展内部补，不再经模型上下文。
 *
 * 全部用假的端点跑，不依赖真实的小红书服务或 Just One API。
 */

type Reply = { status?: number; body: unknown };

/** 同时兜住 MCP 的 JSON-RPC 与 Just One API 的 HTTP 两种上游。 */
function stubFetch(handlers: {
  mcp?: (method: string, params: any) => unknown;
  http?: (url: URL) => Reply;
}) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const url = new URL(raw);
    if (url.pathname.endsWith("/health")) return new Response("ok", { status: 200 });

    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as { method: string; params?: any };
      calls.push(body.method === "tools/call" ? `tools/call:${body.params?.name}` : body.method);
      const result = handlers.mcp?.(body.method, body.params) ?? {};
      return Response.json({ result });
    }

    calls.push(`GET ${url.pathname}`);
    const reply = handlers.http?.(url) ?? { body: { code: 0, data: {} } };
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** 只实现扩展真正用到的那部分 ExtensionAPI。 */
function fakePi() {
  const tools = new Map<string, { description?: string; execute: (id: string, params: unknown) => Promise<any> }>();
  return {
    tools,
    api: {
      registerTool: (definition: { name: string; description?: string; execute: any }) => {
        tools.set(definition.name, definition);
      },
      registerCommand: () => undefined
    } as any
  };
}

async function withEnv(values: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** 扩展在调用时读环境：模式与预算都由这里注入，状态随每次 extension() 重新开始。 */
async function start(values: Record<string, string>) {
  const pi = fakePi();
  await withEnv(values, async () => { await xhsSourceExtension(pi.api); });
  return pi.tools;
}

const mcpSearch = {
  feeds: [
    { id: "feed_normal_1", xsecToken: "tok-normal", noteCard: { type: "normal", displayTitle: "新手必学氧气妆！" } },
    { id: "feed_video_1", xsecToken: "tok-video", noteCard: { type: "video", displayTitle: "7mins全妆跟练" } },
    { id: "feed_normal_2", xsecToken: "tok-normal-2", noteCard: { type: "normal", displayTitle: "谁来懂今天的底妆" } }
  ]
};

let cachedFixtures: { search: any; detail: any } | null = null;

async function fixtures() {
  if (!cachedFixtures) {
    cachedFixtures = {
      search: JSON.parse(await readFile("test/L1/fixtures/xhs-search-v4.json", "utf8")),
      detail: JSON.parse(await readFile("test/L1/fixtures/xhs-detail-v6.json", "utf8"))
    };
  }
  return cachedFixtures;
}

const API_ENV = {
  XHS_SOURCE_MODE: "api",
  XHS_API_TOKEN: "test-token-1234",
  XHS_API_BASE_URL: "https://api.justoneapi.com",
  XHS_API_TIMEOUT_SECONDS: "5",
  XHS_API_SEARCH_PAGES: "2",
  XHS_API_DETAIL_LIMIT: "2",
  XHS_API_BUDGET_SECONDS: "60"
};

const MCP_ENV = {
  XHS_SOURCE_MODE: "mcp",
  XHS_MCP_URL: "http://127.0.0.1:18060/mcp"
};

test("api：搜索与详情走受控形状，正文只从详情来", async () => {
  const { search, detail } = await fixtures();
  const stub = stubFetch({ http: (url) => url.pathname.includes("search-note") ? { body: search } : { body: detail } });
  try {
    const tools = await start(API_ENV);
    assert.deepEqual([...tools.keys()].sort(), ["xhs_get_note_detail", "xhs_search_notes", "xhs_source_status"]);

    const searched = await tools.get("xhs_search_notes")!.execute("c1", { keyword: "通勤妆 教程" });
    const searchPayload = JSON.parse(searched.content[0].text);
    assert.equal(searchPayload.source, "justoneapi");
    assert.equal(searchPayload.mode, "api");
    assert.equal(searchPayload.notes.length, 2);
    assert.equal(searchPayload.notes[0].noteId, "68c1f0a2000000001a02b7c1");
    assert.ok(
      !JSON.stringify(searchPayload).includes("兰蔻"),
      "搜索结果不能带正文内容——只有约 60 字的截断预览"
    );
    assert.ok(!searched.content[0].text.includes("test-token-1234"));
    assert.equal(searched.details.mode, "api");
    assert.deepEqual(searched.details.calls, { search: 1, detail: 0 });

    const opened = await tools.get("xhs_get_note_detail")!.execute("c2", { noteId: "68c1f0a2000000001a02b7c1" });
    const detailPayload = JSON.parse(opened.content[0].text);
    assert.match(detailPayload.note.text, /兰蔻菁纯臻颜精华粉底液 BO-01/);
    assert.deepEqual(detailPayload.note.tags, ["低饱和妆容", "通勤妆"]);
    assert.equal(detailPayload.note.truncated, false);
    assert.ok(!opened.content[0].text.includes("xsec_token"), "xsec_token 不能进模型上下文");
    assert.deepEqual(opened.details.calls, { search: 1, detail: 1 });
  } finally {
    stub.restore();
  }
});

test("api：未知 noteId 直接拒绝，一次请求都不发", async () => {
  const { search } = await fixtures();
  const stub = stubFetch({ http: () => ({ body: search }) });
  try {
    const tools = await start(API_ENV);
    await tools.get("xhs_search_notes")!.execute("c1", { keyword: "通勤妆" });
    const before = stub.calls.length;

    const refused = await tools.get("xhs_get_note_detail")!.execute("c2", { noteId: "用户消息里抄来的 id" });
    assert.equal(stub.calls.length, before, "未知 noteId 不能变成一次计费调用");
    assert.equal(refused.details.reason, "unknown-note");
    assert.match(JSON.parse(refused.content[0].text).message, /先用 xhs_search_notes/);
  } finally {
    stub.restore();
  }
});

test("api：详情预算用尽后再要一篇就被拒，不发请求", async () => {
  const { search, detail } = await fixtures();
  const stub = stubFetch({ http: (url) => url.pathname.includes("search-note") ? { body: search } : { body: detail } });
  try {
    // 上限 1 篇：读完第一条之后再读第二条必须被拦。
    const tools = await start({ ...API_ENV, XHS_API_DETAIL_LIMIT: "1" });
    await tools.get("xhs_search_notes")!.execute("c1", { keyword: "通勤妆" });
    await tools.get("xhs_get_note_detail")!.execute("c2", { noteId: "68c1f0a2000000001a02b7c1" });
    const before = stub.calls.length;

    const refused = await tools.get("xhs_get_note_detail")!.execute("c3", { noteId: "68c1f0a2000000001a02b7c2" });
    assert.equal(stub.calls.length, before, "超预算不能发请求");
    assert.equal(refused.details.reason, "budget-exhausted");
    assert.match(JSON.parse(refused.content[0].text).message, /详情篇数上限（1 篇）/);
  } finally {
    stub.restore();
  }
});

test("api：没配 token 时三个工具都降级说明，不发请求", async () => {
  const stub = stubFetch({});
  try {
    const tools = await start({ ...API_ENV, XHS_API_TOKEN: "" });
    const searched = await tools.get("xhs_search_notes")!.execute("c1", { keyword: "通勤妆" });
    const opened = await tools.get("xhs_get_note_detail")!.execute("c2", { noteId: "68c1f0a2000000001a02b7c1" });

    assert.equal(stub.calls.length, 0);
    assert.equal(searched.details.reason, "not-configured");
    assert.equal(opened.details.reason, "not-configured");
    assert.match(JSON.parse(searched.content[0].text).message, /没有实时站内检索/);

    const status = JSON.parse((await tools.get("xhs_source_status")!.execute("c3", {})).content[0].text);
    assert.equal(status.configured, false);
  } finally {
    stub.restore();
  }
});

test("api：配额码出现即整批停止，后续调用不再发请求", async () => {
  const stub = stubFetch({ http: () => ({ body: { code: 303, message: "quota exceeded" } }) });
  try {
    const tools = await start(API_ENV);
    await assert.rejects(
      () => tools.get("xhs_search_notes")!.execute("c1", { keyword: "通勤妆" }),
      /配额或余额不足/
    );
    assert.equal(stub.calls.length, 1);

    const refused = await tools.get("xhs_search_notes")!.execute("c2", { keyword: "换个关键词再试" });
    assert.equal(stub.calls.length, 1, "配额失败后不许再发请求");
    assert.equal(refused.details.reason, "quota-exhausted");
  } finally {
    stub.restore();
  }
});

test("mcp：视频笔记拦在工具层且不发请求，xsec_token 由扩展内部补", async () => {
  const calls: Array<{ name: string; args: any }> = [];
  const stub = stubFetch({
    mcp: (_method, params) => {
      if (params?.name === "search_feeds") return { content: [{ type: "text", text: JSON.stringify(mcpSearch) }] };
      calls.push({ name: params?.name, args: params?.arguments });
      return { content: [{ type: "text", text: JSON.stringify({ data: { note: { title: "新手必学氧气妆！" } } }) }] };
    }
  });
  try {
    const tools = await start(MCP_ENV);
    const search = tools.get("xhs_search_notes")!;
    const detail = tools.get("xhs_get_note_detail")!;
    // 工具描述里要写明本地约束，模型不用先撞一次才知道。
    assert.match(String(detail.description), /normal/);
    assert.match(String(detail.description), /视频/);

    await search.execute("c1", { keyword: "韩系氧气妆" });
    assert.ok(stub.calls.includes("tools/call:search_feeds"));

    // 视频笔记：本地挡掉，返回可读说明，**不发上游请求**
    const video = await detail.execute("c2", { noteId: "feed_video_1" });
    assert.equal(calls.length, 0, "不该对视频笔记发出上游请求");
    assert.equal(video.details.reason, "video-note");
    assert.match(JSON.parse(video.content[0].text).message, /图文笔记/);

    // 图文笔记：照常放行，且 xsec_token 由扩展从搜索结果里补，模型只传 noteId。
    const normal = await detail.execute("c3", { noteId: "feed_normal_1" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.feed_id, "feed_normal_1");
    assert.equal(calls[0].args.xsec_token, "tok-normal");
    assert.match(normal.content[0].text, /新手必学氧气妆/);
  } finally {
    stub.restore();
  }
});

test("mcp：未知 feed_id 照旧放行（回退链路不引入新行为）", async () => {
  const calls: any[] = [];
  const stub = stubFetch({
    mcp: (_method, params) => {
      calls.push(params?.arguments);
      return { content: [{ type: "text", text: "{}" }] };
    }
  });
  try {
    const tools = await start(MCP_ENV);
    await tools.get("xhs_get_note_detail")!.execute("c1", { noteId: "feed_unknown" });
    assert.equal(calls.length, 1, "没有搜索记录的 id 在 mcp 模式仍然放行");
    assert.equal(calls[0].xsec_token, "", "拿不到 token 就传空，让上游决定");
  } finally {
    stub.restore();
  }
});

test("mcp：读超时的笔记会被记住，第二次不再撞同一个超时窗口", async () => {
  const original = globalThis.fetch;
  let detailCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (raw.endsWith("/health")) return new Response("ok", { status: 200 });
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.params?.name === "search_feeds") {
      return Response.json({ result: { content: [{ type: "text", text: JSON.stringify(mcpSearch) }] } });
    }
    detailCalls += 1;
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  }) as typeof fetch;
  try {
    const tools = await start(MCP_ENV);
    await tools.get("xhs_search_notes")!.execute("c1", { keyword: "韩系氧气妆" });

    await assert.rejects(() => tools.get("xhs_get_note_detail")!.execute("c2", { noteId: "feed_normal_2" }), /超时/);
    assert.equal(detailCalls, 1);

    const second = await tools.get("xhs_get_note_detail")!.execute("c3", { noteId: "feed_normal_2" });
    assert.equal(detailCalls, 1, "同一篇不再重试——重复读取只会重复消耗同一个超时窗口");
    assert.equal(second.details.reason, "unreadable-note");
    assert.match(JSON.parse(second.content[0].text).message, /其他笔记/);
  } finally {
    globalThis.fetch = original;
  }
});

test("mcp：搜索返回解析不出类型时不影响调用", async () => {
  const stub = stubFetch({
    mcp: (_method, params) => params?.name === "search_feeds"
      ? { content: [{ type: "text", text: "不是 JSON" }] }
      : { content: [{ type: "text", text: "{}" }] }
  });
  try {
    const tools = await start(MCP_ENV);
    const result = await tools.get("xhs_search_notes")!.execute("c1", { keyword: "x" });
    assert.match(result.content[0].text, /不是 JSON/, "原样透传，不能因为解析失败而报错");
  } finally {
    stub.restore();
  }
});
