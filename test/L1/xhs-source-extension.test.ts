import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import xhsSourceExtension from "../../.pi/extensions/xhs-source.ts";

/**
 * 工具层的不变量。取数只有一条链路（TikHub），所以这里只测这一条：
 *
 * - **三道闸门**都必须在**发出请求之前**拦住——未知 noteId、详情预算用尽、未配凭据。
 *   技能是行为引导，模型可以忽略；工具层是硬拦，模型绕不过去。
 * - **配额与采集侧失败**要整批停止或只停详情，别把已经计费的调用重试成两次。
 *
 * 迁移期的 mcp 回退分支（视频笔记拦截、未知 feed_id 放行、搜索里的 video 条目过滤）
 * 随 Phase D 一起删除，对应的用例也一并删了——那条链路在仓库里已经不存在。
 *
 * 全部用假的端点跑，不依赖真实的 TikHub 服务。
 */

type Reply = { status?: number; body?: unknown; text?: string };

/**
 * 兜住扩展的每一条出网路径：TikHub（JSON 信封）与**字幕 CDN**（`.srt` 纯文本，不走 TikHub）。
 * `calls` 只记 pathname——字幕的 path 以 `.srt` 结尾，足够和上游调用区分开。
 */
function stubFetch(handlers: { http?: (url: URL) => Reply }) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const url = new URL(raw);
    calls.push(`GET ${url.pathname}`);
    const upstream = url.hostname.endsWith("tikhub.io");
    const reply = handlers.http?.(url)
      ?? (upstream ? { body: { code: 200, data: { code: 0, success: true, msg: "成功", data: [] } } } : { text: "" });
    return new Response(reply.text ?? JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": upstream ? "application/json" : "text/plain" }
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

let cachedFixtures: { search: any; detail: any; video: any; srt: string } | null = null;

async function fixtures() {
  if (!cachedFixtures) {
    cachedFixtures = {
      search: JSON.parse(await readFile("test/L1/fixtures/xhs-tikhub-search.json", "utf8")),
      detail: JSON.parse(await readFile("test/L1/fixtures/xhs-tikhub-detail.json", "utf8")),
      video: JSON.parse(await readFile("test/L1/fixtures/xhs-tikhub-video-detail.json", "utf8")),
      srt: await readFile("test/L1/fixtures/xhs-subtitle-sample.srt", "utf8")
    };
  }
  return cachedFixtures;
}

/** 视频 fixture 与搜索 fixture 的第 4 条是同一篇笔记：先搜到、再打开，闸门才放行。 */
const VIDEO_NOTE_ID = "69d24918000000001a023887";

/** TikHub 的两层信封：外层 code 是 HTTP 语义（200 才算过），内层 code=0 / success=true 才是业务成功。 */
const envelope = (inner: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  code: 200,
  request_id: "req-test-0001",
  message_zh: "请求成功，本次请求将被计费。",
  data: { code: 0, success: true, msg: "成功", ...inner },
  ...extra
});

/**
 * 真实搜索 fixture 的 20 条里没有详情 fixture 那篇（两次搜索关键词不同），而 noteId 闸门要求
 * 详情只能打开**本轮搜索返回过**的笔记。所以这里给搜索结果补一条最小条目，让「先搜索再打开」
 * 这条链在测试里成立——补进去的字段名与真实形状一致（`items[].note`）。
 */
async function searchWithDetailNote(): Promise<any> {
  const { search } = await fixtures();
  const patchedItem = {
    model_type: "note",
    note: {
      id: "6a9a3b6a000000001103860e",
      title: "2026年6大主流爆款妆容之五：韩系氧气妆",
      type: "normal",
      user: { nickname: "知书达丽girl" },
      timestamp: 1788492650
    }
  };
  return {
    ...search,
    data: { ...search.data, data: { ...search.data.data, items: [...search.data.data.items, patchedItem] } }
  };
}

const API_ENV = {
  XHS_SOURCE_MODE: "api",
  XHS_API_TOKEN: "test-token-1234",
  XHS_API_BASE_URL: "https://api.tikhub.io",
  XHS_API_TIMEOUT_SECONDS: "5",
  XHS_API_SEARCH_PAGES: "2",
  XHS_API_DETAIL_LIMIT: "2",
  XHS_API_BUDGET_SECONDS: "60"
};

test("api：搜索与详情走受控形状，正文只从详情来", async () => {
  const { detail } = await fixtures();
  const search = await searchWithDetailNote();
  const stub = stubFetch({ http: (url) => url.pathname.includes("search_notes") ? { body: search } : { body: detail } });
  try {
    const tools = await start(API_ENV);
    assert.deepEqual([...tools.keys()].sort(), ["xhs_get_note_detail", "xhs_search_notes", "xhs_source_status"]);

    const searched = await tools.get("xhs_search_notes")!.execute("c1", { keyword: "通勤妆 教程" });
    const searchPayload = JSON.parse(searched.content[0].text);
    assert.equal(searchPayload.source, "tikhub");
    assert.equal(searchPayload.mode, "api");
    // 真实 fixture 4 条（3 图文 + 1 视频）+ 为「先搜后开」补的 1 条。
    assert.equal(searchPayload.notes.length, 5);
    // 检索不按类型过滤：图文与视频一起回来，`noteType` 带着，详情阶段靠它分流。
    assert.deepEqual(
      new Set(searchPayload.notes.map((note: any) => note.noteType)),
      new Set(["normal", "video"])
    );
    assert.equal(searchPayload.notes[0].noteId, "6ab3a964000000001301ac36", "真实条目：items[].note 平铺");
    assert.equal(searchPayload.notes[0].authorName, "yuixuu.");
    assert.ok(searchPayload.notes.some((note: any) => note.noteId === "6a9a3b6a000000001103860e"));
    assert.ok(
      !JSON.stringify(searchPayload).includes("完整分步教程"),
      "搜索结果不能带正文内容——只有截断预览"
    );
    assert.ok(!searched.content[0].text.includes("test-token-1234"));
    assert.equal(searched.details.mode, "api");
    assert.deepEqual(searched.details.calls, { search: 1, detail: 0 });

    const opened = await tools.get("xhs_get_note_detail")!.execute("c2", { noteId: "6a9a3b6a000000001103860e" });
    const detailPayload = JSON.parse(opened.content[0].text);
    assert.match(detailPayload.note.text, /完整分步教程/);
    assert.deepEqual(detailPayload.note.tags.slice(0, 2), ["珠海化妆师", "化妆教程"]);
    assert.equal(detailPayload.note.truncated, false);
    assert.ok(!opened.content[0].text.includes("xsec_token"), "xsec_token 不能进模型上下文");
    assert.deepEqual(opened.details.calls, { search: 1, detail: 1 });
  } finally {
    stub.restore();
  }
});

test("api：视频笔记按类型分流到视频端点，字幕随详情一起交给模型", async () => {
  const { detail, video, srt } = await fixtures();
  const search = await searchWithDetailNote();
  const stub = stubFetch({ http: (url) => {
    if (!url.hostname.endsWith("tikhub.io")) return { text: srt };
    if (url.pathname.includes("search_notes")) return { body: search };
    return { body: url.pathname.includes("video_note_detail") ? video : detail };
  } });
  try {
    const tools = await start(API_ENV);
    await tools.get("xhs_search_notes")!.execute("c1", { keyword: "妆容教程" });

    const opened = await tools.get("xhs_get_note_detail")!.execute("c2", { noteId: VIDEO_NOTE_ID });
    const payload = JSON.parse(opened.content[0].text);
    assert.equal(payload.note.noteType, "video");
    assert.equal(payload.note.durationSeconds, 167);
    // 字幕是这条链路的目的：带 [MM:SS] 的纯文本，模型可以直接引用时间戳。
    assert.match(payload.note.transcript.text, /^\[\d{2}:\d{2}\] \S/m);
    assert.equal(payload.note.transcript.lang, "source");
    assert.equal(opened.details.reason, undefined, "拿到字幕就不该有 reason");

    // 分流靠的是**调用前**就知道的类型：视频打到视频端点，一次图文端点都不许碰
    // （两个端点形状不同，试错每次都要计费）。
    assert.ok(stub.calls.some((call) => call.includes("get_video_note_detail")));
    assert.ok(!stub.calls.some((call) => call.includes("get_image_note_detail")));
    // 没有任何签名地址或原始响应进了模型上下文。
    assert.ok(!opened.content[0].text.includes(".srt"));
    assert.ok(!opened.content[0].text.includes("master_url"));
    assert.ok(!opened.content[0].text.includes("test-token-1234"));
  } finally {
    stub.restore();
  }
});

test("api：视频没有字幕时笔记照常返回，并带一句模型看得懂的话", async () => {
  const { detail, video, srt } = await fixtures();
  // 有人声、但没有字幕轨。
  const noSubs = structuredClone(video);
  delete noSubs.data.data[0].video_info_v2.media.video.subtitles;
  const search = await searchWithDetailNote();
  const stub = stubFetch({ http: (url) => {
    if (!url.hostname.endsWith("tikhub.io")) return { text: srt };
    if (url.pathname.includes("search_notes")) return { body: search };
    return { body: url.pathname.includes("video_note_detail") ? noSubs : detail };
  } });
  try {
    const tools = await start(API_ENV);
    await tools.get("xhs_search_notes")!.execute("c1", { keyword: "妆容教程" });

    const opened = await tools.get("xhs_get_note_detail")!.execute("c2", { noteId: VIDEO_NOTE_ID });
    const payload = JSON.parse(opened.content[0].text);
    // 详情本身是成功的：笔记照样给，只是口播内容缺了。静默省略会让模型以为「视频我看过了」。
    assert.equal(payload.note.noteId, VIDEO_NOTE_ID);
    assert.ok(payload.note.title, "笔记照样返回");
    assert.equal(payload.note.transcript, undefined);
    assert.equal(payload.reason, "no-transcript");
    assert.equal(opened.details.reason, "no-transcript", "前端靠 details.reason 显示人话");
    assert.match(payload.message, /没有字幕/);
    assert.match(payload.message, /不要编造/, "要明确禁止编画面细节");
    assert.equal(stub.calls.filter((call) => call.includes(".srt")).length, 0, "没有字幕轨就不发那次请求");
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
  const { detail } = await fixtures();
  const search = await searchWithDetailNote();
  const stub = stubFetch({ http: (url) => url.pathname.includes("search_notes") ? { body: search } : { body: detail } });
  try {
    // 上限 1 篇：读完第一条之后再读第二条必须被拦。
    const tools = await start({ ...API_ENV, XHS_API_DETAIL_LIMIT: "1" });
    await tools.get("xhs_search_notes")!.execute("c1", { keyword: "通勤妆" });
    await tools.get("xhs_get_note_detail")!.execute("c2", { noteId: "6a9a3b6a000000001103860e" });
    const before = stub.calls.length;

    const refused = await tools.get("xhs_get_note_detail")!.execute("c3", { noteId: "68c1f0a2000000001a02b7c1" });
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
  const stub = stubFetch({ http: () => ({ status: 429, body: { code: 429, message_zh: "超出套餐额度" } }) });
  try {
    const tools = await start(API_ENV);
    await assert.rejects(
      () => tools.get("xhs_search_notes")!.execute("c1", { keyword: "通勤妆" }),
      /额度|限流|配额/
    );
    assert.equal(stub.calls.length, 1);

    const refused = await tools.get("xhs_search_notes")!.execute("c2", { keyword: "换个关键词再试" });
    assert.equal(stub.calls.length, 1, "配额失败后不许再发请求");
    assert.equal(refused.details.reason, "quota-exhausted");
  } finally {
    stub.restore();
  }
});

test("api：上游形状读不出内容时，报错要带上上游字段名", async () => {
  // 2026-09-24 的线上 badcase：详情响应里没有 id，整篇被静默丢掉，对外只有「没有结果」。
  const noteId = "6a9a3b6a000000001103860e";
  const stub = stubFetch({ http: (url) => url.pathname.includes("search_notes")
    // 先让搜索真返回这条，否则会被 noteId 闸门拦掉，测不到详情那一段。
    ? { body: envelope({ data: { items: [{ id: noteId, note_card: { display_title: "韩系松弛氧气妆", type: "normal" } }] } }) }
    : { body: envelope({ data: [{ note_list: [{ some_renamed_field: "x" }] }] }) } });
  try {
    const tools = await start(API_ENV);
    await tools.get("xhs_search_notes")!.execute("c1", { keyword: "韩系氧气妆" });
    await assert.rejects(
      () => tools.get("xhs_get_note_detail")!.execute("c2", { noteId }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /some_renamed_field/, "字段名要进错误信息，下一次一眼能看出是上游改了字段");
        assert.match(message, /不是网络或权限问题/);
        return true;
      }
    );
  } finally {
    stub.restore();
  }
});

test("api：连续两篇空 data 后不再打开新笔记，但搜索照常", async () => {
  const stub = stubFetch({ http: (url) => url.pathname.includes("search_notes")
    ? { body: envelope({ data: { items: [
      { id: "n1", note_card: { display_title: "T1", type: "normal" } },
      { id: "n2", note_card: { display_title: "T2", type: "normal" } },
      { id: "n3", note_card: { display_title: "T3", type: "normal" } }
    ] } }) }
    : { body: envelope({ data: [] }) } });
  try {
    const tools = await start(API_ENV);
    await tools.get("xhs_search_notes")!.execute("c1", { keyword: "韩系氧气妆" });
    const detailCalls = () => stub.calls.filter((call) => call.includes("get_image_note_detail")).length;

    assert.equal((await tools.get("xhs_get_note_detail")!.execute("c2", { noteId: "n1" })).details.reason, "empty-result");
    assert.equal(detailCalls(), 1, "TikHub 响应即计费：空内容也不重试（重试等于再付一次）");
    assert.equal((await tools.get("xhs_get_note_detail")!.execute("c3", { noteId: "n2" })).details.reason, "collection-failed");

    const before = detailCalls();
    const third = await tools.get("xhs_get_note_detail")!.execute("c4", { noteId: "n3" });
    assert.equal(third.details.reason, "collection-failed");
    assert.equal(detailCalls(), before, "采集侧失败后不许再发详情请求——一轮 6 篇 × 20 秒就是白烧");
    assert.match(JSON.parse(third.content[0].text).message, /采集侧的问题/);

    // 搜索本身是好的，不该被一起掐死。
    await tools.get("xhs_search_notes")!.execute("c5", { keyword: "换个关键词" });
    assert.ok(stub.calls.filter((call) => call.includes("search_notes")).length >= 2);
  } finally {
    stub.restore();
  }
});
