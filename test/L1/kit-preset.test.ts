import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePresetSeeded, presetEnabled, type KitState } from "../../lib/kit/preset.ts";
import { PRESET_KIT, PRESET_REQUIRED_CATEGORIES, type PresetProduct } from "../../lib/kit/preset-data.ts";
import { CATEGORY_ATTRIBUTES, isClosedValue } from "../../lib/kit/attributes.ts";
import { KIT_CATEGORIES, normalizeCategoryId } from "../../lib/kit/categories.ts";
import { createUserProduct, deleteProductsBySource, listAllUserProducts } from "../../lib/storage/user-products.ts";
import { readJson } from "../../lib/storage/json-store.ts";

/**
 * 预设妆匣的播种。
 *
 * 核心回归是**「清空之后不许再播」**：用户清空示例以后库又是空的，只看库空不空就会
 * 再播一次，用户会以为删除失效。所以判断依据必须是独立标记文件，这几条断言就是钉它。
 *
 * 播种内容用夹具注入（改内容不该连带改机制测试）；真实套件另有内容校验。
 */

async function withDataDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "looktrace-preset-"));
  const previous = process.env.LOOKTRACE_DATA_DIR;
  process.env.LOOKTRACE_DATA_DIR = dir;
  try {
    await run(dir);
  } finally {
    if (previous === undefined) delete process.env.LOOKTRACE_DATA_DIR;
    else process.env.LOOKTRACE_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const FIXTURE: PresetProduct[] = [
  {
    category: "底妆",
    brand: "示例品牌甲",
    name: "示例妆前乳",
    attributes: { finish: "水光" }
  },
  {
    category: "唇妆",
    brand: "示例品牌乙",
    name: "示例唇釉",
    shade: "01",
    attributes: { colorFamily: "正红", finish: "哑光", pigmentation: "浓郁" }
  }
];

test("开关默认开，只有明确的 false / 0 才关掉", () => {
  // 预设不花上游的钱、只写本地存储，所以缺省生效；这个变量是保险丝不是开关。
  for (const value of [undefined, "", "true", "1", "yes"]) {
    assert.equal(presetEnabled({ KIT_PRESET_ENABLED: value }), true, `${JSON.stringify(value)} 应打开`);
  }
  for (const value of ["false", "0", "FALSE", " 0 "]) {
    assert.equal(presetEnabled({ KIT_PRESET_ENABLED: value }), false, `${value} 应关闭`);
  }
});

test("关掉开关就不播种", async () => {
  await withDataDir(async () => {
    const result = await ensurePresetSeeded("local-user", { kit: FIXTURE, enabled: false });
    assert.deepEqual(result, { seeded: 0, skipped: "disabled" });
    assert.deepEqual(await listAllUserProducts("local-user"), []);
  });
});

test("没有内容时不播种（宁可是空妆匣，也不塞编造的商品）", async () => {
  await withDataDir(async () => {
    const result = await ensurePresetSeeded("local-user", { kit: [], enabled: true });
    assert.deepEqual(result, { seeded: 0, skipped: "no-preset-content" });
  });
});

test("真实套件逐条可核实：品类能归一、维度属于该品类、取值在词表内", () => {
  // 这些断言把第 5.2 节的内容硬约束变成机器能查的东西——内容是手写的，
  // 手写的东西必须有东西盯着。品类名写错、维度写错、闭集取值写错都会在这里炸。
  assert.ok(PRESET_KIT.length >= 8 && PRESET_KIT.length <= 12, `预设应在 8–12 件，实际 ${PRESET_KIT.length}`);

  const covered = new Set<string>();
  for (const item of PRESET_KIT) {
    const categoryId = normalizeCategoryId(item.category);
    assert.ok(categoryId, `品类认不出来：${item.category}`);
    covered.add(categoryId);

    assert.ok(item.brand.trim(), `${item.name} 缺品牌`);
    assert.ok(item.name.trim(), `${item.brand} 缺产品名`);
    // 没有色号的产品要写「不适用」：空表示「不知道」，两者含义不同。
    assert.ok(item.shade?.trim(), `${item.brand} ${item.name} 缺 shade（无色号请写「不适用」）`);

    for (const [key, value] of Object.entries(item.attributes)) {
      const spec = CATEGORY_ATTRIBUTES[categoryId].find((entry) => entry.id === key);
      assert.ok(spec, `${item.name} 的维度 ${key} 不属于 ${categoryId}`);
      assert.ok(
        isClosedValue(categoryId, spec.id, value),
        `${item.name} 的 ${key}＝${value} 不在闭集 ${spec.values.join("/")} 里`
      );
    }
    assert.ok(Object.keys(item.attributes).length > 0, `${item.name} 一条特点都没有`);
  }

  for (const required of PRESET_REQUIRED_CATEGORIES) {
    assert.ok(covered.has(required), `预设没覆盖必备品类 ${required}`);
  }
});

test("base 不放粉底色号——色号强依赖个人肤色", () => {
  for (const item of PRESET_KIT.filter((entry) => normalizeCategoryId(entry.category) === "base")) {
    assert.equal(item.shade, "不适用", `${item.name} 属于底妆，不该带依赖肤色的色号`);
  }
  // 反过来：有色品类必须给色号，否则没法核对。
  for (const item of PRESET_KIT.filter((entry) => ["lip", "blush", "eyeshadow"].includes(normalizeCategoryId(entry.category) ?? ""))) {
    assert.notEqual(item.shade, "不适用", `${item.name} 是有色品类，必须给色号`);
  }
});

test("真实套件播种后每件都是持有状态、来源 preset、特点已核实", async () => {
  await withDataDir(async () => {
    const result = await ensurePresetSeeded("local-user", { enabled: true });
    assert.equal(result.seeded, PRESET_KIT.length);

    const products = await listAllUserProducts("local-user");
    assert.equal(products.length, PRESET_KIT.length);
    for (const product of products) {
      assert.equal(product.status, "owned");
      assert.equal(product.recordSource, "preset");
      for (const [key, source] of Object.entries(product.attributeSources ?? {})) {
        // 策展时按官方页核实过——这是 search-verified 唯一的来源。
        assert.equal(source.source, "search-verified", `${product.brand} 的 ${key} 来源不对`);
      }
    }
  });
});

test("空妆匣时播种，条目是持有状态、来源 preset、特点已核实", async () => {
  await withDataDir(async () => {
    const result = await ensurePresetSeeded("local-user", { kit: FIXTURE, enabled: true });
    assert.equal(result.seeded, 2);

    const products = await listAllUserProducts("local-user");
    assert.equal(products.length, 2);
    for (const product of products) {
      assert.equal(product.status, "owned");
      assert.equal(product.recordSource, "preset");
    }

    const lip = products.find((product) => product.category === "唇妆");
    assert.equal(lip?.attributes?.pigmentation, "浓郁");
    // 预设的特点是策展时按官方页核实过的——这是 search-verified 唯一的来源。
    assert.equal(lip?.attributeSources?.pigmentation?.source, "search-verified");
    // 镜像到 legacy 列，存量界面照旧能显示。
    assert.equal(lip?.finish, "哑光");
  });
});

test("已经播过就不再播", async () => {
  await withDataDir(async () => {
    await ensurePresetSeeded("local-user", { kit: FIXTURE, enabled: true });
    const second = await ensurePresetSeeded("local-user", { kit: FIXTURE, enabled: true });
    assert.deepEqual(second, { seeded: 0, skipped: "already-seeded" });
    assert.equal((await listAllUserProducts("local-user")).length, 2);
  });
});

test("用户清空示例之后不再重播——少了这条，删除会「失效」", async () => {
  await withDataDir(async () => {
    await ensurePresetSeeded("local-user", { kit: FIXTURE, enabled: true });
    assert.equal(await deleteProductsBySource("local-user", "preset"), 2);
    assert.deepEqual(await listAllUserProducts("local-user"), []);

    // 库又是空的了，但标记还在，所以不该再播。
    const again = await ensurePresetSeeded("local-user", { kit: FIXTURE, enabled: true });
    assert.deepEqual(again, { seeded: 0, skipped: "already-seeded" });
    assert.deepEqual(await listAllUserProducts("local-user"), []);
  });
});

test("用户自己已经录过时不覆盖，只记标记", async () => {
  await withDataDir(async () => {
    await createUserProduct("local-user", { brand: "我自己的", category: "唇妆" });

    const result = await ensurePresetSeeded("local-user", { kit: FIXTURE, enabled: true });
    assert.deepEqual(result, { seeded: 0, skipped: "kit-not-empty" });

    const products = await listAllUserProducts("local-user");
    assert.equal(products.length, 1);
    assert.equal(products[0]?.brand, "我自己的");

    // 标记已落下：以后就算库被清空也不再播种。
    const state = await readJson<KitState>("kit-state.json", {});
    assert.equal(state.presetSeeded?.["local-user"], true);
  });
});

test("播种标记按用户分开", async () => {
  await withDataDir(async () => {
    await ensurePresetSeeded("user-a", { kit: FIXTURE, enabled: true });
    const other = await ensurePresetSeeded("user-b", { kit: FIXTURE, enabled: true });
    assert.equal(other.seeded, 2);
    assert.equal((await listAllUserProducts("user-a")).length, 2);
    assert.equal((await listAllUserProducts("user-b")).length, 2);
  });
});

test("预设要覆盖的品类都在标准品类里", () => {
  const names = new Set(KIT_CATEGORIES.map((category) => category.name));
  for (const categoryId of PRESET_REQUIRED_CATEGORIES) {
    const category = KIT_CATEGORIES.find((entry) => entry.categoryId === categoryId);
    assert.ok(category, `${categoryId} 不在标准品类里`);
    assert.ok(names.has(category.name));
  }
  // base 不放粉底色号这条约束，靠覆盖品类本身表不出来，写在 preset-data 的注释里。
  assert.equal(PRESET_REQUIRED_CATEGORIES.length, 7);
});
