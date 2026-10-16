import test from "node:test";
import assert from "node:assert/strict";
import {
  KIT_CATEGORIES,
  KIT_CATEGORY_NAMES,
  findCategory,
  isKitCategoryId,
  normalizeCategoryId
} from "../../lib/kit/categories.ts";
import {
  CATEGORY_ATTRIBUTES,
  attributeSpec,
  deriveIntensity,
  isClosedValue,
  splitByVocabulary
} from "../../lib/kit/attributes.ts";
import { CATEGORY_OPTIONS } from "../../frontend/lib/constants.ts";

/**
 * 品类与属性词表是需求侧与能力侧共用的那一份（规格 `10-16-makeup-kit.md` 第 7 节）。
 * 这里的断言防的是两类静默退化：
 *   1. `CATEGORY_OPTIONS` 与词表分叉 —— 顾问说出的品类落不进筛选项，界面看着是空的；
 *   2. `intensity` 与决定性维度打架 —— 两侧对不上，匹配退回模型自由心证。
 */

test("CATEGORY_OPTIONS 从词表派生，顺序与内容都不许漂", () => {
  assert.deepEqual(CATEGORY_OPTIONS, [...KIT_CATEGORY_NAMES]);
  // 前端筛选与历史数据依赖这个顺序，重排会静默改变筛选项的排列。
  assert.deepEqual(CATEGORY_OPTIONS, [
    "底妆", "遮瑕", "定妆", "眉笔", "眼影", "眼线",
    "睫毛膏", "腮红", "修容", "高光", "唇妆", "工具"
  ]);
  assert.equal(new Set(CATEGORY_OPTIONS).size, CATEGORY_OPTIONS.length, "品类名不能重复");
});

test("每个品类都有 id 与中文名，id 唯一", () => {
  const ids = KIT_CATEGORIES.map((category) => category.categoryId);
  assert.equal(new Set(ids).size, ids.length);
  for (const category of KIT_CATEGORIES) {
    assert.ok(category.name.trim(), `${category.categoryId} 缺中文名`);
    assert.ok(category.aliases.length > 0, `${category.categoryId} 缺别名`);
  }
  assert.equal(findCategory("brow").name, "眉笔", "「眉笔」代表整个眉部产品组");
});

test("把用户与推荐文案里的品类原文归一到标准品类", () => {
  const cases: [string, string][] = [
    ["唇妆", "lip"],
    ["lip", "lip"],
    ["口红", "lip"],
    ["唇釉", "lip"],
    ["唇妆（口红）", "lip"],
    ["唇妆(口红)", "lip"],
    [" 眼影盘 ", "eyeshadow"],
    ["气垫", "base"],
    ["妆前乳", "base"],
    ["定妆喷雾", "setting"],
    ["眉粉", "brow"],
    ["腮红膏", "blush"],
    ["美妆蛋", "tools"],
    ["LIP", "lip"]
  ];
  for (const [raw, expected] of cases) {
    assert.equal(normalizeCategoryId(raw), expected, `${raw} 应归到 ${expected}`);
  }
});

test("认不出的品类返回 null，调用方保留原文当待归类候选", () => {
  // 「粉饼」按字面分不出底妆还是定妆（categories.md 使用规则第 5 条）——不许猜。
  for (const raw of ["粉饼", "什么呢", "", "   ", null, undefined, "眼影 盘盘盘"]) {
    assert.equal(normalizeCategoryId(raw as string), null, `${JSON.stringify(raw)} 不该被归一`);
  }
  // 只做精确匹配：包含「粉」不代表它是底妆。
  assert.equal(normalizeCategoryId("粉底液试用装"), null);
});

test("严格闭集以外的取值不参与妆效比对，但原文保留", () => {
  assert.equal(isClosedValue("base", "coverage", "高"), true);
  assert.equal(isClosedValue("base", "coverage", "超高"), false);
  // 色系是开放维度：合法取值本质开放，硬套闭集只会把真话挤成错话。
  assert.equal(isClosedValue("lip", "colorFamily", "奶茶色"), true);
  assert.equal(isClosedValue("lip", "colorFamily", ""), false);
  // 品类里没有的维度不算已填。
  assert.equal(isClosedValue("tools", "coverage", "高"), false);

  assert.deepEqual(splitByVocabulary("base", "coverage", "超高"), { known: null, raw: "超高" });
  assert.deepEqual(splitByVocabulary("base", "coverage", "高"), { known: "高", raw: "高" });
});

test("妆感浓淡由决定性维度派生，base 与 lip 带妆效条件", () => {
  // base：浓郁要遮盖力高**且**（雾面或持妆持久）。
  assert.equal(deriveIntensity("base", { coverage: "高", finish: "雾面" }), "浓郁");
  assert.equal(deriveIntensity("base", { coverage: "高", longevity: "持久" }), "浓郁");
  assert.equal(deriveIntensity("base", { coverage: "高", finish: "水光" }), "日常");
  assert.equal(deriveIntensity("base", { coverage: "清透", finish: "水光" }), "清透");
  assert.equal(deriveIntensity("base", { coverage: "中等", finish: "雾面" }), "日常");

  // lip：浓郁要显色度浓郁**且**哑光或镜面。
  assert.equal(deriveIntensity("lip", { pigmentation: "浓郁", finish: "哑光" }), "浓郁");
  assert.equal(deriveIntensity("lip", { pigmentation: "浓郁", finish: "镜面" }), "浓郁");
  assert.equal(deriveIntensity("lip", { pigmentation: "浓郁", finish: "水光" }), "日常");
  assert.equal(deriveIntensity("lip", { pigmentation: "清透", finish: "缎光" }), "清透");

  // 其余品类同构，只看浓度维度。
  assert.equal(deriveIntensity("blush", { pigmentation: "浓郁", texture: "粉" }), "浓郁");
  assert.equal(deriveIntensity("eyeshadow", { pigmentation: "中等" }), "日常");
});

test("维度未知时不猜浓淡", () => {
  // 不知道就是不知道——这里返回 null，界面与答案都要如实说「未知」。
  assert.equal(deriveIntensity("base", {}), null);
  assert.equal(deriveIntensity("base", { finish: "雾面" }), null);
  assert.equal(deriveIntensity("tools", {}), null);
  // 空字符串不算填过。
  assert.equal(deriveIntensity("lip", { pigmentation: "  " }), null);
});

test("逐品类维度都带中文名与取值，工具类不参与妆效比对", () => {
  for (const [categoryId, specs] of Object.entries(CATEGORY_ATTRIBUTES)) {
    for (const spec of specs) {
      assert.ok(spec.label.trim(), `${categoryId}.${spec.id} 缺中文名`);
      assert.ok(spec.values.length > 0, `${categoryId}.${spec.id} 缺取值`);
      assert.equal(isKitCategoryId(categoryId), true);
    }
  }
  assert.deepEqual(CATEGORY_ATTRIBUTES.tools, []);
  assert.equal(attributeSpec("tools", "coverage"), null);
  assert.equal(attributeSpec("base", "coverage")?.label, "遮盖力");
});
