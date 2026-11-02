import test from "node:test";
import assert from "node:assert/strict";
import { isRuntimeAnswer, type RuntimeAnswer } from "../../frontend/lib/types.ts";
import { mergeProductCards, productCardStripView } from "../../frontend/lib/product-cards.ts";
import type { ProductCard } from "../../lib/commerce/types.ts";

test("runtime answers are recognized without being treated as domain AgentAnswer", () => {
  const answer: RuntimeAnswer = {
    answerText: "根据查询结果，建议轻薄底妆。",
    status: "succeeded",
    run: {
      traceId: "trace_1",
      agentRunId: "agent_1",
      conversationId: "conv_1",
      messageId: "msg_1"
    }
  };
  assert.equal(isRuntimeAnswer(answer), true);
  assert.equal(isRuntimeAnswer({ answerText: "old", conversationId: "conv_1" }), false);
});

function card(id: string, overrides: Partial<ProductCard> = {}): ProductCard {
  return {
    id,
    category: "腮红",
    brand: "橘朵",
    name: "单色腮红",
    section: "necessary",
    title: "橘朵单色腮红",
    purchaseUrl: "https://item.taobao.com/item.htm?id=1",
    detailLevel: "detail",
    ...overrides
  };
}

test("商品卡片事件按 id 合并、渐进追加", () => {
  const pending = mergeProductCards(undefined, { phase: "pending", expected: 2, categories: ["腮红", "唇妆"] });
  assert.equal(pending.status, "pending");
  assert.equal(pending.expected, 2);
  assert.deepEqual(pending.categories, ["腮红", "唇妆"]);

  const first = mergeProductCards(pending, { phase: "items", items: [card("a")] });
  assert.equal(first.items.length, 1);
  assert.equal(first.status, "pending", "还没 done，状态仍是 pending");

  // 同 id 再次出现是升级（例如详情回来之后换了更准的图和链接），不能变成两张卡。
  const upgraded = mergeProductCards(first, {
    phase: "items",
    items: [card("a", { detailLevel: "search", price: "39" }), card("b")]
  });
  assert.deepEqual(upgraded.items.map((item) => item.id), ["a", "b"]);
  assert.equal(upgraded.items[0].price, "39");

  const done = mergeProductCards(upgraded, {
    phase: "done",
    status: "partial",
    failed: [{ brand: "MAC", name: "子弹头口红", reason: "淘宝没有搜到可用商品" }]
  });
  assert.equal(done.status, "partial");
  assert.equal(done.items.length, 2);
  assert.equal(done.failed.length, 1);

  // 失败条目重复上报不会堆积。
  const again = mergeProductCards(done, {
    phase: "done",
    status: "partial",
    failed: [{ brand: "MAC", name: "子弹头口红", reason: "淘宝没有搜到可用商品" }]
  });
  assert.equal(again.failed.length, 1);
});

test("卡片条视图：已到卡片按清单顺序排，骨架只属于还没到的品类", () => {
  const pending = mergeProductCards(undefined, {
    phase: "pending",
    expected: 3,
    categories: ["粉底液", "遮瑕", "唇妆"]
  });
  // 到达顺序与清单顺序相反：视图要按 categories 排回来。
  const both = mergeProductCards(pending, {
    phase: "items",
    items: [card("lip", { category: "唇妆" }), card("base", { category: "粉底液" })]
  });

  const view = productCardStripView(both);
  assert.deepEqual(view.items.map((item) => item.id), ["base", "lip"]);
  assert.deepEqual(view.pendingLabels, ["遮瑕"], "已到的品类不能再出骨架");
});

test("卡片条视图：done 之后不再返回骨架，失败件整件不渲染", () => {
  const pending = mergeProductCards(undefined, {
    phase: "pending",
    expected: 3,
    categories: ["粉底液", "遮瑕", "唇妆"]
  });
  const first = mergeProductCards(pending, { phase: "items", items: [card("base", { category: "粉底液" })] });
  const done = mergeProductCards(first, {
    phase: "done",
    status: "partial",
    failed: [
      { brand: "NARS", name: "遮瑕膏", reason: "淘宝接口失败 code=301" },
      { brand: "MAC", name: "唇线笔", reason: "淘宝接口失败 code=301" }
    ]
  });

  const view = productCardStripView(done);
  assert.deepEqual(view.pendingLabels, [], "整批结束后骨架必须清空，否则永远停在「正在取」");
  assert.equal(view.items.length, 1, "失败件不占卡片位，只保留真正拿到的卡片");
});
