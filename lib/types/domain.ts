export type ProductStatus = "owned" | "wishlist" | "retired";

export type UserProduct = {
  id: string;
  userId: string;
  brand: string;
  name: string;
  skuId?: string;
  category: string;
  shade?: string;
  colorFamily?: string;
  finish?: string;
  texture?: string;
  effectTags: string[];
  status: ProductStatus;
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
