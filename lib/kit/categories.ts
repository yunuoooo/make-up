/**
 * 妆匣的品类 SSOT：`categoryId` + 标准一级中文名 + 用户习惯叫法。
 *
 * 三处消费者共用这一份：前端筛选（`frontend/lib/constants.ts` 的 `CATEGORY_OPTIONS`
 * 从这里派生）、工具层的归一化、技能文本（`makeup-kit/references/categories.md` 保留
 * 可读对照表并注明以本文件为准，见规格 `docs/specs/10-16-makeup-kit.md` 第 7 节）。
 *
 * **零依赖是刻意的**：pi 用 jiti 加载扩展，仓库的 `@/*` 别名在扩展里解析不了
 * （先例：`.pi/extensions/xhs-source.ts` 一律用相对路径 + 显式 `.ts`）。
 * 改这个文件时不要引入任何 import。
 *
 * 注意「眉笔」这个一级名称在内部代表**整个眉部产品组**，不是只收眉笔
 * （`categories.md` 特意点名过）。
 */

export type KitCategoryId =
  | "base"
  | "concealer"
  | "setting"
  | "brow"
  | "eyeshadow"
  | "eyeliner"
  | "mascara"
  | "blush"
  | "contour"
  | "highlight"
  | "lip"
  | "tools";

export type KitCategory = {
  categoryId: KitCategoryId;
  /** 标准一级中文名。与 `CATEGORY_OPTIONS` 完全一致，前端筛选项就是这一列。 */
  name: string;
  /** 具体类型与常见输入别名。归一化只做精确匹配（含去括号），不做模糊包含。 */
  aliases: readonly string[];
};

/**
 * 顺序即 `CATEGORY_OPTIONS` 的顺序，**不要重排**：前端筛选与历史数据都依赖它。
 */
export const KIT_CATEGORIES: readonly KitCategory[] = [
  {
    categoryId: "base",
    name: "底妆",
    aliases: ["粉底", "粉底液", "粉底霜", "气垫", "有色底妆", "妆前乳", "隔离霜", "素颜霜"]
  },
  {
    categoryId: "concealer",
    name: "遮瑕",
    aliases: ["遮瑕液", "遮瑕膏", "遮瑕盘", "遮瑕笔", "校色", "校色盘"]
  },
  {
    categoryId: "setting",
    name: "定妆",
    aliases: ["散粉", "蜜粉", "定妆粉", "定妆粉饼", "定妆喷雾", "蜜粉饼"]
  },
  {
    categoryId: "brow",
    name: "眉笔",
    aliases: ["眉妆", "眉粉", "眉膏", "染眉膏", "眉胶", "眉蜡", "眉毛定型", "眉部产品"]
  },
  {
    categoryId: "eyeshadow",
    name: "眼影",
    aliases: ["单色眼影", "眼影盘", "眼影液", "眼影膏", "眼影笔", "眼影棒"]
  },
  {
    categoryId: "eyeliner",
    name: "眼线",
    aliases: ["眼线笔", "眼线液", "眼线液笔", "眼线胶", "眼线胶笔", "眼线膏"]
  },
  {
    categoryId: "mascara",
    name: "睫毛膏",
    aliases: ["睫毛打底", "睫毛底膏", "纤长睫毛膏", "浓密睫毛膏", "卷翘睫毛膏", "睫毛雨衣"]
  },
  {
    categoryId: "blush",
    name: "腮红",
    aliases: ["腮红粉", "腮红膏", "腮红液", "腮红盘", "腮红笔", "胭脂"]
  },
  {
    categoryId: "contour",
    name: "修容",
    aliases: ["修容粉", "修容棒", "修容膏", "阴影", "阴影粉", "鼻影", "古铜", "古铜粉"]
  },
  {
    categoryId: "highlight",
    name: "高光",
    aliases: ["高光粉", "高光棒", "高光液", "高光膏", "提亮"]
  },
  {
    categoryId: "lip",
    name: "唇妆",
    aliases: ["口红", "唇膏", "唇釉", "唇蜜", "唇彩", "唇泥", "唇线笔", "唇笔", "唇部产品", "染唇液"]
  },
  {
    categoryId: "tools",
    name: "工具",
    aliases: ["刷具", "刷子", "化妆刷", "海绵", "美妆蛋", "粉扑", "睫毛夹", "假睫毛", "睫毛胶", "双眼皮贴", "化妆工具"]
  }
];

/** `CATEGORY_OPTIONS` 的来源。改这里等于改前端筛选项。 */
export const KIT_CATEGORY_NAMES: readonly string[] = KIT_CATEGORIES.map((category) => category.name);

export function isKitCategoryId(value: unknown): value is KitCategoryId {
  return typeof value === "string" && KIT_CATEGORIES.some((category) => category.categoryId === value);
}

export function findCategory(categoryId: KitCategoryId): KitCategory {
  const found = KIT_CATEGORIES.find((category) => category.categoryId === categoryId);
  if (!found) throw new Error(`未知的 categoryId：${categoryId}`);
  return found;
}

/** 归一化时统一：去空白、全角括号折半角、拉丁字母小写。 */
function fold(value: string): string {
  return value
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** 去掉结尾的括注：「唇妆（口红）」→「唇妆」。只去一层，且只在结尾。 */
function stripTrailingParen(value: string): string {
  return value.replace(/\([^()]*\)$/, "");
}

/**
 * 把用户或推荐文案里的品类原文归一到标准品类；认不出时返回 `null`。
 *
 * **`null` 不等于丢弃**：调用方要保留原文当「待归类候选」（`categories.md` 使用规则第 5 条）。
 * 「粉饼」这类按字面分不出底妆还是定妆的，就该返回 `null`，不能猜。
 *
 * 只做精确匹配（categoryId / 中文名 / 别名，含去结尾括注后重试一次），
 * **不做包含匹配**——「粉饼」包含「粉」不代表它是底妆。
 */
export function normalizeCategoryId(raw: string | null | undefined): KitCategoryId | null {
  if (typeof raw !== "string") return null;
  const folded = fold(raw);
  if (!folded) return null;

  for (const candidate of [folded, stripTrailingParen(folded)]) {
    if (!candidate) continue;
    for (const category of KIT_CATEGORIES) {
      if (candidate === fold(category.categoryId) || candidate === fold(category.name)) {
        return category.categoryId;
      }
      if (category.aliases.some((alias) => candidate === fold(alias))) {
        return category.categoryId;
      }
    }
  }

  return null;
}
