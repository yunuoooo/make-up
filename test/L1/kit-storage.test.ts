import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createUserProduct,
  createUserProducts,
  deleteProductsBySource,
  kitProductView,
  listAllUserProducts,
  listUserProducts,
  mergeAttributes,
  updateUserProduct
} from "../../lib/storage/user-products.ts";

/**
 * 妆匣存储层。`LOOKTRACE_DATA_DIR` 在 `json-store.ts` 里是**调用时**读的，
 * 所以每个用例指向一个临时目录就够了，不用碰仓库的 `.local-data`。
 *
 * 这里钉的是三件容易静默错的事：
 *   1. legacy 顶层列与 `attributes` 的镜像关系（读的时候 attributes 赢）；
 *   2. `intensity` 是读时派生的，不落库；
 *   3. 清空预设只删 preset，用户自己录的一条都不能动。
 */

async function withDataDir(run: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "looktrace-kit-"));
  const previous = process.env.LOOKTRACE_DATA_DIR;
  process.env.LOOKTRACE_DATA_DIR = dir;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.LOOKTRACE_DATA_DIR;
    else process.env.LOOKTRACE_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test("写入时把三个同名键镜像回 legacy 顶层列", async () => {
  await withDataDir(async () => {
    const product = await createUserProduct("local-user", {
      brand: "示例品牌",
      category: "唇妆",
      attributes: { colorFamily: "正红", finish: "哑光", pigmentation: "浓郁" }
    });

    // 存量界面（搜索、标签行）还在读顶层字段，镜像断了它们就静默变空。
    assert.equal(product.colorFamily, "正红");
    assert.equal(product.finish, "哑光");
    assert.equal(product.attributes?.pigmentation, "浓郁");
    // 没有顶层对应列的维度只存在 attributes 里。
    assert.equal(product.texture, undefined);
  });
});

test("读取合并两边，attributes 里的键赢", () => {
  assert.deepEqual(
    mergeAttributes({ attributes: { finish: "镜面" }, colorFamily: "正红", finish: "哑光" }),
    { colorFamily: "正红", finish: "镜面" }
  );
  // 存量数据只有顶层列，也要读得出来。
  assert.deepEqual(mergeAttributes({ colorFamily: "豆沙", finish: "雾面" }), { colorFamily: "豆沙", finish: "雾面" });
  assert.deepEqual(mergeAttributes({}), {});
});

test("视图给出归一化品类、逐属性来源与派生浓淡，不落库", async () => {
  await withDataDir(async () => {
    const product = await createUserProduct("local-user", {
      brand: "示例品牌",
      category: "唇釉",
      shade: "01",
      attributes: { colorFamily: "正红", finish: "哑光", pigmentation: "浓郁" },
      attributeSources: { colorFamily: { source: "model-inferred" }, pigmentation: { source: "user" } },
      recordSource: "import"
    });

    const view = kitProductView(product);
    assert.equal(view.categoryId, "lip");
    assert.equal(view.category, "唇妆");
    assert.equal(view.categoryRaw, "唇釉");
    assert.equal(view.intensity, "浓郁");
    assert.equal(view.recordSource, "import");
    assert.deepEqual(view.attributeSources.pigmentation, { source: "user" });

    // 派生值不落库：存储里不该出现 intensity 这个键。
    const [stored] = await listAllUserProducts("local-user");
    assert.ok(!("intensity" in stored), "intensity 必须是读时派生，不能固化进存储");
  });
});

test("认不出品类时视图如实给 null，不丢原文", async () => {
  await withDataDir(async () => {
    const product = await createUserProduct("local-user", { brand: "示例品牌", category: "粉饼" });
    const view = kitProductView(product);
    assert.equal(view.categoryId, null);
    assert.equal(view.category, null);
    assert.equal(view.categoryRaw, "粉饼");
    assert.equal(view.intensity, undefined);
  });
});

test("批量写入只读一次写一次，且不改动已有记录", async () => {
  await withDataDir(async () => {
    const first = await createUserProduct("local-user", { brand: "甲", category: "唇妆" });
    const created = await createUserProducts("local-user", [
      { brand: "乙", category: "底妆", recordSource: "preset" },
      { brand: "丙", category: "腮红", recordSource: "preset" }
    ]);

    assert.equal(created.length, 2);
    const all = await listAllUserProducts("local-user");
    assert.equal(all.length, 3);
    assert.ok(all.some((product) => product.id === first.id));
    // 空数组不该触发一次写入。
    assert.deepEqual(await createUserProducts("local-user", []), []);
    assert.equal((await listAllUserProducts("local-user")).length, 3);
  });
});

test("清空预设只删 preset，用户自己录的与导入的一条都不能动", async () => {
  await withDataDir(async () => {
    await createUserProducts("local-user", [
      { brand: "预设甲", category: "底妆", recordSource: "preset" },
      { brand: "预设乙", category: "唇妆", recordSource: "preset" }
    ]);
    await createUserProduct("local-user", { brand: "我自己的", category: "唇妆", recordSource: "manual" });
    await createUserProduct("local-user", { brand: "导入的", category: "腮红", recordSource: "import" });
    // 没写 recordSource 的存量记录按 manual 处理，别被当成预设删掉。
    await createUserProduct("local-user", { brand: "存量", category: "眼影" });

    assert.equal(await deleteProductsBySource("local-user", "preset"), 2);

    const left = await listAllUserProducts("local-user");
    assert.equal(left.length, 3);
    assert.deepEqual(left.map((product) => product.brand).sort(), ["我自己的", "导入的", "存量"].sort());
    // 再清一次是幂等的。
    assert.equal(await deleteProductsBySource("local-user", "preset"), 0);
  });
});

test("update 只在 attributes 里有键时才覆盖 legacy 列", async () => {
  await withDataDir(async () => {
    const product = await createUserProduct("local-user", {
      brand: "示例品牌",
      category: "唇妆",
      colorFamily: "正红",
      finish: "哑光"
    });

    // 只改色系：finish 保留原值，不能被 undefined 抹掉。
    const updated = await updateUserProduct("local-user", product.id, { attributes: { colorFamily: "砖红" } });
    assert.equal(updated?.colorFamily, "砖红");
    assert.equal(updated?.finish, "哑光");
  });
});

test("retired 不进 listUserProducts，但仍留在全量里", async () => {
  await withDataDir(async () => {
    const product = await createUserProduct("local-user", { brand: "用完了", category: "唇妆", status: "retired" });
    assert.deepEqual(await listUserProducts("local-user"), []);
    assert.equal((await listAllUserProducts("local-user"))[0]?.id, product.id);
  });
});
