import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PRODUCT_LIMIT,
  extractProductBlock,
  productKey,
  stripProductBlock
} from "../../lib/commerce/product-block.ts";

const fence = (body: string) => `\`\`\`looktrace-products\n${body}\n\`\`\``;

const valid = JSON.stringify({
  version: "looktrace.products.v1",
  items: [
    { category: "粉底液", brand: "兰蔻", name: "菁纯臻颜精华粉底液", shade: "BO-01", section: "necessary" },
    { category: "唇妆", brand: "MAC", name: "子弹头口红", section: "optional" }
  ]
});

test("提取商品块并从正文里剥离", () => {
  const { items, text } = extractProductBlock(`整体妆效先给结论。\n\n${fence(valid)}\n`);

  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    category: "粉底液",
    brand: "兰蔻",
    name: "菁纯臻颜精华粉底液",
    shade: "BO-01",
    section: "necessary"
  });
  // 色号为空时不带 shade 字段，section 按块里写的来。
  assert.deepEqual(items[1], { category: "唇妆", brand: "MAC", name: "子弹头口红", section: "optional" });
  assert.match(text, /整体妆效先给结论。/);
  assert.ok(!text.includes("looktrace-products"), "正文里不能留下块");
  assert.ok(!text.includes("粉底液"), "正文里不能留下块的 JSON");
});

test("流式输出到一半（块没有闭合）也要藏住", () => {
  const partial = `结论。\n\n\`\`\`looktrace-products\n{"version":"looktrace.products.v1","items":[{"category":"腮红","bra`;
  const text = stripProductBlock(partial);

  assert.match(text, /结论。/);
  assert.ok(!text.includes("looktrace-products"));
  assert.ok(!text.includes('"items"'));

  // 未闭合的块解析不出清单，但绝不能当正文展示。
  assert.deepEqual(extractProductBlock(partial).items, []);
});

test("块不合法时不出清单，但照样剥离", () => {
  for (const body of ["{ 这不是 JSON", JSON.stringify({ version: "v0", items: [] }), JSON.stringify({ items: [] })]) {
    const { items, text } = extractProductBlock(`${fence(body)}\n正文`);
    assert.deepEqual(items, [], `不应该解析出清单：${body.slice(0, 20)}`);
    assert.ok(!text.includes("looktrace-products"));
    assert.match(text, /正文/);
  }
});

test("逐条校验：字段缺失跳过、去重、限流", () => {
  const body = JSON.stringify({
    version: "looktrace.products.v1",
    items: [
      { category: "腮红", brand: "橘朵", name: "单色腮红", shade: "35" },
      { category: "腮红", brand: "橘朵", name: "单色腮红", shade: "35" }, // 与上一条重复
      { category: "腮红", brand: "橘朵", name: "缺 section 按 necessary" },
      { category: "腮红", brand: "", name: "没有品牌" },
      { category: "腮红", brand: "橘朵", name: "另一个" },
      { category: "眼影", brand: "橘朵", name: "四色眼影" }
    ]
  });
  const { items } = extractProductBlock(fence(body));
  assert.deepEqual(
    items.map((item) => item.name),
    ["单色腮红", "缺 section 按 necessary", "另一个", "四色眼影"]
  );
  assert.equal(items[1].section, "necessary", "没写 section 时按必要表处理");

  const limited = extractProductBlock(fence(body), { limit: 1 });
  assert.equal(limited.items.length, 1);

  const many = JSON.stringify({
    version: "looktrace.products.v1",
    items: Array.from({ length: 20 }, (_, index) => ({ category: "口红", brand: "MAC", name: `色号${index}` }))
  });
  assert.equal(extractProductBlock(fence(many)).items.length, DEFAULT_PRODUCT_LIMIT);
});

test("多个块：合法条目合并去重，坏块跳过，全部剥离", () => {
  const broken = fence("{ 坏的");
  const necessary = fence(JSON.stringify({
    version: "looktrace.products.v1",
    items: [{ category: "眉笔", brand: "植村秀", name: "砍刀眉笔", shade: "02" }]
  }));
  const optional = fence(JSON.stringify({
    version: "looktrace.products.v1",
    items: [
      { category: "高光", brand: "植村秀", name: "液体高光", section: "optional" },
      { category: "眉笔", brand: "植村秀", name: "砍刀眉笔", shade: "02" }
    ]
  }));
  const { items, text } = extractProductBlock(`${broken}\n中间的正文\n${necessary}\n${optional}`);

  assert.deepEqual(
    items.map((item) => item.name),
    ["砍刀眉笔", "液体高光"],
    "模型把必要与非必要拆成两个块时，两张表的商品都要拿到，重复的只留一条"
  );
  assert.match(text, /中间的正文/);
  assert.ok(!text.includes("looktrace-products"));
});

test("卡片 id 用的归一化键", () => {
  assert.equal(productKey({ brand: " MAC ", name: "子弹头 口红", shade: "Chili" }), "mac|子弹头 口红|chili");
  assert.equal(productKey({ brand: "MAC", name: "子弹头口红" }), "mac|子弹头口红|");
});
