import type { KitCategoryId } from "./categories.ts";

/**
 * 预设妆匣的内容。
 *
 * 决策 1 让 Agent 把预设条目当作**用户实际持有**并正常标 `✅`，所以这里每一条都是
 * **真实存在、逐条核实过**的商品：品牌、产品线、色号能在品牌官网或可靠零售页查到
 * （2026-10-17 逐条核实，来源见 `docs/specs/10-16-makeup-kit.md` 第 5.2 节的记录）。
 * 编造的色号会变成一句「你已经有了这支口红」的假话——比空妆匣更糟。
 *
 * 选品规则（改这个文件前先读）：
 * - **长寿款经典色**，不选当季联名或易停产款：预设会长期躺在用户妆匣里，停产即失效。
 *   核实过程中就是这样剔掉 MAC 生姜高光（Double-Gleam）的——它在多个地区官网已标
 *   inactive，换成了 CEZANNE 的官方定番高光。
 * - 覆盖 base / lip / blush / eyeshadow / brow / mascara / setting 七个必备品类，
 *   另有 contour 与 highlight 让一次完整妆容跑得起来。
 * - **`base` 不放粉底色号**（色号强依赖个人肤色，给一个「属于用户」的粉底色号在语义上
 *   就是错的），放妆前乳这类弱色号品类；定妆与高光也挑不依赖肤色的色号。
 * - 特点只用 `lib/kit/attributes.ts` 里的维度与闭集取值。**不确定的维度就省略**——
 *   省略表示未知，编一个才是错的。
 *
 * 关掉播种用 `KIT_PRESET_ENABLED=false`。
 */

export type PresetProduct = {
  /** 标准一级品类名（`KIT_CATEGORIES` 的 name）。 */
  category: string;
  brand: string;
  name: string;
  /** 没有色号的产品写「不适用」，不是留空——空表示「不知道」，两者含义不同。 */
  shade?: string;
  /** 维度 → 取值，键取自 `lib/kit/attributes.ts`。 */
  attributes: Record<string, string>;
  /** 核实来源，只在文档与排查时用；不进模型上下文。 */
  verifiedFrom?: string;
};

/** 预设套件必须覆盖的品类，供内容核对时对账（有测试钉住）。 */
export const PRESET_REQUIRED_CATEGORIES: readonly KitCategoryId[] = [
  "base",
  "lip",
  "blush",
  "eyeshadow",
  "brow",
  "mascara",
  "setting"
];

export const PRESET_KIT: readonly PresetProduct[] = [
  {
    category: "底妆",
    brand: "Benefit 贝玲妃",
    name: "反孔精英妆前乳（the POREfessional）",
    shade: "不适用",
    attributes: { coverage: "清透", finish: "半哑光" },
    verifiedFrom: "benefitcosmetics.com 官方产品页：半透明打底，主打毛孔修饰与平滑，官方称 12 小时"
  },
  {
    category: "唇妆",
    brand: "MAC 魅可",
    name: "子弹头唇膏 Chili（小辣椒）",
    shade: "Chili",
    attributes: { colorFamily: "砖红", finish: "哑光", pigmentation: "浓郁" },
    verifiedFrom: "maccosmetics.com.tw 官方页：暖砖红，Matte 质地，全球长卖色"
  },
  {
    category: "唇妆",
    brand: "DIOR 迪奥",
    name: "魅惑润唇膏（Addict Lip Glow）",
    shade: "001 粉红色",
    attributes: { colorFamily: "裸粉", finish: "水光", pigmentation: "清透" },
    verifiedFrom: "dior.com 官方页：001 为冷调浅粉，pH 变色润唇膏，官方标注 48 小时保湿"
  },
  {
    category: "腮红",
    brand: "NARS",
    name: "腮红（Powder Blush）",
    shade: "Orgasm",
    attributes: { colorFamily: "蜜桃粉", texture: "粉", pigmentation: "中等" },
    verifiedFrom: "narscosmetics.com 官方色号描述 “Peachy pink with golden shimmer”，可叠加"
  },
  {
    category: "眼影",
    brand: "MAC 魅可",
    name: "单色眼影（Small Eyeshadow）",
    shade: "Omega",
    attributes: { colorFamily: "灰棕", finish: "哑光", pigmentation: "中等" },
    verifiedFrom: "多家零售页与试色汇总：冷调浅灰棕、全哑光，也被当眉粉与鼻影用"
  },
  {
    category: "眉笔",
    brand: "KATE 凯朵",
    name: "3D 造型眉彩饼（Designing Eyebrow 3D）",
    shade: "EX-5 棕色系",
    attributes: { colorFamily: "棕", form: "粉" },
    verifiedFrom: "日本官网与屈臣氏页：EX-5 棕色系适合黑/棕发，浓中淡三色构造"
  },
  {
    category: "睫毛膏",
    brand: "Kiss Me 奇士美",
    name: "花漾美姬 超持久立挺翘长防水睫毛膏（Long Up Mascara）",
    shade: "01 黑",
    attributes: { structure: "纤长", waterproof: "是" },
    verifiedFrom: "kissme.com.tw 官方页：5mm 纤长纤维、防水抗晕，品牌长卖旗舰款"
  },
  {
    category: "定妆",
    brand: "MAKE UP FOR EVER",
    name: "HD Skin 高清无痕定妆蜜粉（Setting Powder）",
    shade: "0.1 提亮焕采",
    attributes: { finish: "哑光", oilControl: "中" },
    verifiedFrom: "官方与丝芙兰页：超微米粉质、柔滑哑光、控油持妆，色号 0.1 为提亮款"
  },
  {
    category: "修容",
    brand: "too cool for school 涂酷",
    name: "美术课三色修容大师（ArtClass by Rodin Shading Master）",
    shade: "#1.5 Neutral 自然中性色",
    attributes: { colorTemperature: "中性", texture: "粉" },
    verifiedFrom: "官方渠道页：#1.5 介于 #01 暖调与 #02 冷调之间，不偏冷暖"
  },
  {
    category: "高光",
    brand: "CEZANNE",
    name: "珠光高光（Pearl Glow Highlight）",
    shade: "01 香槟米",
    attributes: { colorTemperature: "暖", finish: "细闪" },
    verifiedFrom: "日本媒体与 @cosme：官方长卖定番，01 香槟米为主打色"
  }
];
