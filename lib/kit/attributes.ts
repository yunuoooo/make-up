import { findCategory, type KitCategoryId } from "./categories.ts";

/**
 * 妆匣的属性（特点）词表，与品类映射同级 —— 见规格 `docs/specs/10-16-makeup-kit.md` 第 7.2 节。
 *
 * 为什么它是这套设计的地基：技能的两侧都要说「特点」。
 *   需求侧（advisor 研究妆容得到）：「底妆：浓郁、雾面」
 *   能力侧（妆匣里这一件）        ：「遮盖力 高、妆效 雾面」
 * 两侧不共用词表，比对就只剩模型自由心证，录入时判断也白做。
 *
 * **零 `@/` 依赖**：扩展要用这个文件（先例 `.pi/extensions/xhs-source.ts` 全用相对路径）。
 */

/** 这条特点是谁给的、有多可信。逐属性记，不能一条记录一个。 */
export type AttributeProvenance = "user" | "model-inferred" | "search-verified";

export type AttributeSourceRecord = {
  source: AttributeProvenance;
  /** ISO 时间。只有 `search-verified` 必须带。 */
  at?: string;
};

export type KitAttributeId =
  | "colorFamily"
  | "finish"
  | "texture"
  | "coverage"
  | "longevity"
  | "oilControl"
  | "form"
  | "pigmentation"
  | "structure"
  | "waterproof"
  | "colorTemperature";

export type AttributeSpec = {
  id: KitAttributeId;
  /** 中文维度名。需求侧要能说出同一个词。 */
  label: string;
  /** 推荐取值。`strict` 为真时这是**闭集**，取值必须在里面才参与妆效比对。 */
  values: readonly string[];
  /**
   * 严格闭集。
   *
   * `colorFamily` 是**开放**的：色系的合法取值本质上是开放的（「正红」「砖红」「奶茶色」…），
   * 硬套闭集只会把真话挤成错话；而且技能自己的判例（`matching-cases.md` 的
   * 「烈焰红唇 vs 橘色嘴唇」）就是语义层比色，不靠枚举。其余维度都严格闭集。
   */
  strict: boolean;
};

const COLOR_FAMILY: AttributeSpec = {
  id: "colorFamily",
  label: "色系",
  strict: false,
  values: ["正红", "砖红", "豆沙", "裸粉", "珊瑚", "橘调", "棕调", "紫调", "玫调", "灰调", "黑", "白"]
};

const FINISH_BASE: AttributeSpec = { id: "finish", label: "妆效", strict: true, values: ["雾面", "半哑光", "水光"] };
const FINISH_LIP: AttributeSpec = { id: "finish", label: "妆效", strict: true, values: ["哑光", "缎光", "镜面", "水光"] };
const FINISH_SHADOW: AttributeSpec = { id: "finish", label: "妆效", strict: true, values: ["哑光", "珠光", "大闪"] };
const FINISH_SETTING: AttributeSpec = { id: "finish", label: "妆效", strict: true, values: ["哑光", "微光"] };
const FINISH_SKIN: AttributeSpec = { id: "finish", label: "妆效", strict: true, values: ["雾面", "水光"] };
const FINISH_GLOW: AttributeSpec = { id: "finish", label: "妆效", strict: true, values: ["细闪", "大闪", "湿光"] };

const COVERAGE: AttributeSpec = { id: "coverage", label: "遮盖力", strict: true, values: ["清透", "中等", "高"] };
const PIGMENTATION: AttributeSpec = { id: "pigmentation", label: "显色度", strict: true, values: ["清透", "中等", "浓郁"] };
const COLOR_TEMPERATURE: AttributeSpec = { id: "colorTemperature", label: "色温", strict: true, values: ["冷", "暖", "中性"] };

/** 逐品类的决定性维度。没列出的维度不参与该品类的比对。 */
export const CATEGORY_ATTRIBUTES: Record<KitCategoryId, readonly AttributeSpec[]> = {
  base: [
    COVERAGE,
    FINISH_BASE,
    { id: "longevity", label: "持妆", strict: true, values: ["一般", "持久"] }
  ],
  concealer: [COVERAGE, FINISH_SKIN],
  setting: [
    FINISH_SETTING,
    { id: "oilControl", label: "控油", strict: true, values: ["弱", "中", "强"] }
  ],
  brow: [
    { ...COLOR_FAMILY, values: ["灰", "棕", "黑", "红棕"] },
    { id: "form", label: "形态", strict: true, values: ["笔", "粉", "膏"] }
  ],
  eyeshadow: [COLOR_FAMILY, FINISH_SHADOW, PIGMENTATION],
  eyeliner: [
    { ...COLOR_FAMILY, values: ["黑", "棕", "其他"] },
    { id: "form", label: "形态", strict: true, values: ["笔", "液", "胶"] },
    { id: "waterproof", label: "防水", strict: true, values: ["是", "否"] }
  ],
  mascara: [
    { id: "structure", label: "结构", strict: true, values: ["纤长", "浓密", "卷翘"] },
    { id: "waterproof", label: "防水", strict: true, values: ["是", "否"] }
  ],
  blush: [
    COLOR_FAMILY,
    { id: "texture", label: "质地", strict: true, values: ["粉", "膏", "液"] },
    PIGMENTATION
  ],
  contour: [
    COLOR_TEMPERATURE,
    { id: "texture", label: "质地", strict: true, values: ["粉", "膏"] }
  ],
  highlight: [COLOR_TEMPERATURE, FINISH_GLOW],
  lip: [COLOR_FAMILY, FINISH_LIP, PIGMENTATION],
  /** 工具不参与妆效比对，特点自由记录（规格第 7.2 节）。 */
  tools: []
};

/** 妆感浓淡。派生值，**不落库**——避免和决定性维度互相矛盾。 */
export type LookIntensity = "清透" | "日常" | "浓郁";

export function attributeSpec(categoryId: KitCategoryId, attributeId: KitAttributeId): AttributeSpec | null {
  return CATEGORY_ATTRIBUTES[categoryId].find((spec) => spec.id === attributeId) ?? null;
}

/** 该取值在这个品类下是否算「已按词表填」。开放维度只要非空就算。 */
export function isClosedValue(categoryId: KitCategoryId, attributeId: KitAttributeId, value: string): boolean {
  const spec = attributeSpec(categoryId, attributeId);
  if (!spec) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return spec.strict ? spec.values.includes(trimmed) : true;
}

/** 闭集外的取值不参与妆效比对，但保留原文（写进 `effectTags`）。 */
export function splitByVocabulary(
  categoryId: KitCategoryId,
  attributeId: KitAttributeId,
  value: string
): { known: string | null; raw: string } {
  const trimmed = value.trim();
  if (!trimmed) return { known: null, raw: "" };
  return isClosedValue(categoryId, attributeId, trimmed)
    ? { known: trimmed, raw: trimmed }
    : { known: null, raw: trimmed };
}

/** 浓度维度的取值 → 档位。遮盖力用「高」，显色度用「浓郁」，是同一个档。 */
function intensityFromConcentration(value: string): LookIntensity | null {
  if (value === "清透") return "清透";
  if (value === "中等") return "日常";
  if (value === "浓郁" || value === "高") return "浓郁";
  return null;
}

function firstKnown(attributes: Record<string, string>, ids: KitAttributeId[]): { id: KitAttributeId; value: string } | null {
  for (const id of ids) {
    const value = attributes[id];
    if (typeof value === "string" && value.trim()) return { id, value: value.trim() };
  }
  return null;
}

/**
 * 把决定性维度归到一个妆感浓淡档位上，两侧用**同一条规则**。
 *
 * 「这件底妆是浓妆的还是淡妆的」是需求侧最自然的说法，但它不能独立存——否则
 * 「遮盖力 高」和「浓淡 淡妆」会同时存在并互相矛盾。所以它**由维度派生**，
 * 判定以决定性维度为准：两者不一致时重算 `intensity`，不改维度。
 *
 * `base` 与 `lip` 有额外的妆效条件（规格第 7.2 节的表）；其余品类同构，
 * 只看浓度维度本身。维度未知时返回 `null`——不知道就是不猜。
 */
export function deriveIntensity(
  categoryId: KitCategoryId,
  attributes: Record<string, string | undefined>
): LookIntensity | null {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string" && value.trim()) cleaned[key] = value.trim();
  }

  const concentration = firstKnown(cleaned, ["pigmentation", "coverage"]);
  if (!concentration) return null;

  const base = intensityFromConcentration(concentration.value);
  if (base !== "浓郁") return base;

  // 浓度到顶之后，`base` 还要求妆效雾面或持妆持久，`lip` 还要求哑光或镜面。
  if (categoryId === "base") {
    return cleaned.finish === "雾面" || cleaned.longevity === "持久" ? "浓郁" : "日常";
  }
  if (categoryId === "lip") {
    return cleaned.finish === "哑光" || cleaned.finish === "镜面" ? "浓郁" : "日常";
  }
  return "浓郁";
}

/** 交给判断调用与界面渲染的维度清单（含中文名），避免两处各写一份。 */
export function attributePrompt(categoryId: KitCategoryId): { id: KitAttributeId; label: string; values: readonly string[]; strict: boolean }[] {
  return CATEGORY_ATTRIBUTES[categoryId].map((spec) => ({
    id: spec.id,
    label: spec.label,
    values: spec.values,
    strict: spec.strict
  }));
}

/**
 * 一次编辑之后，每个属性的来源该怎么记。
 *
 * **只有真的被改过的键才转 `user`。** 表单保存时会把所有字段一起提交（用户看到的
 * 是填好的旧值），如果照单全收地标成 `user`，一处小改就会把整条记录变成「用户确认」，
 * 第 6.6 节那条「模型推断的线索」与「用户的声明」的区别当场就没了。
 *
 * - 值变了（含从无到有）→ `user`
 * - 值没变 → 保留原来的来源；原来没有来源就仍然没有（未知就是未知，不猜）
 * - 清空了的键 → 从来源表里去掉（值都没了，留着来源没意义）
 */
export function sourcesAfterEdit(
  previous: Record<string, string>,
  next: Record<string, string | undefined>,
  previousSources: Record<string, AttributeSourceRecord> = {},
  now: string = new Date().toISOString()
): Record<string, AttributeSourceRecord> {
  const sources: Record<string, AttributeSourceRecord> = { ...previousSources };

  for (const [key, rawValue] of Object.entries(next)) {
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!value) {
      delete sources[key];
      continue;
    }
    if (previous[key] === value) continue;
    sources[key] = { source: "user", at: now };
  }

  return sources;
}

/** 品类中文名，界面与提示词共用。 */
export function categoryLabel(categoryId: KitCategoryId): string {
  return findCategory(categoryId).name;
}
