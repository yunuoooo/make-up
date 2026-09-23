import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  AUTH_ERROR_CODES,
  QUOTA_ERROR_CODES,
  XhsApiError,
  createXhsClient,
  xhsApiConfigured
} from "../../lib/xhs/justoneapi.ts";
import type { XhsCallInfo } from "../../lib/xhs/types.ts";

/**
 * 上游响应来自真实调用裁出的 fixture（见 SSOT 第 14.4 节的样例），
 * 字段名或取值链改了就先改 SSOT、再改 fixture、再改实现，靠这里回归。
 */

type Reply = { status?: number; body: unknown };

function stubFetch(handlers: { search?: (url: URL) => Reply; detail?: (url: URL) => Reply }) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push(raw);
    const url = new URL(raw);
    const isSearch = url.pathname.includes("search-note");
    const handler = isSearch ? handlers.search : handlers.detail;
    const reply = handler ? handler(url) : { body: { code: 0, message: null, data: {} } };
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const env = {
  XHS_API_BASE_URL: "https://api.justoneapi.com",
  XHS_API_TOKEN: "test-token-1234",
  XHS_API_TIMEOUT_SECONDS: "5"
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

test("搜索映射：跳过缺 id 的条目、heif 换 jpg、日期格式化、token 走 query", async () => {
  const search = (await fixtures()).search;
  const { fetchImpl, calls } = stubFetch({ search: () => ({ body: search }) });
  const client = createXhsClient({ fetchImpl, env: { ...env } });

  const page = await client.searchNotes("通勤妆 教程", { page: 2 });

  assert.equal(client.configured, true);
  assert.equal(page.notes.length, 2, "缺 id 的第三条要被跳过");
  assert.equal(page.hasMore, true);
  assert.equal(page.page, 2);

  const first = page.notes[0];
  assert.equal(first.noteId, "68c1f0a2000000001a02b7c1");
  assert.equal(first.title, "油皮通勤底妆｜低饱和灰粉眼妆思路");
  assert.equal(first.authorName, "薄荷不加冰");
  assert.equal(first.noteType, "normal");
  assert.equal(first.postedAt, "2026-09-20", "Unix 秒要换成展示用日期");
  assert.deepEqual(first.stats, { liked: 18234, comments: 412, collected: 9012, shared: 233 });
  assert.match(first.preview ?? "", /低饱和通勤妆/);
  // 搜索接口给的图全是 format/heif，浏览器渲染不了，必须换成 jpg（SSOT 第 7 节）。
  assert.match(first.cover ?? "", /format\/jpg/);
  assert.ok(!(first.cover ?? "").includes("heif"), "不能把 heif 地址交给前端");

  assert.equal(page.notes[1].noteType, "video", "视频笔记在 api 链路里是可读的，不做类型过滤");

  const url = new URL(calls[0]);
  assert.equal(url.pathname, "/api/xiaohongshu/search-note/v4");
  assert.equal(url.searchParams.get("token"), "test-token-1234");
  assert.equal(url.searchParams.get("keyword"), "通勤妆 教程");
  assert.equal(url.searchParams.get("page"), "2");
});

test("详情映射：正文全文与话题保留，http 升 https，分享链接与 xsec_token 一律不下发", async () => {
  const detail = (await fixtures()).detail;
  const { fetchImpl, calls } = stubFetch({ detail: () => ({ body: detail }) });
  const client = createXhsClient({ fetchImpl, env: { ...env } });

  const note = await client.getNoteDetail("68c1f0a2000000001a02b7c1");

  assert.ok(note);
  assert.equal(note.noteId, "68c1f0a2000000001a02b7c1");
  assert.equal(note.title, "油皮通勤底妆｜低饱和灰粉眼妆思路");
  assert.equal(note.authorName, "薄荷不加冰");
  assert.equal(note.postedAt, "2026-09-20");
  assert.equal(note.ipLocation, "上海");
  assert.equal(note.truncated, false);
  // 正文只信详情：换行和产品名都要在，不能被压成一行。
  assert.match(note.text, /兰蔻菁纯臻颜精华粉底液 BO-01/);
  assert.match(note.text, /\n底妆：/);
  assert.deepEqual(note.tags, ["低饱和妆容", "通勤妆"]);
  assert.equal(note.images.length, 2);
  assert.match(note.images[0], /format\/webp/);
  assert.ok(note.images[1].startsWith("https://"), "http 的图要升到 https");

  // 链接策略 A（spec 决策 4）：`/explore/{id}` 打不开，能点开的必带 xsec_token，
  // 所以整条详情结果里不许出现分享链接和 token。
  const serialized = JSON.stringify(note);
  assert.ok(!serialized.includes("xsec_token"), "xsec_token 不能进入结果");
  assert.ok(!serialized.includes("share_info"), "share_info 不下发");
  assert.equal(new URL(calls[0]).searchParams.get("noteId"), "68c1f0a2000000001a02b7c1");
});

test("业务码是唯一判据：HTTP 200 也可能是失败，配额码不重试", async () => {
  for (const code of QUOTA_ERROR_CODES) {
    const { fetchImpl, calls } = stubFetch({ search: () => ({ body: { code, message: "rate limited" } }) });
    const client = createXhsClient({ fetchImpl, env: { ...env } });
    await assert.rejects(
      () => client.searchNotes("x"),
      (error: unknown) => {
        assert.ok(error instanceof XhsApiError);
        assert.equal(error.code, code);
        assert.equal(error.quotaLimited, true, `code=${code} 要判成配额类`);
        return true;
      }
    );
    assert.equal(calls.length, 1, `code=${code} 不该重试——重试只会继续烧配额`);
  }

  for (const code of AUTH_ERROR_CODES) {
    const { fetchImpl } = stubFetch({ search: () => ({ body: { code, message: "no permission" } }) });
    const client = createXhsClient({ fetchImpl, env: { ...env } });
    await assert.rejects(() => client.searchNotes("x"), (error: unknown) => {
      assert.ok(error instanceof XhsApiError);
      assert.equal(error.authFailed, true);
      return true;
    });
  }
});

test("采集失败与上游 5xx 各重试一次", async () => {
  let attempt = 0;
  const { fetchImpl, calls } = stubFetch({
    search: () => {
      attempt += 1;
      return attempt === 1
        ? { body: { code: 301, message: "采集失败" } }
        : { body: { code: 0, data: { notes: [], has_more: false } } };
    }
  });
  const client = createXhsClient({ fetchImpl, env: { ...env } });
  const page = await client.searchNotes("x");
  assert.equal(calls.length, 2, "301 要重试一次");
  assert.deepEqual(page.notes, []);

  const http500 = stubFetch({
    search: () => ({ status: 500, body: { code: 500, message: "内部错误" } })
  });
  const failing = createXhsClient({ fetchImpl: http500.fetchImpl, env: { ...env } });
  await assert.rejects(() => failing.searchNotes("x"));
  assert.equal(http500.calls.length, 2, "上游 5xx 要重试一次");

  // 枚举里有、文档没给含义的码按未知失败处理：不重试，直接放弃该次调用。
  const unknown = stubFetch({ search: () => ({ body: { code: 404, message: "unknown" } }) });
  const unknownClient = createXhsClient({ fetchImpl: unknown.fetchImpl, env: { ...env } });
  await assert.rejects(() => unknownClient.searchNotes("x"));
  assert.equal(unknown.calls.length, 1);
});

test("没配 token 就不发任何请求，也不把「没配」当错误抛出去", async () => {
  const { fetchImpl, calls } = stubFetch({});
  const client = createXhsClient({ fetchImpl, env: { XHS_API_TOKEN: "" } });

  assert.equal(client.configured, false);
  assert.equal(xhsApiConfigured({ XHS_API_TOKEN: "" }), false);
  assert.equal(xhsApiConfigured({ XHS_API_TOKEN: "  " }), false);
  assert.equal(xhsApiConfigured({ XHS_API_TOKEN: "abc" }), true);

  const page = await client.searchNotes("通勤妆");
  assert.deepEqual(page.notes, []);
  assert.equal(await client.getNoteDetail("68c1f0a2000000001a02b7c1"), null);
  assert.equal(calls.length, 0, "未配置＝一次请求都不发");
});

test("错误信息与观测数据里没有 token，也没有完整 URL", async () => {
  const reported: XhsCallInfo[] = [];
  const { fetchImpl } = stubFetch({ search: () => ({ body: { code: 303, message: "quota exceeded" } }) });
  const client = createXhsClient({ fetchImpl, env: { ...env }, onCall: (info) => reported.push(info) });

  const error = await client.searchNotes("通勤妆").then(() => null, (cause: unknown) => cause as Error);
  assert.ok(error);
  assert.ok(!error.message.includes("test-token-1234"), "token 不能进错误信息");
  assert.ok(!error.message.includes("token="), "完整 URL 不能进错误信息");
  assert.match(error.message, /code=303/, "要留下业务码和对账用的信息");

  assert.equal(reported.length, 1);
  assert.deepEqual(
    { endpoint: reported[0].endpoint, ok: reported[0].ok, code: reported[0].code },
    { endpoint: "search", ok: false, code: 303 }
  );
  assert.ok(!JSON.stringify(reported[0]).includes("http"), "观测数据不带 URL");
  assert.equal(reported[0].keyword, "通勤妆");
});

test("上游没给信封（网络错误/超时）也算失败，且只重试一次", async () => {
  let attempt = 0;
  const fetchImpl = (async () => {
    attempt += 1;
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  }) as typeof fetch;
  const client = createXhsClient({ fetchImpl, env: { ...env } });

  await assert.rejects(() => client.getNoteDetail("68c1f0a2000000001a02b7c1"), (error: unknown) => {
    assert.ok(error instanceof XhsApiError);
    assert.equal(error.code, -1);
    return true;
  });
  assert.equal(attempt, 2);
});
