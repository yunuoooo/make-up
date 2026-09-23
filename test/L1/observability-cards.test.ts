import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildProductCards } from "../../lib/commerce/cards.ts";
import { createTaobaoClient } from "../../lib/commerce/taobao.ts";
import { productKey } from "../../lib/commerce/product-block.ts";
import { createCardsObserver } from "../../lib/observability/cards.ts";
import type { Observation, ObservationType, TraceFields, TurnTrace } from "../../lib/observability/types.ts";
import type { ProductRef } from "../../lib/commerce/types.ts";

/**
 * 淘宝卡片阶段的观测接缝：`buildProductCards` 贴 tag、observer 按 tag 查归属。
 *
 * 这一段一旦错位，观测不会报错，只会静默把 `taobao.search` / `taobao.detail` 挂到错误的
 * 父节点上——所以用一个记录型 trace 直接断言树形，而不是只看有没有记录。
 */

type Record_ = { name: string; created: TraceFields; updates: TraceFields[]; parent: Record_ | null; children: Record_[] };

function recordingTrace() {
  const flat: Record_[] = [];
  const wrap = (record: Record_): Observation => ({
    id: `obs_${flat.indexOf(record)}`,
    update(fields) {
      record.updates.push(fields);
    },
    end() {},
    startObservation(name, fields, type: ObservationType) {
      const child: Record_ = { name, created: fields, updates: [], parent: record, children: [] };
      flat.push(child);
      record.children.push(child);
      return wrap(child);
    }
  });
  const rootRecord: Record_ = { name: "looktrace.chat.turn", created: {}, updates: [], parent: null, children: [] };
  flat.push(rootRecord);
  const trace: TurnTrace = { ...wrap(rootRecord), runContext: { traceId: "trace_cards" } };
  const find = (name: string) => flat.find((item) => item.name === name);
  return { trace, flat, find };
}

/** 单次上游调用的观测：起点必须按实测时长回填，否则 waterfall 里永远是 0ms。 */
test("taobao.search / taobao.detail 的起点按实测时长回填", () => {
  const sink = recordingTrace();
  const observer = createCardsObserver(sink.trace, 1);
  observer.batchStart();
  observer.onCardStart("k", "橘朵|单色腮红");

  const before = Date.now();
  observer.onCall({ endpoint: "search", durationMs: 5200, ok: true, code: 0, keyword: "橘朵 单色腮红", tag: "k" });
  const after = Date.now();

  const search = sink.find("taobao.search");
  const start = search?.created.startTime as Date;
  assert.ok(start, "必须带 startTime，否则这条 span 的宽度是 0");
  // 起点 = 收到回调的时刻 - 实测时长，落在 [before-5200, after-5200] 之间。
  assert.ok(start.getTime() >= before - 5200 && start.getTime() <= after - 5200,
    `起点应回填 5200ms，实际 ${start.getTime() - (before - 5200)}ms 偏差`);
  assert.equal(search?.created.metadata?.durationMs, 5200);
  assert.equal(search?.created.level, "DEFAULT");
  assert.equal(sink.find("taobao.card 橘朵|单色腮红")?.created.startTime, undefined, "卡片 span 是真开真关，不该带 startTime");
});

test("认不出归属时 startTime 照样回填", () => {
  const sink = recordingTrace();
  const observer = createCardsObserver(sink.trace, 1);
  observer.batchStart();
  const before = Date.now();
  observer.onCall({ endpoint: "detail", durationMs: 30_000, ok: false, code: 303 });
  const detail = sink.find("taobao.detail");
  assert.ok((detail?.created.startTime as Date).getTime() <= before - 30_000 + 50);
  assert.equal(detail?.created.level, "ERROR");
});

const ref: ProductRef = { category: "腮红", brand: "橘朵", name: "单色腮红", shade: "35", section: "necessary" };
const missing: ProductRef = { category: "口红", brand: "断货", name: "不存在", section: "optional" };

const env = {
  TAOBAO_API_BASE_URL: "https://api.justoneapi.com",
  TAOBAO_API_TOKEN: "test-token-1234",
  TAOBAO_API_TIMEOUT_SECONDS: "5",
  TAOBAO_CARDS_ENABLED: "true"
};

function stubFetch(search: unknown, detail: unknown) {
  return (async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const url = new URL(raw);
    const isSearch = url.pathname.includes("search-item-list");
    // 断货的那件搜不到：用它覆盖「只有搜索、没有详情」的失败分支。
    const body = isSearch
      ? (url.searchParams.get("keyword")?.startsWith("断货") ? { code: 0, data: { itemsArray: [] } } : search)
      : detail;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
}

function cardOf(label: string) {
  return `taobao.card ${label}`;
}

test("把上游调用挂到发起它的那张卡片之下，而不是整批之下", async () => {
  const search = JSON.parse(await readFile("test/L1/fixtures/taobao-search-v2.json", "utf8"));
  // 详情回一个空信封 → getItemDetail 返回 null → 卡片落到搜索回退。
  // 这正是从前那条隐性失败（详情没取到但卡片还是出了），metadata.detailLevel 就是给它的。
  const emptyDetail = { code: 0, message: null, data: {} };

  for (const [concurrency, label] of [[1, "串行"], [2, "并发"]] as const) {
    const sink = recordingTrace();
    const observer = createCardsObserver(sink.trace, 2);
    const client = createTaobaoClient({ fetchImpl: stubFetch(search, emptyDetail), env, onCall: (info) => observer.onCall(info) });

    observer.batchStart();
    const outcome = await buildProductCards([ref, missing], {
      client,
      concurrency,
      onCardStart: (item) => observer.onCardStart(productKey(item), `${item.brand}|${item.name}`),
      onCardFinish: (run) => observer.onCardFinish(productKey(run.ref), {
        ok: run.ok,
        cacheHit: run.cacheHit,
        ...(run.detailLevel ? { detailLevel: run.detailLevel } : {}),
        ...(run.reason ? { reason: run.reason } : {})
      })
    });
    observer.batchEnd(outcome.status, outcome.cards.length, outcome.failed);

    const batch = sink.find("taobao.cards");
    assert.ok(batch, `[${label}] 整批要有一条 chain`);
    const mine = sink.find(cardOf("橘朵|单色腮红"));
    const theirs = sink.find(cardOf("断货|不存在"));
    assert.ok(mine, `[${label}] 每件各一条卡片 span`);
    assert.ok(theirs, `[${label}] 失败的件也要有一条卡片 span`);

    // 并发是 2 时两张卡片同时在跑：不能靠「最后一次 start」来归属。
    assert.deepEqual(
      mine.children.map((child) => child.name),
      ["taobao.search", "taobao.detail"],
      `[${label}] 搜索与详情必须是这张卡片的子节点`
    );
    assert.deepEqual(theirs.children.map((child) => child.name), ["taobao.search"], `[${label}] 没搜到的件只有搜索`);
    assert.equal(mine.parent, batch);
    assert.equal(theirs.parent, batch);

    // 卡片自己的结局：搜索回退要能统计，失败件带原因。
    assert.equal(mine.updates.at(-1)?.metadata?.detailLevel, "search");
    assert.equal(mine.updates.at(-1)?.level, "DEFAULT");
    assert.equal(theirs.updates.at(-1)?.level, "ERROR");
    assert.equal(theirs.updates.at(-1)?.statusMessage, "淘宝没有搜到可用商品");
  }
});

test("整批的 output 是可直接读的汇总", async () => {
  const sink = recordingTrace();
  const observer = createCardsObserver(sink.trace, 1);
  observer.batchStart();
  observer.onCardStart("k", "橘朵|单色腮红");
  observer.onCardFinish("k", { ok: false, cacheHit: false, reason: "超出本轮淘宝查询预算" });
  const failed = [{ brand: "橘朵", name: "单色腮红", reason: "超出本轮淘宝查询预算" }];
  observer.batchEnd("unavailable", 0, failed);

  const batch = sink.find("taobao.cards");
  assert.deepEqual(batch?.created.input, { expected: 1 });
  assert.deepEqual(batch?.updates.at(-1)?.output, { status: "unavailable", cardCount: 0, failed });
  assert.equal(batch?.updates.at(-1)?.metadata?.failedCount, 1);
});

test("没开观测时 observer 是惰性的", () => {
  const observer = createCardsObserver(null, 3);
  // 未配置 key 时 trace 是 null：这一串调用不能抛错，也不能产生任何副作用。
  assert.doesNotThrow(() => {
    observer.batchStart();
    observer.onCall({ endpoint: "search", durationMs: 12, ok: true, keyword: "橘朵" });
    observer.onCardStart("k", "橘朵|单色腮红");
    observer.onCardFinish("k", { ok: true, cacheHit: false, detailLevel: "detail" });
    observer.batchEnd("ok", 1, []);
  });
});

test("认不出归属的上游调用落到整批之下，不丢也不挂错", () => {
  const sink = recordingTrace();
  const observer = createCardsObserver(sink.trace, 1);
  observer.batchStart();
  // 没有 tag（或 tag 不认识）时不能编一个父节点，但也不能丢。
  observer.onCall({ endpoint: "search", durationMs: 5, ok: false, code: 303, requestId: "req_1" });
  observer.onCall({ endpoint: "detail", durationMs: 7, ok: true, itemId: "1", tag: "不存在的卡片" });

  const batch = sink.find("taobao.cards");
  assert.deepEqual(batch?.children.map((child) => child.name), ["taobao.search", "taobao.detail"]);
  assert.equal(batch?.children[0].created.level, "ERROR");
  assert.equal(batch?.children[0].created.output && (batch.children[0].created.output as any).code, 303);
});
