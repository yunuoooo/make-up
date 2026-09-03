import { searchXhsEvidence } from "@/lib/adapters/xhs";
import { hydrateTaobaoOffers } from "@/lib/adapters/taobao";
import { decomposeLook, matchOwnedProducts, recommendSkuCandidates } from "@/lib/agent/recommendation";
import { appendToolRuns } from "@/lib/storage/tool-runs";
import { listUserProducts } from "@/lib/storage/user-products";
import { makeId } from "@/lib/storage/json-store";
import type { AgentAnswer, ChatRequest, ToolRun } from "@/lib/types/domain";

function classifyTask(message: string): string {
  if (/我有|手里|已有|妆匣|替代|不用买/.test(message)) return "owned_product_match";
  if (/买|推荐|SKU|产品|用什么|准备什么|靠什么/.test(message)) return "sku_recommendation";
  return "look_decomposition";
}

function makeRun(
  conversationId: string,
  messageId: string,
  userId: string,
  toolName: string,
  inputSummary: string,
  outputSummary: string,
  startedAt: number,
  status: ToolRun["status"] = "succeeded"
): ToolRun {
  return {
    id: makeId("run"),
    conversationId,
    messageId,
    userId,
    toolName,
    inputSummary,
    outputSummary,
    status,
    latencyMs: Date.now() - startedAt,
    createdAt: new Date().toISOString()
  };
}

function composeAnswer(answer: Omit<AgentAnswer, "answerText">): string {
  const { lookFeatures, skuCandidates, ownedProductMatch, sources } = answer;
  const topSkus = skuCandidates.slice(0, 5);
  const required = lookFeatures.neededCapabilities.filter((capability) => capability.priority === "necessary");
  const missing = ownedProductMatch.missingCapabilities;

  const lines = [
    `我先按「${lookFeatures.overallStyle}」来拆。`,
    "",
    "来源共同点：不要照搬单个博主清单；小红书资料和种子规则会先抽象品类能力，再落到 SKU。",
    "",
    "妆容特点：",
    `- 底妆：${lookFeatures.base.join("、")}`,
    `- 眼眉：${[...lookFeatures.eyes, ...lookFeatures.brows].slice(0, 5).join("、")}`,
    `- 腮红/唇部：${[...lookFeatures.cheeks, ...lookFeatures.lips].slice(0, 5).join("、")}`,
    `- 质地和重心：${[...lookFeatures.texture, ...lookFeatures.focus].slice(0, 5).join("、")}`,
    "",
    "需要的产品能力：",
    ...required.map((item) => `- ${item.category}：${item.capability}`),
    "",
    ownedProductMatch.reviewed
      ? `我看了你的妆匣：可直接用 ${ownedProductMatch.usableItems.length} 个，勉强可替 ${ownedProductMatch.partialMatches.length} 个，还缺 ${missing.length} 类能力。`
      : "你现在还没有录入妆匣，所以我直接按目标妆效给 SKU 候选。",
    "",
    "SKU 候选：",
    ...topSkus.map((sku) => {
      const offer = sku.offerStatus === "live" && sku.purchaseUrl
        ? `${sku.price} · ${sku.channel} · ${sku.purchaseUrl}`
        : "价格/渠道/购买链接待淘宝 API 接入";
      return `- ${sku.brand} ${sku.name}${sku.shade ? `（${sku.shade}）` : ""}：${sku.reason}；${offer}`;
    }),
    "",
    "小红书依据：",
    ...sources.slice(0, 2).map((source) => `- ${source.title}：${source.summary}`),
    "",
    "边界：我可以帮你做妆容遮盖和产品选择，但这不是医疗建议；如果是持续泛红、刺痛或皮肤问题，应优先看皮肤科。",
    "",
    `不确定点：${lookFeatures.uncertainty.join("；")}`
  ];

  return lines.join("\n");
}

export async function runLooktraceAgent(request: ChatRequest): Promise<AgentAnswer> {
  const userId = request.userId || "local-user";
  const conversationId = request.conversationId || makeId("conv");
  const messageId = makeId("msg");
  const toolRuns: ToolRun[] = [];

  const taskType = classifyTask(request.message);

  let start = Date.now();
  const { sources, evidence } = await searchXhsEvidence(request.message, conversationId);
  toolRuns.push(makeRun(
    conversationId,
    messageId,
    userId,
    "xhs_evidence_review",
    request.message,
    `读取 ${sources.length} 条来源，抽取 ${evidence.flatMap((item) => item.skuMentions).length} 个 SKU 提及`,
    start
  ));

  start = Date.now();
  const lookFeatures = decomposeLook(request.message, sources, evidence);
  toolRuns.push(makeRun(
    conversationId,
    messageId,
    userId,
    "look_decomposition",
    request.message,
    `${lookFeatures.overallStyle}，${lookFeatures.neededCapabilities.length} 个产品能力`,
    start
  ));

  start = Date.now();
  const candidates = recommendSkuCandidates(lookFeatures, evidence);
  toolRuns.push(makeRun(
    conversationId,
    messageId,
    userId,
    "sku_recommendation",
    lookFeatures.overallStyle,
    `${candidates.length} 个 SKU 候选`,
    start
  ));

  start = Date.now();
  const hydratedCandidates = await hydrateTaobaoOffers(candidates);
  toolRuns.push(makeRun(
    conversationId,
    messageId,
    userId,
    "taobao_offer_hydration",
    `${candidates.length} 个 SKU`,
    process.env.TAOBAO_API_KEY ? "已请求淘宝 API" : "淘宝 API 未配置，返回占位状态",
    start
  ));

  start = Date.now();
  const userProducts = await listUserProducts(userId);
  const ownedProductMatch = matchOwnedProducts(userProducts, lookFeatures);
  toolRuns.push(makeRun(
    conversationId,
    messageId,
    userId,
    "owned_product_match",
    `${userProducts.length} 个妆匣产品`,
    ownedProductMatch.reviewed ? `${ownedProductMatch.usableItems.length} 个可用，${ownedProductMatch.missingCapabilities.length} 个缺口` : "无妆匣，跳过匹配",
    start
  ));

  const answerWithoutText: Omit<AgentAnswer, "answerText"> = {
    id: makeId("ans"),
    conversationId,
    messageId,
    userId,
    taskType,
    lookFeatures,
    sources,
    evidence,
    skuCandidates: hydratedCandidates,
    ownedProductMatch,
    toolRuns
  };

  const answer: AgentAnswer = {
    ...answerWithoutText,
    answerText: composeAnswer(answerWithoutText)
  };

  await appendToolRuns(toolRuns);
  return answer;
}
