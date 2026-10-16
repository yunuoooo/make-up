import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePresetSeeded, presetEnabled, type KitState } from "../../lib/kit/preset.ts";
import { PRESET_KIT, PRESET_REQUIRED_CATEGORIES, type PresetProduct } from "../../lib/kit/preset-data.ts";
import { createUserProduct, deleteProductsBySource, listAllUserProducts } from "../../lib/storage/user-products.ts";
import { readJson } from "../../lib/storage/json-store.ts";
import { KIT_CATEGORIES } from "../../lib/kit/categories.ts";

/**
 * 预设妆匣的播种。
 *
 * 核心回归是**「清空之后不许再播」**：用户清空示例以后库又是空的，只看库空不空就会
 * 再播一次，用户会以为删除失效。所以判断依据必须是独立标记文件，这几条断言就是钉它。
 *
 * 内容用测试夹具注入（真实套件在 `preset-data.ts`，为空，等选品核实）。
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

test("开关只有明确的 true / 1 才算打开", () => {
  for (const value of ["true", "1", "TRUE", " 1 "]) {
    assert.equal(presetEnabled({ KIT_PRESET_ENABLED: value }), true, `${value} 应打开`);
  }
  for (const value of ["false", "0", "", "yes", undefined]) {
    assert.equal(presetEnabled({ KIT_PRESET_ENABLED: value }), false, `${JSON.stringify(value)} 应关闭`);
  }
});

test("关掉开关就不播种", async () => {
  await withDataDir(async () => {
    const result = await ensurePresetSeeded("local-user", { kit: FIXTURE, enabled: false });
    assert.deepEqual(result, { seeded: 0, skipped: "disabled" });
    assert.deepEqual(await listAllUserProducts("local-user"), []);
  });
});

test("真实套件还没核实完，因此不播种", async () => {
  await withDataDir(async () => {
    // 内容为空是**有意的**：宁可是空妆匣，也不能把编造的商品当成用户持有。
    assert.deepEqual(PRESET_KIT, []);
    const result = await ensurePresetSeeded("local-user", { enabled: true });
    assert.deepEqual(result, { seeded: 0, skipped: "no-preset-content" });
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
