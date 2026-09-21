import test from "node:test";
import assert from "node:assert/strict";
import { isRuntimeAnswer, type RuntimeAnswer } from "../../frontend/lib/types.ts";
import { mergeProductCards } from "../../frontend/lib/product-cards.ts";
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
