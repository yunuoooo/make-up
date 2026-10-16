import type { KitCategoryId } from "./categories.ts";

/**
 * 预设妆匣的内容。
 *
 * **这里现在是空的，是有意的，不是没写完。**
 *
 * 决策 1 让 Agent 把预设条目当作**用户实际持有**并正常标 `✅`，所以每一条都必须是
 * 真实、可核实的商品（真实品牌 + 真实产品线 + 真实色号，特点按官方页核实）。编造的
 * 色号会变成一句「你已经有了这支口红」的假话——比空妆匣更糟。具体选品是内容工作，
 * 见规格 `docs/specs/10-16-makeup-kit.md` 第 5.2 / 12.1 节。
 *
 * 填内容时的硬约束：
 * - 品牌、产品线、色号必须能在品牌官网或可靠零售页查到；
 * - 选长寿款经典色，不选当季联名或易停产款（预设会长期躺在用户妆匣里）；
 * - 覆盖 base / lip / blush / eyeshadow / brow / mascara / setting 七个品类，
 *   每类 1–2 件，总 8–12 件；
 * - `base` **不放粉底色号**（色号强依赖个人肤色，给一个「属于用户」的粉底色号
 *   在语义上就是错的），放妆前乳这类弱色号品类；
 * - 特点只用 `lib/kit/attributes.ts` 里的维度与闭集取值，不写营销话术。
 *
 * 列表为空时 `ensurePresetSeeded` 是空操作，妆匣保持空，`kit_list_products` 返回
 * `empty`，整条链路如实降级。
 */

export type PresetProduct = {
  /** 标准一级品类名（`KIT_CATEGORIES` 的 name）。 */
  category: string;
  brand: string;
  name: string;
  shade?: string;
  /** 维度 → 取值，键取自 `lib/kit/attributes.ts`。 */
  attributes: Record<string, string>;
};

/** 预设套件要覆盖的品类，供内容核对时对账。 */
export const PRESET_REQUIRED_CATEGORIES: readonly KitCategoryId[] = [
  "base",
  "lip",
  "blush",
  "eyeshadow",
  "brow",
  "mascara",
  "setting"
];

export const PRESET_KIT: readonly PresetProduct[] = [];
