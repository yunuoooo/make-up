// 相对路径 + `.ts`：这条链子会被 pi 的 jiti 加载（`kit-source.ts` → `user-products.ts`
// → 这里），仓库的 `@/*` 别名在那边解析不了。虽然是 `import type`，也不要改回别名。
import type { AttributeSourceRecord } from "../kit/attributes.ts";

// 逐属性来源跟着 `UserProduct` 走，所以在这里一并导出，消费方不用再记一个模块路径。
export type { AttributeSourceRecord };

export type ProductStatus = "owned" | "wishlist" | "retired";

/** 这条记录从哪来。预设与导入都要能认出来，界面才好如实标注（规格第 5.3 / 6.4 节）。 */
export type ProductRecordSource = "preset" | "manual" | "import";

export type UserProduct = {
  id: string;
  userId: string;
  brand: string;
  name: string;
  skuId?: string;
  /** 品类原文。标准品类由 `normalizeCategoryId` 在读的时候归一，**不落库**——映射变了不该让存量数据变味。 */
  category: string;
  shade?: string;
  /**
   * 词表维度的取值（`lib/kit/attributes.ts`）。
   *
   * 下面三个 legacy 顶层字段（`colorFamily` / `finish` / `texture`）与 `attributes` 里的
   * 同名键指同一件事，**写入时镜像**、读取时 `attributes` 优先——存量界面代码
   * （搜索、标签行）还在读顶层字段，等它们都迁完再删。别只写一边。
   */
  attributes?: Record<string, string>;
  /** 逐属性来源。**逐属性**是刻意的：「色号」是查得到的事实，「浓妆还是淡妆」是判断，可信度不同。 */
  attributeSources?: Record<string, AttributeSourceRecord>;
  colorFamily?: string;
  finish?: string;
  texture?: string;
  effectTags: string[];
  status: ProductStatus;
  /** 记录来源；缺省按 `"manual"` 处理，存量数据因此不用迁移。 */
  recordSource?: ProductRecordSource;
  rating?: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};


export type SourceItem = {
  id: string;
  sourceType: "xhs_account_search" | "xhs_note" | "pasted_text" | "manual_seed";
  sourceUrl?: string;
  searchQuery: string;
  xhsAccountId?: string;
  title: string;
  author: string;
  rawText: string;
  summary: string;
  metadata: Record<string, string | number | boolean>;
  createdAt: string;
};

export type EvidenceItem = {
  id: string;
  sourceItemId: string;
  lookFeatures: string[];
  skuMentions: string[];
  categoryPatterns: string[];
  confidence: number;
  createdAt: string;
};

export type LookFeatureSet = {
  overallStyle: string;
  base: string[];
  eyes: string[];
  brows: string[];
  cheeks: string[];
  lips: string[];
  colors: string[];
  texture: string[];
  focus: string[];
  neededCapabilities: ProductCapability[];
  difficulty: string[];
  uncertainty: string[];
};

export type ProductCapability = {
  category: string;
  capability: string;
  reason: string;
  priority: "necessary" | "helpful" | "optional";
  tags: string[];
};

export type SkuCandidate = {
  id: string;
  brand: string;
  name: string;
  skuId: string;
  category: string;
  shade?: string;
  colorFamily?: string;
  finish?: string;
  texture?: string;
  effectTags: string[];
  price?: string;
  channel?: string;
  purchaseUrl?: string;
  evidenceSummary: string;
  rank: number;
  capabilityTags: string[];
  priority: "necessary" | "helpful" | "optional";
  reason: string;
  offerStatus: "live" | "placeholder";
};

export type SearchPlan = {
  isClearEnough: boolean;
  intentSummary: string;
  xhsQuery: string;
  taobaoQueries: string[];
  clarificationQuestion?: string;
  assumptions: string[];
};

export type OwnedProductMatch = {
  reviewed: boolean;
  usableItems: UserProduct[];
  partialMatches: UserProduct[];
  notSuitable: UserProduct[];
  missingCapabilities: ProductCapability[];
  riskNotes: string[];
};

export type ToolRun = {
  id: string;
  conversationId: string;
  messageId: string;
  userId: string;
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  status: "queued" | "running" | "succeeded" | "failed";
  latencyMs: number;
  error?: string;
  createdAt: string;
};

export type AgentAnswer = {
  id: string;
  conversationId: string;
  messageId: string;
  userId: string;
  taskType: string;
  answerText: string;
  lookFeatures: LookFeatureSet;
  searchPlan: SearchPlan;
  sources: SourceItem[];
  evidence: EvidenceItem[];
  skuCandidates: SkuCandidate[];
  ownedProductMatch: OwnedProductMatch;
  toolRuns: ToolRun[];
};

export type ChatRequest = {
  message: string;
  userId?: string;
  conversationId?: string;
};
