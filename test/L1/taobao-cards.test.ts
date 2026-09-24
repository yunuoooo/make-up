import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildProductCards,
  buildSearchKeyword,
  itemUrl,
  pickSearchItem,
  type ProductCardRun
} from "../../lib/commerce/cards.ts";
import {
  TaobaoApiError,
  createTaobaoClient,
  productCardsEnabled,
  type TaobaoCallInfo,
  type TaobaoClient
} from "../../lib/commerce/taobao.ts";
import { productKey } from "../../lib/commerce/product-block.ts";
import type { ProductCard, ProductRef, TaobaoItemDetail, TaobaoSearchItem } from "../../lib/commerce/types.ts";

/**
 * 上游响应来自真实调用裁出的 fixture（见 SSOT 第 9 节），字段名改了就靠这里回归。
 */

type Reply = { status?: number; body: unknown };

function stubFetch(handlers: { search?: (url: URL) => Reply; detail?: (url: URL) => Reply }) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push(raw);
    const url = new URL(raw);
    const isSearch = url.pathname.includes("search-item-list");
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
  TAOBAO_API_BASE_URL: "https://api.justoneapi.com",
  TAOBAO_API_TOKEN: "test-token-1234",
  TAOBAO_API_TIMEOUT_SECONDS: "5",
  // 总开关默认关，所以这里必须显式打开——这条也是「默认不发请求」的回归点。
  TAOBAO_CARDS_ENABLED: "true"
};

let cachedFixtures: { search: any; detail: any } | null = null;

async function fixtures() {
  if (!cachedFixtures) {
    cachedFixtures = {
      search: JSON.parse(await readFile("test/L1/fixtures/taobao-search-v2.json", "utf8")),
      detail: JSON.parse(await readFile("test/L1/fixtures/taobao-detail-v6.json", "utf8"))
    };
  }
  return cachedFixtures;
}

/** 搜索 fixture 里第一条非广告位商品，也就是选品规则会选中的那条。 */
const SEARCH_ITEM_ID = "1004620982324";
/**
 * 详情 fixture 的商品 id。**与搜索 fixture 不是同一件商品**：详情那份取自 V6 的
 * 官方公开示例（川川也的 T 恤），搜索那份是早先真调抓的橘朵腮红。两个端点各自回归
 * 自己的形状；跨端点的配对断言（卡片链接、标题）因此都按 fixture 取值，不写死 id。
 */
const DETAIL_ITEM_ID = "801330948681";

const ref: ProductRef = { category: "腮红", brand: "橘朵", name: "单色腮红", shade: "35", section: "necessary" };

test("搜索映射：去高亮标签、图片回退、跳过非商品卡片，token 走 query", async () => {
  const search = (await fixtures()).search;
  const { fetchImpl, calls } = stubFetch({ search: () => ({ body: search }) });
  const client = createTaobaoClient({ fetchImpl, env });

  const items = await client.searchItems("橘朵腮红", { page: 1 });

  const withId = search.data.itemsArray.filter((entry: any) => entry.item_id);
  assert.equal(items.length, withId.length, "空条目（非商品卡片）要被跳过");
  assert.ok(items.every((item) => item.numIid && item.title));
  assert.ok(items.every((item) => !item.title.includes("<span")), "标题里的高亮标签要去掉");
  assert.ok(items.every((item) => item.picUrl?.startsWith("https://")), "图片地址要能直接进 DOM");
  assert.equal(items[0].isP4p, true);

  const url = new URL(calls[0]);
  assert.equal(url.pathname, "/api/taobao/search-item-list/v2");
  assert.equal(url.searchParams.get("token"), "test-token-1234");
  assert.equal(url.searchParams.get("keyword"), "橘朵腮红");
  assert.equal(url.searchParams.get("page"), "1");
});

test("图片优先级：uprightImg 优先，http 与协议相对地址都补成 https", async () => {
  const body = {
    code: 0,
    message: null,
    data: {
      itemsArray: [
        { item_id: "1", title: "A", uprightImg: null, pic_path: "http://gw.alicdn.com/a.jpg", price: "9.9", nick: "店" },
        { item_id: "2", title: "B", uprightImg: "//img.alicdn.com/b.jpg", pic_path: "http://gw.alicdn.com/c.jpg" },
        { item_id: "3", title: "C", uprightImg: "", pic_path: "", price: "" }
      ]
    }
  };
  const { fetchImpl } = stubFetch({ search: () => ({ body }) });
  const items = await createTaobaoClient({ fetchImpl, env }).searchItems("x");

  assert.equal(items[0].picUrl, "https://gw.alicdn.com/a.jpg");
  assert.equal(items[1].picUrl, "https://img.alicdn.com/b.jpg");
  assert.equal(items[2].picUrl, undefined);
  assert.equal(items[2].price, undefined, "空价格按缺失处理，不要造一个 0");
});

test("详情映射：只回白名单字段，desc 与诊断字段不外泄", async () => {
  const { detail: detailBody } = await fixtures();
  const { fetchImpl, calls } = stubFetch({ detail: () => ({ body: detailBody }) });
  // 故意用一个和 fixture 不同的 itemId：这样下面断言的 numIid 只能来自响应体，
  // 而不是「映射没生效时拿请求参数兜底」的同一条值。
  const requested = "1";
  const detail = await createTaobaoClient({ fetchImpl, env }).getItemDetail(requested);

  assert.ok(detail);
  // V6 是嵌套结构、ID 在 item.itemId 里：这两条是换版本时最容易静默错的地方。
  assert.ok(detailBody.data.item, "V6 的字段都挂在 item / seller 下");
  assert.equal(typeof detailBody.data.item.itemId, "string", "V6 的 itemId 回字符串");
  assert.ok(detailBody.data.item.images.every((entry: unknown) => typeof entry === "string"), "V6 的 images 是裸地址数组");
  assert.equal(detail.numIid, DETAIL_ITEM_ID, "响应里的 ID 要盖过请求参数");
  assert.ok(detail.images.length >= 1);
  assert.ok(detail.images.every((url) => url.startsWith("https://")));
  assert.equal(detail.shop, detailBody.data.seller.shopName, "店铺名来自 seller.shopName");
  // V6 不给 detail_url，值就该是空的——由消费方按 itemId 拼，别在这里编一个来源不明的链接。
  assert.equal(detail.detailUrl, undefined);
  assert.ok(!("detail_url" in detailBody.data), "V6 确实没有 detail_url，这条断言是给上游改版时报警的");
  assert.deepEqual(Object.keys(detail).sort(), ["detailUrl", "images", "numIid", "price", "shop", "title"]);
  assert.ok(!("desc" in detail) && !("props" in detail) && !("attribute" in detail));
  assert.ok(!("detailImages" in detail), "详情长图不是卡片主图，不进内部类型");

  assert.equal(new URL(calls[0]).pathname, "/api/taobao/get-item-detail/v6");
  assert.equal(new URL(calls[0]).searchParams.get("itemId"), requested);
});

test("详情映射：V6 的嵌套图组与券后价", async () => {
  const client = (body: unknown) => createTaobaoClient({ fetchImpl: stubFetch({ detail: () => ({ body }) }).fetchImpl, env });

  // 主图取 item.images[]，不是 detailImages[]（详情长图）：取错字段卡片会挂一张长图，
  // 而且是不报错的那种错。
  const nested = await client({
    code: 0,
    data: {
      item: {
        itemId: "9",
        title: "T",
        price: "78",
        couponPrice: "",
        images: ["//img.alicdn.com/first.jpg", "//img.alicdn.com/second.jpg"],
        detailImages: ["//img.alicdn.com/long.jpg"]
      },
      seller: { shopId: 1, shopName: "店" }
    }
  }).getItemDetail("9");
  assert.deepEqual(nested?.images, ["https://img.alicdn.com/first.jpg", "https://img.alicdn.com/second.jpg"]);
  assert.equal(nested?.numIid, "9");
  assert.equal(nested?.title, "T");
  assert.equal(nested?.price, "78");
  assert.equal(nested?.shop, "店");
  assert.equal(nested?.detailUrl, undefined, "V6 没有 detail_url，值就该是空的");

  // 现价是空串时退券后价；券后价只有部分商品有，没有时同样是空串。
  const coupon = await client({
    code: 0,
    data: { item: { itemId: "10", title: "T", images: ["//img.alicdn.com/a.jpg"], price: "", couponPrice: "68" } }
  }).getItemDetail("10");
  assert.equal(coupon?.price, "68");

  // 两个都有时以现价为准：挂出来的价要和商品页对得上，不能拿券后价冒充现价。
  const both = await client({
    code: 0,
    data: { item: { itemId: "11", title: "T", images: ["//img.alicdn.com/a.jpg"], price: "78", couponPrice: "68" } }
  }).getItemDetail("11");
  assert.equal(both?.price, "78");

  // 什么都没取到就返回 null（按失败处理），而不是一张空卡片。V6 下 detailUrl 恒空，
  // 这条判据实际落在标题与图上——正是最该守住的两样。
  const empty = await client({ code: 0, data: { item: {}, seller: {} } }).getItemDetail("12");
  assert.equal(empty, null);
});

test("详情映射：平铺形状（V8/V3）仍然收", async () => {
  const client = (body: unknown) => createTaobaoClient({ fetchImpl: stubFetch({ detail: () => ({ body }) }).fetchImpl, env });

  // 上游回退到平铺版本时，整套兜底链要一起生效——不然卡片会静默变成空标题 + 空图，
  // 那是没有报错、只有详情全空的那种坏法。
  const flat = await client({
    code: 0,
    data: {
      num_iid: 42,
      title: "",
      title_cn: "中文标题",
      item_imgs: ["//img.alicdn.com/first.jpg"],
      pic_url: "//img.alicdn.com/pic.jpg",
      nick: "店",
      detail_url: "https://item.taobao.com/item.htm?id=42"
    }
  }).getItemDetail("42");
  assert.equal(flat?.numIid, "42", "平铺的数字 ID 要转成字符串");
  assert.equal(flat?.title, "中文标题", "title 为空时用 title_cn 兜底");
  assert.deepEqual(flat?.images, ["https://img.alicdn.com/first.jpg"], "item_imgs[0] 是主图，退到 pic_url 就说明只认了一种形状");
  assert.equal(flat?.shop, "店");
  assert.equal(flat?.detailUrl, "https://item.taobao.com/item.htm?id=42");

  // 图组缺失才退到 pic_url。
  const noImgs = await client({ code: 0, data: { num_iid: 43, title: "T", pic_url: "//img.alicdn.com/p.jpg", nick: "店" } }).getItemDetail("43");
  assert.deepEqual(noImgs?.images, ["https://img.alicdn.com/p.jpg"]);

  // V3 的 {url} 形状也仍然收：上游若回退版本，图不会一起没了。
  const v3Shape = await client({ code: 0, data: { num_iid: "7", item_imgs: [{ url: "//img.alicdn.com/o.jpg" }] } }).getItemDetail("7");
  assert.deepEqual(v3Shape?.images, ["https://img.alicdn.com/o.jpg"]);
});

test("业务码非 0 抛错，错误信息里不带 token", async () => {
  const { fetchImpl } = stubFetch({
    search: () => ({ body: { code: 303, message: "超出每日配额", requestId: "req_1", data: null } })
  });
  const client = createTaobaoClient({ fetchImpl, env });

  await assert.rejects(
    () => client.searchItems("x"),
    (error: unknown) => {
      assert.ok(error instanceof TaobaoApiError);
      assert.equal(error.code, 303);
      assert.equal(error.requestId, "req_1");
      assert.equal(error.quotaLimited, true);
      assert.equal(error.retryable, false);
      assert.ok(!error.message.includes("test-token-1234"), "token 在 query 里，不能进错误信息");
      return true;
    }
  );
});

test("未配置 token 时零请求", async () => {
  const { fetchImpl, calls } = stubFetch({});
  const client = createTaobaoClient({ fetchImpl, env: { ...env, TAOBAO_API_TOKEN: "" } });

  assert.equal(client.configured, false);
  assert.deepEqual(await client.searchItems("x"), []);
  assert.equal(await client.getItemDetail("1"), null);
  assert.equal(calls.length, 0);
});

test("总开关：默认关，只有 true/1 算开", () => {
  // 没写、写空、写错都按关处理——这个方向的默认值只会少花钱。
  assert.equal(productCardsEnabled({}), false);
  assert.equal(productCardsEnabled({ TAOBAO_CARDS_ENABLED: "" }), false);
  assert.equal(productCardsEnabled({ TAOBAO_CARDS_ENABLED: "false" }), false);
  assert.equal(productCardsEnabled({ TAOBAO_CARDS_ENABLED: "TRUE " }), true);
  assert.equal(productCardsEnabled({ TAOBAO_CARDS_ENABLED: "1" }), true);
});

test("总开关关着时，配了 token 也零请求", async () => {
  const { fetchImpl, calls } = stubFetch({});
  // token 是齐的，只有开关关着——这是「一键关掉」最典型的用法。
  const client = createTaobaoClient({ fetchImpl, env: { ...env, TAOBAO_CARDS_ENABLED: "false" } });

  assert.equal(client.configured, false);
  assert.deepEqual(await client.searchItems("橘朵腮红"), []);
  assert.equal(await client.getItemDetail(DETAIL_ITEM_ID), null);
  assert.equal(calls.length, 0, "关掉开关就不该发出任何请求");
});

test("补全：搜索选中非广告位商品，详情配图与链接进卡片", async () => {
  const { search, detail } = await fixtures();
  const { fetchImpl, calls } = stubFetch({ search: () => ({ body: search }), detail: () => ({ body: detail }) });
  const client = createTaobaoClient({ fetchImpl, env });

  const streamed: ProductCard[] = [];
  const outcome = await buildProductCards([ref], { client, onCard: (card) => void streamed.push(card) });

  assert.equal(outcome.status, "ok");
  assert.equal(outcome.cards.length, 1);
  assert.deepEqual(streamed, outcome.cards, "每张卡都要通过 onCard 渐进推出去");

  const card = outcome.cards[0];
  assert.equal(card.id, productKey(ref));
  assert.equal(card.detailLevel, "detail");
  // 断言「详情赢了搜索回退」：这两条都取自详情 fixture，若映射没生效会落成
  // 搜索结果的 itemUrl(SEARCH_ITEM_ID) 与 uprightImg，这里就会挂。
  // V6 没有 detail_url，所以这里验的是按**详情自己的** itemId 拼出来的链接。
  assert.equal(card.purchaseUrl, itemUrl(DETAIL_ITEM_ID));
  assert.equal(card.image, detail.data.item.images[0]);
  assert.notEqual(card.purchaseUrl, itemUrl(SEARCH_ITEM_ID));
  // 两个 fixture 是不同商品，标题就成了「详情赢了搜索」的判据：
  // 映射没生效会落成搜索标题（橘朵），不是详情标题（川川也）。
  assert.equal(card.title, detail.data.item.title);
  assert.ok(card.price);
  assert.ok(!card.title.includes("<span"));
  assert.equal(calls.length, 2, "一件商品两次调用：搜索 + 详情");
});

test("选品规则：跳过广告位、优先标题含品牌名、全是广告才退让", () => {
  const items: TaobaoSearchItem[] = [
    { numIid: "ad", title: "橘朵 广告位", isP4p: true },
    { numIid: "other", title: "别的牌子腮红", isP4p: false },
    { numIid: "target", title: "Judydoll橘朵单色腮红", isP4p: false },
    { numIid: "later", title: "橘朵 更靠后", isP4p: false }
  ];

  assert.equal(pickSearchItem(items, "橘朵")?.numIid, "target");
  assert.equal(pickSearchItem(items, "兰蔻")?.numIid, "other", "前三条都不含品牌名时取第一条");
  assert.equal(pickSearchItem([{ numIid: "ad", title: "橘朵", isP4p: true }], "橘朵")?.numIid, "ad");
  assert.equal(pickSearchItem([], "橘朵"), undefined);
});

test("搜索词：品牌 + 品名 + 色号，压空白去尾标点限长", () => {
  assert.equal(buildSearchKeyword(ref), "橘朵 单色腮红 35");
  assert.equal(buildSearchKeyword({ category: "腮红", brand: " MAC ", name: "子弹头口红", section: "necessary" }), "MAC 子弹头口红");
  assert.equal(buildSearchKeyword({ category: "腮红", brand: "橘朵", name: "腮红盘，", section: "necessary" }), "橘朵 腮红盘");
  assert.ok(buildSearchKeyword({ category: "腮红", brand: "A".repeat(40), name: "B".repeat(40), section: "necessary" }).length <= 60);
});

test("搜索无结果：不出卡，记一条失败", async () => {
  const { fetchImpl } = stubFetch({ search: () => ({ body: { code: 0, message: null, data: { itemsArray: [] } } }) });
  const client = createTaobaoClient({ fetchImpl, env });

  const outcome = await buildProductCards([ref], { client });
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.cards.length, 0);
  assert.equal(outcome.failed.length, 1);
  assert.match(outcome.failed[0].reason, /没有搜到/);
});

test("详情失败：回退搜索图与 item.htm 链接，重试一次", async () => {
  const { search } = await fixtures();
  let detailCalls = 0;
  const { fetchImpl } = stubFetch({
    search: () => ({ body: search }),
    detail: () => {
      detailCalls += 1;
      return { status: 500, body: { code: 500, message: "内部服务器错误", data: null } };
    }
  });
  const client = createTaobaoClient({ fetchImpl, env });

  const outcome = await buildProductCards([ref], { client });
  assert.equal(outcome.status, "ok", "详情失败不算整件失败，卡片照样出");
  const card = outcome.cards[0];
  assert.equal(card.detailLevel, "search");
  // 回退分支的链接与图只可能来自搜索结果，所以这里按搜索 fixture 的 item id 断言。
  assert.equal(card.purchaseUrl, itemUrl(SEARCH_ITEM_ID));
  assert.ok(card.image?.startsWith("https://"));
  assert.equal(detailCalls, 2, "HTTP 5xx 重试一次");
});

test("配额码：停止本轮剩余请求，其余记失败", async () => {
  const refs: ProductRef[] = [
    ref,
    { category: "唇妆", brand: "MAC", name: "子弹头口红", section: "necessary" },
    { category: "眉笔", brand: "植村秀", name: "砍刀眉笔", section: "necessary" }
  ];
  let searchCalls = 0;
  const { fetchImpl } = stubFetch({
    search: () => {
      searchCalls += 1;
      return { body: { code: 303, message: "超出每日配额", requestId: "req_quota", data: null } };
    }
  });
  const client = createTaobaoClient({ fetchImpl, env });

  const outcome = await buildProductCards(refs, { client, concurrency: 1 });
  assert.equal(outcome.cards.length, 0);
  assert.equal(outcome.failed.length, 3);
  assert.equal(searchCalls, 1, "配额耗尽后不该继续发请求");
  assert.ok(outcome.failed.every((item) => item.reason.includes("额度受限")));
});

/**
 * 302（超出速率限制）与 303（超出每日配额）是两回事：前者是瞬时的，上游只在「用户 × 接口」
 * 配了速率时才返它，过一会儿自己会好。把这些用例单列，是因为线上出过一次 302 把整批打死、
 * 8 件商品里 6 件连试都没试的故障（SSOT 第 3 节 / 第 8.3 节）。
 */
test("302 限流：退避后重试一次，成功就照常出卡", async () => {
  const { search, detail } = await fixtures();
  let detailCalls = 0;
  const codes: number[] = [];
  const { fetchImpl } = stubFetch({
    search: () => ({ body: search }),
    detail: () => {
      detailCalls += 1;
      // 第一次限流，退避后的第二次正常——这正是 302 值得重试的原因：它是瞬时的。
      return detailCalls === 1
        ? { body: { code: 302, message: "超出速率限制", requestId: "req_rate", data: null } }
        : { body: detail };
    }
  });
  const client = createTaobaoClient({
    fetchImpl,
    env,
    onCall: (info) => {
      if (info.endpoint === "detail" && typeof info.code === "number") codes.push(info.code);
    }
  });

  const outcome = await buildProductCards([ref], { client, rateLimitBackoffMs: 1 });

  assert.equal(detailCalls, 2, "退避后要再试一次，不是直接放弃");
  assert.deepEqual(codes, [302, 0]);
  assert.equal(outcome.cards.length, 1);
  assert.equal(outcome.cards[0].detailLevel, "detail");
  assert.equal(outcome.status, "ok");
});

test("302 限流：只算这一件失败，后面的商品照常查完", async () => {
  const { search, detail } = await fixtures();
  const refs: ProductRef[] = [
    ref,
    { category: "唇妆", brand: "MAC", name: "子弹头口红", section: "necessary" },
    { category: "眉笔", brand: "植村秀", name: "砍刀眉笔", section: "necessary" }
  ];
  let searchCalls = 0;
  const { fetchImpl } = stubFetch({
    search: () => {
      searchCalls += 1;
      // 第一件一直限流（重试那次也 302），后面两件正常。
      return searchCalls <= 2
        ? { body: { code: 302, message: "超出速率限制", requestId: "req_rate", data: null } }
        : { body: search };
    },
    detail: () => ({ body: detail })
  });

  const outcome = await buildProductCards(refs, {
    client: createTaobaoClient({ fetchImpl, env }),
    concurrency: 1,
    rateLimitBackoffMs: 1
  });

  assert.equal(searchCalls, 4, "限流只该多花一次重试，不该让后面两件连试都不试");
  assert.equal(outcome.cards.length, 2);
  assert.equal(outcome.failed.length, 1);
  assert.equal(outcome.failed[0].reason, "淘宝接口失败 code=302", "失败原因要带真实错误码，不能被「额度受限」盖掉");
  assert.equal(outcome.status, "partial");
});

test("302 限流：详情撞上限流退到搜索回退卡，不算整件失败", async () => {
  const { search } = await fixtures();
  const { fetchImpl } = stubFetch({
    search: () => ({ body: search }),
    detail: () => ({ body: { code: 302, message: "超出速率限制", data: null } })
  });

  const outcome = await buildProductCards([ref], {
    client: createTaobaoClient({ fetchImpl, env }),
    rateLimitBackoffMs: 1
  });

  assert.equal(outcome.cards.length, 1);
  assert.equal(outcome.cards[0].detailLevel, "search", "搜索已经拿到商品了，卡片照出");
  assert.equal(outcome.cards[0].purchaseUrl, itemUrl(SEARCH_ITEM_ID));
  assert.equal(outcome.status, "ok");
});

test("302 之后本轮降并发：剩下的商品一件一件查", async () => {
  const refs: ProductRef[] = Array.from({ length: 5 }, (_, index) => ({ ...ref, name: `腮红${index}` }));
  const item: TaobaoSearchItem = { numIid: "1", title: "某件商品", isP4p: false };
  const detail: TaobaoItemDetail = { numIid: "1", title: "某件商品", images: [] };
  let inFlight = 0;
  let maxInFlightAfterRateLimit = 0;
  let rateLimited = false;

  // 用假 client 而不是 stubFetch：只有能控制每次调用何时返回，才能稳定地量「同时在跑几条」。
  const client: TaobaoClient = {
    configured: true,
    async searchItems(keyword) {
      inFlight += 1;
      if (rateLimited) maxInFlightAfterRateLimit = Math.max(maxInFlightAfterRateLimit, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      // 第一件一直限流（重试那次也 302），退避救不回来；其余正常。
      // 这里刻意不写成「第一次调用 302」——那样退避重试就能消化掉，测不出「302 不再整批停」。
      if (keyword.includes("腮红0")) {
        rateLimited = true;
        throw new TaobaoApiError("限流", { code: 302, retryable: false });
      }
      return [item];
    },
    async getItemDetail() {
      return detail;
    }
  };

  const outcome = await buildProductCards(refs, { client, rateLimitBackoffMs: 1 });

  assert.equal(outcome.cards.length, 4, "限流的那件失败，其余照查");
  assert.equal(outcome.failed.length, 1);
  assert.equal(maxInFlightAfterRateLimit, 1, "限流之后同时在跑的上游调用不该超过 1 条");
});

test("总预算：超预算的商品不再发请求", async () => {
  const { search } = await fixtures();
  const refs: ProductRef[] = [ref, { category: "唇妆", brand: "MAC", name: "子弹头口红", section: "necessary" }];
  let clock = 0;
  let searchCalls = 0;
  const { fetchImpl } = stubFetch({
    search: () => {
      searchCalls += 1;
      return { body: search };
    }
  });
  const client = createTaobaoClient({ fetchImpl, env });

  const outcome = await buildProductCards(refs, {
    client,
    concurrency: 1,
    budgetMs: 1000,
    now: () => clock,
    onCard: () => {
      clock = 5000;
    }
  });

  assert.equal(outcome.cards.length, 1);
  assert.equal(searchCalls, 1);
  assert.match(outcome.failed[0].reason, /预算/);
  assert.equal(outcome.status, "partial");
});

test("缓存命中不发请求", async () => {
  const cached: ProductCard = {
    id: productKey(ref),
    category: ref.category,
    brand: ref.brand,
    name: ref.name,
    shade: ref.shade,
    section: ref.section,
    title: "缓存里的商品",
    image: "https://img.alicdn.com/cached.jpg",
    purchaseUrl: "https://item.taobao.com/item.htm?id=1",
    detailLevel: "detail"
  };
  const store = new Map([[productKey(ref), cached]]);
  const { fetchImpl, calls } = stubFetch({});

  const outcome = await buildProductCards([ref], {
    client: createTaobaoClient({ fetchImpl, env }),
    cache: { get: (key) => store.get(key), set: (key, card) => void store.set(key, card) }
  });

  assert.deepEqual(outcome.cards, [cached]);
  assert.equal(calls.length, 0);
});

test("并发不超过 2", async () => {
  const { search } = await fixtures();
  const refs: ProductRef[] = Array.from({ length: 4 }, (_, index) => ({ ...ref, name: `腮红${index}` }));
  let inFlight = 0;
  let maxInFlight = 0;
  const { fetchImpl } = stubFetch({
    search: () => {
      return { body: search };
    }
  });
  const slowFetch = (async (input: RequestInfo | URL) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return fetchImpl(input as RequestInfo);
  }) as typeof fetch;

  const outcome = await buildProductCards(refs, {
    client: createTaobaoClient({ fetchImpl: slowFetch, env })
  });

  assert.equal(outcome.cards.length, 4);
  assert.equal(maxInFlight, 2, "并发上限是 2，别把上游当无限资源");
});

test("条数上限：超出的商品不处理", async () => {
  const { search, detail } = await fixtures();
  const refs: ProductRef[] = Array.from({ length: 3 }, (_, index) => ({ ...ref, name: `腮红${index}` }));
  let searchCalls = 0;
  const { fetchImpl } = stubFetch({
    search: () => {
      searchCalls += 1;
      return { body: search };
    },
    detail: () => ({ body: detail })
  });

  const outcome = await buildProductCards(refs, {
    client: createTaobaoClient({ fetchImpl, env }),
    limit: 2
  });

  assert.equal(outcome.cards.length, 2);
  assert.equal(searchCalls, 2);
});

test("观测回调：search/detail 各一条，字段与失败码正确，且记录里不含 URL", async () => {
  const fixtures_ = await fixtures();
  const calls: TaobaoCallInfo[] = [];
  const { fetchImpl } = stubFetch({
    search: (url) => {
      // 失败码与成功各来一次：同一个 keyword 第一次配额不足，第二次正常返回。
      return url.searchParams.get("keyword") === "失败商品"
        ? { body: { code: 303, message: "超出每日配额", requestId: "req_quota", data: null } }
        : { body: fixtures_.search };
    },
    detail: () => ({ body: fixtures_.detail })
  });
  const client = createTaobaoClient({ fetchImpl, env, onCall: (info) => calls.push(info) });

  await client.searchItems("橘朵腮红", { page: 1 });
  await client.getItemDetail(DETAIL_ITEM_ID);
  await assert.rejects(() => client.searchItems("失败商品"));

  assert.equal(calls.length, 3);
  const [search, detail, failed] = calls;

  assert.equal(search.endpoint, "search");
  assert.equal(search.ok, true);
  assert.equal(search.code, 0);
  assert.equal(search.keyword, "橘朵腮红");
  assert.equal(search.itemId, undefined);
  assert.ok(search.durationMs >= 0, "耗时要落成一个真实测得的毫秒数");

  assert.equal(detail.endpoint, "detail");
  assert.equal(detail.ok, true);
  assert.equal(detail.itemId, DETAIL_ITEM_ID);
  assert.equal(detail.keyword, undefined);

  // 45s 客户端超时与服务端 context deadline exceeded 是两件事，业务码要落下来。
  assert.equal(failed.endpoint, "search");
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 303);
  assert.equal(failed.requestId, "req_quota");
  assert.equal(failed.keyword, "失败商品");

  // token 走 query 参数，URL 永远不进观测数据。
  const handed = JSON.stringify(calls);
  assert.equal(handed.includes("test-token-1234"), false, "观测记录里不能出现 token");
  assert.equal(handed.includes("justoneapi"), false, "观测记录里不能出现请求 URL");
  assert.equal(handed.includes("http"), false, "观测记录里不能出现任何 URL");
});

test("观测回调抛错不影响淘宝调用", async () => {
  const search = (await fixtures()).search;
  const { fetchImpl } = stubFetch({ search: () => ({ body: search }) });
  const client = createTaobaoClient({
    fetchImpl,
    env,
    onCall: () => {
      throw new Error("观测炸了");
    }
  });

  const items = await client.searchItems("橘朵腮红");
  assert.ok(items.length > 0, "观测回调抛错只丢一条观测，不能改变调用结果");
});

test("卡片挂钩：每件各一次 start/finish，回退与失败都带原因", async () => {
  const fixtures_ = await fixtures();
  const { fetchImpl } = stubFetch({
    search: (url) => (url.searchParams.get("keyword")?.startsWith("断货") ? { body: { code: 0, data: { itemsArray: [] } } } : { body: fixtures_.search }),
    detail: () => ({ body: { code: 0, data: {} } })
  });
  const started: ProductRef[] = [];
  const finished: ProductCardRun[] = [];
  const missing: ProductRef = { category: "口红", brand: "断货", name: "不存在", section: "optional" };

  const outcome = await buildProductCards([ref, missing], {
    client: createTaobaoClient({ fetchImpl, env }),
    onCardStart: (item) => started.push(item),
    onCardFinish: (run) => finished.push(run)
  });

  assert.deepEqual(started, [ref, missing]);
  const ok = finished.find((run) => run.ref === ref);
  const bad = finished.find((run) => run.ref === missing);
  // 详情 fixture 里没有可用字段 → 回退搜索层；这正是从前那条隐性失败。
  assert.equal(ok?.ok, true);
  assert.equal(ok?.cacheHit, false);
  assert.equal(ok?.detailLevel, "search");
  assert.equal(bad?.ok, false);
  assert.equal(bad?.reason, "淘宝没有搜到可用商品");
  assert.equal(outcome.status, "partial");
});

test("卡片挂钩：缓存命中与致命错都各报告一次", async () => {
  const cached: ProductCard = {
    id: productKey(ref),
    category: ref.category,
    brand: ref.brand,
    name: ref.name,
    shade: ref.shade,
    section: ref.section,
    title: "缓存里的商品",
    purchaseUrl: "https://item.taobao.com/item.htm?id=1",
    detailLevel: "detail"
  };
  const store = new Map([[productKey(ref), cached]]);
  const { fetchImpl } = stubFetch({});
  const hits: ProductCardRun[] = [];
  await buildProductCards([ref], {
    client: createTaobaoClient({ fetchImpl, env }),
    cache: { get: (key) => store.get(key), set: (key, card) => void store.set(key, card) },
    onCardStart: () => {
      throw new Error("观测炸了");
    },
    onCardFinish: (run) => hits.push(run)
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].cacheHit, true);
  assert.equal(hits[0].detailLevel, "detail");

  // 致命错从 handle 抛出：start 与 finish 仍然配对，不会留下悬空观测。
  const fatal: ProductRef[] = [{ category: "腮红", brand: "橘朵", name: "单色腮红", section: "necessary" }];
  const { fetchImpl: quotaFetch } = stubFetch({
    search: () => ({ body: { code: 303, message: "超出每日配额", data: null } })
  });
  const events: string[] = [];
  const outcome = await buildProductCards(fatal, {
    client: createTaobaoClient({ fetchImpl: quotaFetch, env }),
    onCardStart: () => void events.push("start"),
    onCardFinish: (run) => void events.push(`finish:${run.ok}:${run.reason}`)
  });
  assert.deepEqual(events, ["start", "finish:false:淘宝查询额度受限"]);
  assert.equal(outcome.status, "unavailable");
});

test("上游调用带上卡片 tag，观测层才能把它挂到所属卡片之下", async () => {
  const fixtures_ = await fixtures();
  const calls: TaobaoCallInfo[] = [];
  const { fetchImpl } = stubFetch({
    search: (url) => (url.searchParams.get("keyword")?.startsWith("断货") ? { body: { code: 0, data: { itemsArray: [] } } } : { body: fixtures_.search }),
    detail: () => ({ body: fixtures_.detail })
  });
  const client = createTaobaoClient({ fetchImpl, env, onCall: (info) => calls.push(info) });
  const other: ProductRef = { category: "口红", brand: "断货", name: "不存在", section: "optional" };

  await buildProductCards([ref, other], { client });

  const mine = calls.filter((call) => call.tag === productKey(ref));
  const theirs = calls.filter((call) => call.tag === productKey(other));
  // 并发是 2：两个卡片各自的上游调用必须能区分开，否则观测只能挂在整批之下。
  assert.deepEqual(mine.map((call) => call.endpoint), ["search", "detail"]);
  assert.deepEqual(theirs.map((call) => call.endpoint), ["search"]);
  assert.notEqual(productKey(ref), productKey(other));
  assert.ok(calls.every((call) => call.tag), "每次上游调用都要带上 tag");
});

test("缓存命中不发请求，也就不产生 tag 记录", async () => {
  const cached: ProductCard = {
    id: productKey(ref),
    category: ref.category,
    brand: ref.brand,
    name: ref.name,
    shade: ref.shade,
    section: ref.section,
    title: "缓存里的商品",
    purchaseUrl: "https://item.taobao.com/item.htm?id=1",
    detailLevel: "detail"
  };
  const store = new Map([[productKey(ref), cached]]);
  const { fetchImpl } = stubFetch({});
  const calls: TaobaoCallInfo[] = [];
  await buildProductCards([ref], {
    client: createTaobaoClient({ fetchImpl, env, onCall: (info) => calls.push(info) }),
    cache: { get: (key) => store.get(key), set: (key, card) => void store.set(key, card) }
  });
  assert.deepEqual(calls, []);
});
