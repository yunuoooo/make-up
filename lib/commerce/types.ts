/**
 * 商品卡片的前后端共用类型。
 *
 * 这里只有类型、没有运行时依赖：客户端组件用 `import type` 引用它，
 * 一旦引入 fs/process 之类的东西，前端打包就会断。
 * 上游字段与错误码的来源见 docs/specs/09-21-justoneapi-taobao-ssot.md。
 */

export type ProductSection = "necessary" | "optional";

/** 技能在答案末尾输出的机器可读商品清单里的一条。 */
export type ProductRef = {
  category: string;
  brand: string;
  name: string;
  shade?: string;
  section: ProductSection;
};

/** 淘宝搜索结果条目。 */
export type TaobaoSearchItem = {
  numIid: string;
  title: string;
  /** 主图，已升级为 https；上游 uprightImg 与 pic_path 都可能为空。 */
  picUrl?: string;
  price?: string;
  shop?: string;
  /** 上游 isP4p === "true" 表示广告位，不作为卡片首选。 */
  isP4p: boolean;
};

/** 淘宝商品详情。 */
export type TaobaoItemDetail = {
  numIid: string;
  title: string;
  /** 图组，已补 https；消费方只取 [0]。 */
  images: string[];
  price?: string;
  /** 商品详情页地址，卡片链接的正规来源。 */
  detailUrl?: string;
  shop?: string;
};

export type ProductCardDetailLevel = "detail" | "search";

export type ProductCard = {
  id: string;
  category: string;
  brand: string;
  name: string;
  shade?: string;
  section: ProductSection;
  /** 淘宝商品标题。 */
  title: string;
  image?: string;
  /** 淘宝挂牌价字符串，不做数值换算。 */
  price?: string;
  shop?: string;
  purchaseUrl: string;
  /** 图与链接来自详情接口（detail）还是搜索回退（search）。 */
  detailLevel: ProductCardDetailLevel;
};

export type ProductCardFailure = {
  brand: string;
  name: string;
  reason: string;
};

/** 卡片缓存：key 是归一化的 品牌|品名|色号。实现可以是内存也可以落盘。 */
export type ProductCardsCache = {
  get(key: string): ProductCard | undefined;
  set(key: string, card: ProductCard): void;
};

export type ProductCardsStatus = "ok" | "partial" | "unavailable";

/** SSE 事件体：渐进式发出，前端按 id 合并。 */
export type ProductCardsEvent = {
  phase: "pending" | "items" | "done";
  /** pending：本轮共几件要补全。 */
  expected?: number;
  /** pending：骨架卡上的品类文字，顺序与商品清单一致。 */
  categories?: string[];
  /** items：本次解析出的卡片（同 id 再次出现表示覆盖升级）。 */
  items?: ProductCard[];
  failed?: ProductCardFailure[];
  /** 仅 done 时给。 */
  status?: ProductCardsStatus;
};

/** 合并后挂在 turn 上、并随对话进 localStorage 的结果。 */
export type ProductCardsState = {
  status: ProductCardsStatus | "pending";
  expected: number;
  /** 待补全商品的品类，顺序与清单一致；骨架卡用它对号入座。 */
  categories: string[];
  items: ProductCard[];
  failed: ProductCardFailure[];
};
