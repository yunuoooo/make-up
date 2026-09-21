export type Product = {
  id: number;
  brand: string;
  name: string;
  category: string;
  shade: string;
  finish: string;
  tags: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type ConversationSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type RecommendationProduct = {
  status: "owned" | "buy";
  label: string;
  evidence: "个人妆品库匹配" | "特征匹配·演示候选";
  image: string;
  imageAlt: string;
  taobaoUrl: string;
};

export type RecommendationRow = {
  area: string;
  target: string;
  method: string;
  guidance: string;
  products: RecommendationProduct[];
};

export type AdvisorReply = {
  styleName: string;
  summary: string;
  researchNotice: string;
  image?: string;
  necessary: RecommendationRow[];
  optional: RecommendationRow[];
  steps: string[];
  followUp: string;
  sources: string[];
};

export type ChatMessage = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  reply: AdvisorReply | null;
  createdAt: string;
};
