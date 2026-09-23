import test from "node:test";
import assert from "node:assert/strict";
import extension from "../../.pi/extensions/xiaohongshu-mcp.ts";

/**
 * 视频笔记在 `xhs_get_feed_detail` 这一层被挡掉，而且**不发上游请求**。
 *
 * 这条约束为什么放在工具层而不是技能里：技能是行为引导，模型可以忽略；上游 v2.5.0 的
 * `get_feed_detail` 打开笔记页后等「DOM 连续静止」（`feed_detail.go:112`），而视频播放器
 * 持续改动 DOM，这个条件永不成立，只能等满 60 秒才超时（实测视频 0/7、图文 7/7 成功）。
 * 挡在工具层意味着一次上游调用都不发。
 *
 * 这里用一个假的 MCP 端点把扩展跑起来，断言的是「拦没拦住」和「有没有发出请求」，
 * 不依赖真实的小红书服务。
 */

type Reply = { status?: number; body: unknown };

function stubMcp(handlers: {
  search?: (args: Record<string, unknown>) => Reply;
  detail?: (args: Record<string, unknown>) => Reply;
}) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/health")) return new Response("ok", { status: 200 });

    const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params?: any };
    calls.push(body.method === "tools/call" ? `tools/call:${body.params?.name}` : body.method);

    if (body.method === "tools/list") {
      return Response.json({
        result: {
          tools: [
            { name: "check_login_status", description: "检查登录", inputSchema: { type: "object" } },
            { name: "search_feeds", description: "搜索", inputSchema: { type: "object" } },
            { name: "get_feed_detail", description: "详情", inputSchema: { type: "object" } }
          ]
        }
      });
    }
    if (body.method === "tools/call") {
      const reply = body.params.name === "search_feeds"
        ? handlers.search?.(body.params.arguments)
        : handlers.detail?.(body.params.arguments);
      return Response.json({ result: reply?.body ?? { content: [{ type: "text", text: "{}" }] } });
    }
    return Response.json({ result: {} });
  }) as typeof fetch;
  process.on("exit", () => {
    globalThis.fetch = original;
  });
  return calls;
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

const searchResult = {
  content: [{
    type: "text",
    text: JSON.stringify({
      feeds: [
        { id: "feed_normal_1", xsecToken: "tok", noteCard: { type: "normal", displayTitle: "新手必学氧气妆！" } },
        { id: "feed_video_1", xsecToken: "tok", noteCard: { type: "video", displayTitle: "7mins全妆跟练" } },
        { id: "feed_normal_2", xsecToken: "tok", noteCard: { type: "normal", displayTitle: "谁来懂今天的底妆" } }
      ]
    })
  }]
};

const detailBody = { content: [{ type: "text", text: JSON.stringify({ data: { note: { title: "新手必学氧气妆！" } } }) }] };

test("视频笔记在工具层被挡掉，且不发上游请求", async () => {
  const calls = stubMcp({
    search: () => ({ body: searchResult }),
    detail: () => ({ body: detailBody })
  });
  const pi = fakePi();
  await extension(pi.api);

  const search = pi.tools.get("xhs_search_feeds");
  const detail = pi.tools.get("xhs_get_feed_detail");
  assert.ok(search && detail, "三个只读工具都要注册");
  // 工具描述里要写明本地约束，模型不用先撞一次才知道。
  assert.match(String(detail.description), /normal/);
  assert.match(String(detail.description), /视频/);

  await search.execute("call_1", { keyword: "韩系氧气妆" });
  assert.ok(calls.includes("tools/call:search_feeds"));

  // 视频笔记：本地挡掉，返回可读的说明，**不发上游请求**
  const before = calls.filter((c) => c === "tools/call:get_feed_detail").length;
  const video = await detail.execute("call_2", { feed_id: "feed_video_1", xsec_token: "tok" });
  assert.equal(calls.filter((c) => c === "tools/call:get_feed_detail").length, before, "不该对视频笔记发出上游请求");
  assert.equal(video.details?.reason, "video-note");
  assert.equal(video.details?.skipped, true);
  assert.match(video.content[0].text, /视频笔记/);
  assert.match(video.content[0].text, /normal/, "要告诉模型改用图文笔记");

  // 图文笔记：照常放行
  const normal = await detail.execute("call_3", { feed_id: "feed_normal_1", xsec_token: "tok" });
  assert.equal(calls.filter((c) => c === "tools/call:get_feed_detail").length, before + 1, "图文笔记要真的去读");
  assert.match(normal.content[0].text, /新手必学氧气妆/);
});

test("没见过的 feed_id 不误拦", async () => {
  const calls = stubMcp({ detail: () => ({ body: detailBody }) });
  const pi = fakePi();
  await extension(pi.api);

  // 类型未知（不是本次搜索返回的）→ 按原样放行，避免因为解析不了而误伤
  await pi.tools.get("xhs_get_feed_detail")!.execute("call_1", { feed_id: "feed_unknown", xsec_token: "tok" });
  assert.ok(calls.includes("tools/call:get_feed_detail"));
});

test("搜索返回解析不出类型时不影响调用", async () => {
  stubMcp({ search: () => ({ body: { content: [{ type: "text", text: "不是 JSON" }] } }) });
  const pi = fakePi();
  await extension(pi.api);

  const result = await pi.tools.get("xhs_search_feeds")!.execute("call_1", { keyword: "x" });
  assert.match(result.content[0].text, /不是 JSON/, "原样透传，不能因为解析失败而报错");
});
