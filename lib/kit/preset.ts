import { createUserProducts, listAllUserProducts } from "../storage/user-products.ts";
import { readJson, writeJson } from "../storage/json-store.ts";
import { PRESET_KIT, type PresetProduct } from "./preset-data.ts";
import { normalizeCategoryId } from "./categories.ts";

/**
 * 预设妆匣的播种。
 *
 * 为什么要有它：空妆匣下「复用已有单品」这条主路径演示不出来，而 Agent 是只读的
 * （不会替用户建档）。播种让新用户第一次打开就有东西可核对。
 *
 * 为什么是**落库**而不是让模型假装：`makeup-kit/SKILL.md:17` 要求持有候选必须是
 * 「用户声明**或其妆匣记录确认持有**」。写进用户自己的妆匣之后，这条字面成立，
 * `✅` 不是谎言。代价由界面承担——常驻提示条说明这是示例妆匣，可编辑或一键清空。
 *
 * 规格：`docs/specs/10-16-makeup-kit.md` 第 5 节。
 */

const STATE_FILE = "kit-state.json";

export type KitState = {
  /** 每个用户是否已经播过种。**已播过就永不再播**，见下面 ensurePresetSeeded 的注释。 */
  presetSeeded?: Record<string, boolean>;
};

export function presetEnabled(env: Record<string, string | undefined> = process.env): boolean {
  // 与 TAOBAO_CARDS_ENABLED 同一套口径：只有明确的 true / 1 才算打开。
  const value = (env.KIT_PRESET_ENABLED ?? "").trim().toLowerCase();
  return value === "true" || value === "1";
}

function toInput(product: PresetProduct) {
  const categoryId = normalizeCategoryId(product.category);
  if (!categoryId) throw new Error(`预设妆匣的品类认不出来：${product.category}`);
  return {
    brand: product.brand,
    name: product.name,
    category: product.category,
    shade: product.shade,
    attributes: product.attributes,
    // 预设的特点是策展时按官方页核实过的，这是 search-verified 唯一的来源
    // （运行时不会产生它，因为 Agent 不回写）。
    attributeSources: Object.fromEntries(
      Object.keys(product.attributes).map((key) => [key, { source: "search-verified" as const }])
    ),
    recordSource: "preset" as const,
    status: "owned" as const
  };
}

export type SeedResult = {
  /** 本次实际写入的条数。 */
  seeded: number;
  /** 跳过播种的原因，供调用方与测试对账。 */
  skipped?: "disabled" | "already-seeded" | "kit-not-empty" | "no-preset-content";
};

/**
 * 空妆匣时播种预设套件。幂等。
 *
 * **判断「播过没有」必须用独立标记文件，不能只看库空不空**：用户把示例清空之后库
 * 又是空的，只看库就会再播一次，用户会以为删除失效。标记与 `user-products.json`
 * 同目录，随 `LOOKTRACE_DATA_DIR` 走——生产上那个目录在发布树外面，所以每次发版
 * 都不会重播。
 */
export async function ensurePresetSeeded(
  userId: string,
  options: { kit?: readonly PresetProduct[]; enabled?: boolean } = {}
): Promise<SeedResult> {
  const enabled = options.enabled ?? presetEnabled();
  if (!enabled) return { seeded: 0, skipped: "disabled" };

  const preset = options.kit ?? PRESET_KIT;
  // 内容还没核实完时不播种：宁可是空妆匣，也不能把编造的商品当成用户持有。
  if (preset.length === 0) return { seeded: 0, skipped: "no-preset-content" };

  const state = await readJson<KitState>(STATE_FILE, {});
  if (state.presetSeeded?.[userId]) return { seeded: 0, skipped: "already-seeded" };

  // 播种判断用全量（含 retired）：退役记录也是用户的痕迹，不能当成空库。
  const existing = await listAllUserProducts(userId);
  if (existing.length > 0) {
    // 用户自己已经录过了——只记标记，不覆盖。
    await markSeeded(state, userId);
    return { seeded: 0, skipped: "kit-not-empty" };
  }

  const created = await createUserProducts(userId, preset.map(toInput));
  await markSeeded(state, userId);
  return { seeded: created.length };
}

async function markSeeded(state: KitState, userId: string): Promise<void> {
  const next: KitState = {
    ...state,
    presetSeeded: { ...(state.presetSeeded ?? {}), [userId]: true }
  };
  await writeJson(STATE_FILE, next);
}
