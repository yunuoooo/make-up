import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  AUTH_STATUS_CODES,
  QUOTA_STATUS_CODES,
  SHAPE_DRIFT_CODE,
  XhsApiError,
  createXhsClient,
  xhsApiConfigured
} from "../../lib/xhs/tikhub.ts";
import type { XhsCallInfo } from "../../lib/xhs/types.ts";

/**
 * TikHub 适配器的回归。字段与形状以 SSOT 为准（docs/specs/09-24-tikhub-xhs-ssot.md）：
 * 详情那份 fixture 是**真实响应**裁出来的（含带 token 的分享链接，token 已换成假值）。
 */

type Reply = { status?: number; body: unknown };

function stubFetch(handlers: { search?: (url: URL) => Reply; detail?: (url: URL) => Reply }) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const url = new URL(raw);
    calls.push({ url: raw, headers: (init?.headers ?? {}) as Record<string, string> });
    const handler = url.pathname.includes("search_notes") ? handlers.search : handlers.detail;
    const reply = handler ? handler(url) : { body: { code: 200, data: { code: 0, success: true, msg: "成功", data: [] } } };
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const env = {
  XHS_API_BASE_URL: "https://api.tikhub.io",
  XHS_API_TOKEN: "test-token-1234",
  XHS_API_TIMEOUT_SECONDS: "5"
};

/** 外层信封（HTTP 语义）+ 内层业务信封（code=0 / success=true），与真实响应一致。 */
const envelope = (inner: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  code: 200,
  request_id: "req-test-0001",
  message: "Request successful. This request will incur a charge.",
  message_zh: "请求成功，本次请求将被计费。",
  router: "/api/v1/xiaohongshu/app_v2/test",
  data: { code: 0, success: true, msg: "成功", ...inner },
  ...extra
});

let cachedDetail: any = null;
async function detailFixture() {
  if (!cachedDetail) cachedDetail = JSON.parse(await readFile("test/L1/fixtures/xhs-tikhub-detail.json", "utf8"));
  return cachedDetail;
}

test("详情：真实响应的嵌套形状要解包，正文/话题/图片进内部类型", async () => {
  const body = await detailFixture();
  const { fetchImpl, calls } = stubFetch({ detail: () => ({ body }) });
  const note = await createXhsClient({ fetchImpl, env: { ...env } }).getNoteDetail("6a9a3b6a000000001103860e");

  assert.ok(note, "data.data[0].note_list[0] 是 V3 式嵌套，必须解包出来");
  assert.equal(note.noteId, "6a9a3b6a000000001103860e");
  assert.equal(note.title, "2026年6大主流爆款妆容之五：韩系氧气妆");
  assert.equal(note.authorName, "知书达丽girl");
  assert.equal(note.noteType, "normal");
  assert.match(note.postedAt ?? "", /^2026-09-\d{2}$/, "Unix 秒要换成展示用日期");
  assert.equal(note.ipLocation, "Guangdong");
  // 正文全文：换行、制表符和行内话题都要在（技能靠它读步骤）。
  assert.match(note.text, /完整分步教程/);
  assert.match(note.text, /\n\t\n风格核心：/);
  assert.match(note.text, /#韩式妆造\[话题\]/);
  assert.deepEqual(note.tags, ["珠海化妆师", "化妆教程", "化妆分享", "韩妆教程", "韩式妆容", "韩式妆造"]);
  assert.equal(note.truncated, false);
  assert.equal(note.images.length, 1);
  assert.match(note.images[0], /^https:\/\/sns-i11\.rednotecdn\.com\//);
  assert.deepEqual(note.stats, { liked: 1, comments: 0, collected: 1, shared: 0 });

  // 白名单：分享链接、小程序 path 里都带 xsec_token，一个都不许漏出去。
  const serialized = JSON.stringify(note);
  assert.ok(!serialized.includes("xsec_token") && !serialized.includes("TEST_TOKEN"), "xsec_token 不能进结果");
  assert.ok(!serialized.includes("share_info") && !serialized.includes("mini_program"), "页内分享字段不下发");
  assert.ok(!serialized.includes("debug_id"), "调试字段不下发");

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/v1/xiaohongshu/app_v2/get_image_note_detail");
  assert.equal(url.searchParams.get("note_id"), "6a9a3b6a000000001103860e");
  assert.equal(url.searchParams.get("token"), null, "token 不该出现在 URL 里");
  assert.equal(calls[0].headers.authorization, "Bearer test-token-1234", "鉴权在请求头");
});

test("详情：图片规范化——heif 换 jpg、http 升 https", async () => {
  const body = envelope({
    data: [{ note_list: [{ id: "n1", title: "T", desc: "正文", images_list: [
      { url_size_large: "http://sns-img-qc.xhscdn.com/a?imageView2/2/w/1440/format/heif/q/56" },
      { url: "https://sns-img-qc.xhscdn.com/b?imageView2/2/w/576/format/webp" }
    ] }] }]
  });
  const { fetchImpl } = stubFetch({ detail: () => ({ body }) });
  const note = await createXhsClient({ fetchImpl, env: { ...env } }).getNoteDetail("n1");

  assert.deepEqual(note?.images, [
    "https://sns-img-qc.xhscdn.com/a?imageView2/2/w/1440/format/jpg/q/56",
    "https://sns-img-qc.xhscdn.com/b?imageView2/2/w/576/format/webp"
  ]);
});

test("两层信封：外层 code 是 HTTP 语义，内层「服务异常」已计费且不重试", async () => {
  // 外层非 200 —— Just One 那边是 0 表示成功，这里换成了 HTTP 语义，最容易混的一处。
  const outer = stubFetch({ detail: () => ({ status: 500, body: { code: 500, message_zh: "服务器错误" } }) });
  const outerClient = createXhsClient({ fetchImpl: outer.fetchImpl, env: { ...env } });
  await assert.rejects(() => outerClient.getNoteDetail("n1"), (error: unknown) => {
    assert.ok(error instanceof XhsApiError);
    assert.equal(error.code, 500);
    return true;
  });
  assert.equal(outer.calls.length, 2, "外层 5xx 是「没拿到响应」，重试一次");

  // 内层「服务异常」：供应商明示这种响应**照样计费**，所以绝不能重试。
  const inner = stubFetch({
    detail: () => ({ body: envelope({ code: 1, success: false, msg: "服务异常", data: [] }) })
  });
  const innerClient = createXhsClient({ fetchImpl: inner.fetchImpl, env: { ...env } });
  await assert.rejects(() => innerClient.getNoteDetail("n1"), (error: unknown) => {
    assert.ok(error instanceof XhsApiError);
    assert.equal(error.billed, true, "要标出这次已经花过钱");
    assert.equal(error.retryable, false);
    assert.match(error.message, /服务异常/);
    assert.match(error.message, /已计费/);
    return true;
  });
  assert.equal(inner.calls.length, 1, "计费过的失败重试＝再付一次");
});

test("凭据与限流：401/429 整批停止，不重试", async () => {
  for (const code of AUTH_STATUS_CODES) {
    const stub = stubFetch({ search: () => ({ status: code, body: { code, message_zh: "unauthorized" } }) });
    const client = createXhsClient({ fetchImpl: stub.fetchImpl, env: { ...env } });
    await assert.rejects(() => client.searchNotes("x"), (error: unknown) => {
      assert.ok(error instanceof XhsApiError);
      assert.equal(error.authFailed, true);
      return true;
    });
    assert.equal(stub.calls.length, 1);
  }

  for (const code of QUOTA_STATUS_CODES) {
    const stub = stubFetch({ search: () => ({ status: code, body: { code, message_zh: "too many requests" } }) });
    const client = createXhsClient({ fetchImpl: stub.fetchImpl, env: { ...env } });
    await assert.rejects(() => client.searchNotes("x"), (error: unknown) => {
      assert.ok(error instanceof XhsApiError);
      assert.equal(error.quotaLimited, true);
      return true;
    });
    assert.equal(stub.calls.length, 1);
  }
});

test("搜索：真实响应的形状（items[].note）要映射出来，xsec_token 不许漏出", async () => {
  const body = JSON.parse(await readFile("test/L1/fixtures/xhs-tikhub-search.json", "utf8"));
  const { fetchImpl, calls } = stubFetch({ search: () => ({ body }) });
  const page = await createXhsClient({ fetchImpl, env: { ...env } }).searchNotes("韩系氧气妆 教程", { page: 1 });

  // 真实条目在 data.data.items[].note 里，笔记字段是平铺的。
  assert.equal(page.notes.length, 3);
  const first = page.notes[0];
  assert.equal(first.noteId, "6ab3a964000000001301ac36");
  assert.equal(first.title, "🤍清透韩系氧气感眼妆！保姆级教程");
  assert.equal(first.authorName, "yuixuu.");
  assert.equal(first.noteType, "normal");
  assert.match(first.postedAt ?? "", /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(first.stats, { liked: 23, comments: 0, collected: 8, shared: 0 });
  assert.match(first.preview ?? "", /详细步骤在P4/, "搜索给的是截断预览");
  assert.match(first.cover ?? "", /^https:\/\/sns-na-i11\.xhscdn\.com\//);
  assert.equal(page.hasMore, true, "next_page=2 > page=1");

  const serialized = JSON.stringify(page);
  assert.ok(!serialized.includes("xsec_token") && !serialized.includes("TEST_TOKEN"),
    "搜索条目里带 xsec_token，映射层必须只取白名单字段");
  assert.ok(!serialized.includes("widgets_context"), "页内状态字段不映射");

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/v1/xiaohongshu/app_v2/search_notes");
  // 中文枚举：这是与 Just One 的 NORMAL_NOTE 最容易搞混的一处（SSOT 第 2.1 节）。
  assert.equal(url.searchParams.get("note_type"), "普通笔记");
  assert.equal(url.searchParams.get("token"), null, "token 只走请求头");
  assert.equal(calls[0].headers.authorization, "Bearer test-token-1234");
});

test("搜索：条目里一条都读不出来时报出字段名（包装键写错曾静默返回 0 条）", async () => {
  const body = envelope({ data: { items: [{ mix_track_id: "x", model_type: "note", some_renamed_field: 1 }] } });
  const { fetchImpl } = stubFetch({ search: () => ({ body }) });
  await assert.rejects(
    () => createXhsClient({ fetchImpl, env: { ...env } }).searchNotes("韩系氧气妆"),
    (error: unknown) => {
      assert.ok(error instanceof XhsApiError);
      assert.equal(error.code, SHAPE_DRIFT_CODE);
      assert.match(error.message, /some_renamed_field/, "字段名要进错误信息");
      return true;
    }
  );

  // 真的 0 条（items 为空）是合法结果，不能报错。
  const empty = stubFetch({ search: () => ({ body: envelope({ data: { items: [] } }) }) });
  const page = await createXhsClient({ fetchImpl: empty.fetchImpl, env: { ...env } }).searchNotes("不存在的词");
  assert.deepEqual(page.notes, []);
});

test("搜索：其它包装形状仍要认（note_card / 平铺条目）——包装键已经换过一次", async () => {
  const body = envelope({
    data: {
      items: [
        { id: "n1", note_card: { display_title: "油皮通勤底妆", desc: "约 60 字预览…", type: "normal",
          user: { nickname: "薄荷不加冰" }, cover: { url_default: "https://sns-img-qc.xhscdn.com/c?format/heif" },
          interact_info: { liked_count: 1234, collected_count: 89 } } },
        { id: "v1", note_card: { display_title: "跟练视频", type: "video", user: { nickname: "早八" } } },
        { id: "n2", title: "平铺条目", type: "normal", user: { nickname: "扁平" }, timestamp: 1789869600 },
        { id: "n1", note_card: { display_title: "重复条目", type: "normal" } }
      ]
    }
  });
  const { fetchImpl } = stubFetch({ search: () => ({ body }) });
  const page = await createXhsClient({ fetchImpl, env: { ...env } }).searchNotes("韩系氧气妆", { page: 1 });

  assert.deepEqual(page.notes.map((note) => note.noteId), ["n1", "n2"], "视频与重复条目都要丢掉");
  assert.deepEqual(page.notes[0].stats, { liked: 1234, comments: 0, collected: 89, shared: 0 });
  assert.match(page.notes[0].cover ?? "", /format\/jpg/);
});

test("搜索：分页凭据取自首屏，第二页原样带回", async () => {
  const { fetchImpl, calls } = stubFetch({
    search: (url) => url.searchParams.get("page") === "1"
      ? { body: envelope({ data: { items: [{ id: "n1", note_card: { display_title: "T", type: "normal" } }] },
          search_id: "sid-1", search_session_id: "sess-1" }) }
      : { body: envelope({ data: { items: [{ id: "n2", note_card: { display_title: "T2", type: "normal" } }] } }) }
  });
  const client = createXhsClient({ fetchImpl, env: { ...env } });
  await client.searchNotes("通勤妆", { page: 1 });
  await client.searchNotes("通勤妆", { page: 2 });

  const second = new URL(calls[1].url);
  assert.equal(second.searchParams.get("search_id"), "sid-1", "有状态分页：第二页要带首屏的 search_id");
  assert.equal(second.searchParams.get("search_session_id"), "sess-1");
  assert.equal(new URL(calls[0].url).searchParams.get("search_id"), null, "首屏不带凭据");
});

test("详情：有数据但字段全不认识时报出上游字段名", async () => {
  const body = envelope({ data: [{ note_list: [{ some_renamed_field: "x" }] }] });
  const { fetchImpl } = stubFetch({ detail: () => ({ body }) });
  await assert.rejects(
    () => createXhsClient({ fetchImpl, env: { ...env } }).getNoteDetail("n1"),
    (error: unknown) => {
      assert.ok(error instanceof XhsApiError);
      assert.equal(error.code, SHAPE_DRIFT_CODE);
      assert.match(error.message, /some_renamed_field/);
      return true;
    }
  );
});

test("详情：响应缺 id 也要映射出来（Just One 那次 badcase 的教训）", async () => {
  const body = envelope({ data: [{ note_list: [{ title: "T", desc: "正文全文" }] }] });
  const { fetchImpl } = stubFetch({ detail: () => ({ body }) });
  const note = await createXhsClient({ fetchImpl, env: { ...env } }).getNoteDetail("fallback-id");
  assert.equal(note?.noteId, "fallback-id", "id 用请求参数兜底");
  assert.equal(note?.text, "正文全文");
});

test("没配 token 就不发任何请求", async () => {
  const { fetchImpl, calls } = stubFetch({});
  const client = createXhsClient({ fetchImpl, env: { XHS_API_TOKEN: "" } });

  assert.equal(client.configured, false);
  assert.equal(xhsApiConfigured({ XHS_API_TOKEN: "  " }), false);
  assert.deepEqual((await client.searchNotes("通勤妆")).notes, []);
  assert.equal(await client.getNoteDetail("n1"), null);
  assert.equal(calls.length, 0);
});

test("错误信息与观测数据里没有 token", async () => {
  const reported: XhsCallInfo[] = [];
  const { fetchImpl } = stubFetch({ search: () => ({ status: 429, body: { code: 429, message_zh: "超出额度" } }) });
  const client = createXhsClient({ fetchImpl, env: { ...env }, onCall: (info) => reported.push(info) });

  const error = await client.searchNotes("通勤妆").then(() => null, (cause: unknown) => cause as Error);
  assert.ok(error && !error.message.includes("test-token-1234"));
  assert.equal(reported.length, 1);
  assert.deepEqual({ endpoint: reported[0].endpoint, ok: reported[0].ok, code: reported[0].code },
    { endpoint: "search", ok: false, code: 429 });
  assert.ok(!JSON.stringify(reported[0]).includes("http"), "观测数据不带 URL");
});
