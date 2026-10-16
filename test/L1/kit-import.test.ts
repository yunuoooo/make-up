import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImportInputs, importMaxChars, normalizeJudgeAttributes } from "../../lib/kit/judge.ts";
import { createUserProducts, listUserProducts } from "../../lib/storage/user-products.ts";

/**
 * 导入的两条不变量：
 *
 * 1. **闭集外的取值不参与妆效比对，但一个字都不能丢**——静默丢字段是这个仓库最忌讳的
 *    失败方式（规格第 7.2 节「其余约定」）。
 * 2. **逐属性来源要分得开**：判断推断出来的是线索（`model-inferred`），用户改过的才是
 *    声明（`user`）。混在一起，模型就会把猜的当查到的讲给用户。
 *
 * 模型调用本身不在这里测（那要真起 pi 进程，属 L3，本轮不做）；被调用前后的纯逻辑
 * 与落库路径都在这里。
 */

async function withDataDir(run: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "looktrace-import-"));
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

test("闭集取值进 attributes，闭集外的保留原文进 unknowns", () => {
  const { attributes, extraTags } = normalizeJudgeAttributes("lip", {
    colorFamily: "正红",
    finish: "哑光",
    pigmentation: "浓郁",
    coverage: "高",        // lip 没有这个维度
    claim: "超持久不脱色"   // 不是任何维度
  });

  assert.deepEqual(attributes, { colorFamily: "正红", finish: "哑光", pigmentation: "浓郁" });
  // 不丢：认不出的维度与取值都留着，界面按自由标签展示。
  assert.deepEqual(extraTags.sort(), ["超持久不脱色", "高"].sort());
});

test("严格闭集里的非法取值不算已填，但仍保留原文", () => {
  const { attributes, extraTags } = normalizeJudgeAttributes("base", { coverage: "超高", finish: "雾面" });
  assert.deepEqual(attributes, { finish: "雾面" });
  assert.deepEqual(extraTags, ["超高"]);
});

test("色系是开放维度，常见叫法照收", () => {
  const { attributes, extraTags } = normalizeJudgeAttributes("lip", { colorFamily: "奶茶色" });
  assert.deepEqual(attributes, { colorFamily: "奶茶色" });
  assert.deepEqual(extraTags, []);
});

test("品类认不出来时不填 attributes，全部留成自由标签", () => {
  const { attributes, extraTags } = normalizeJudgeAttributes(null, { finish: "哑光" });
  assert.deepEqual(attributes, {});
  assert.deepEqual(extraTags, ["哑光"]);
  // 空值不进任何一边。
  assert.deepEqual(normalizeJudgeAttributes("lip", { finish: "  ", colorFamily: "" }).extraTags, []);
});

test("确认后的条目按词表落库，来源默认是 model-inferred", async () => {
  await withDataDir(async () => {
    const built = buildImportInputs([
      {
        category: "唇釉",
        brand: "示例品牌",
        shade: "01",
        attributes: { colorFamily: "正红", finish: "哑光", pigmentation: "浓郁" }
      }
    ]);
    assert.ok(built.ok);
    const created = await createUserProducts("local-user", built.inputs);

    assert.equal(created.length, 1);
    assert.equal(created[0].recordSource, "import");
    assert.equal(created[0].status, "owned");
    assert.equal(created[0].attributes?.pigmentation, "浓郁");
    // 判断推断出来的是**线索**，不是已核实的事实。
    for (const key of ["colorFamily", "finish", "pigmentation"]) {
      assert.equal(created[0].attributeSources?.[key]?.source, "model-inferred", `${key} 来源不对`);
    }
  });
});

test("用户改过的那几个属性转 user，其余仍是 model-inferred", async () => {
  await withDataDir(async () => {
    const built = buildImportInputs([
      {
        category: "唇妆",
        brand: "示例品牌",
        attributes: { colorFamily: "砖红", finish: "哑光" },
        // 用户把色系从「正红」改成了「砖红」，妆效没动。
        editedAttributes: ["colorFamily"]
      }
    ]);
    assert.ok(built.ok);
    const [created] = await createUserProducts("local-user", built.inputs);

    assert.equal(created.attributeSources?.colorFamily?.source, "user");
    assert.equal(created.attributeSources?.finish?.source, "model-inferred");
  });
});

test("勾了「已用完」的条目写 retired，不进 listUserProducts", async () => {
  await withDataDir(async () => {
    const built = buildImportInputs([
      { category: "唇妆", brand: "用完了的", retired: true },
      { category: "底妆", brand: "还在用的" }
    ]);
    assert.ok(built.ok);
    await createUserProducts("local-user", built.inputs);

    const active = await listUserProducts("local-user");
    assert.deepEqual(active.map((product) => product.brand), ["还在用的"]);
  });
});

test("缺品牌或品类直接报错，不静默跳过条目", () => {
  const missingBrand = buildImportInputs([{ category: "唇妆" }]);
  assert.equal(missingBrand.ok, false);
  assert.match(missingBrand.ok === false ? missingBrand.error : "", /品牌或品类/);

  const missingCategory = buildImportInputs([{ brand: "示例品牌", category: "  " }]);
  assert.equal(missingCategory.ok, false);

  // 空列表也算错，不能返回一个「成功导入 0 件」。
  assert.equal(buildImportInputs([]).ok, false);
});

test("归一不出的品类照存原文，不丢条目", async () => {
  await withDataDir(async () => {
    const built = buildImportInputs([{ category: "粉饼", brand: "示例品牌" }]);
    assert.ok(built.ok);
    const [created] = await createUserProducts("local-user", built.inputs);
    // 认不出来也要留着——工具层会给 categoryId: null，用户还能自己改。
    assert.equal(created.category, "粉饼");
  });
});

test("只有品类与品牌也能导入，色号缺失不阻断", async () => {
  await withDataDir(async () => {
    const built = buildImportInputs([{ category: "工具", brand: "示例品牌" }]);
    assert.ok(built.ok);
    assert.equal(built.inputs[0].shade, "");
    // 工具类没有 attributes 时不该塞一个空对象进去。
    assert.equal("attributes" in built.inputs[0], false);
  });
});

test("输入上限有缺省值，且能由环境变量覆盖", () => {
  assert.equal(importMaxChars({}), 20000);
  assert.equal(importMaxChars({ KIT_IMPORT_MAX_CHARS: "500" }), 500);
  // 非法值退回缺省，不要变成 0 或 NaN 把一切都拒掉。
  assert.equal(importMaxChars({ KIT_IMPORT_MAX_CHARS: "abc" }), 20000);
  assert.equal(importMaxChars({ KIT_IMPORT_MAX_CHARS: "-3" }), 20000);
});
