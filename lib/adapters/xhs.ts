import { makeId } from "@/lib/storage/json-store";
import type { EvidenceItem, SourceItem } from "@/lib/types/domain";
import { searchXhsWithLocalBrowser } from "@/lib/adapters/xhs-local-browser";

type XhsPreset = {
  keywords: string[];
  title: string;
  summary: string;
  features: string[];
  skus: string[];
  categories: string[];
};

type XhsSearchResult = {
  sources: SourceItem[];
  evidence: EvidenceItem[];
};

type OfficialSourcePayload = {
  title?: string;
  author?: string;
  sourceUrl?: string;
  rawText?: string;
  summary?: string;
  lookFeatures?: string[];
  skuMentions?: string[];
  categoryPatterns?: string[];
};

const presets: XhsPreset[] = [
  {
    keywords: ["白开水", "清透", "低饱和", "妈生"],
    title: "低饱和白开水妆：干净底妆和裸粉色系",
    summary: "多篇笔记强调薄透底妆、低饱和腮红、灰棕眉眼和裸粉/豆沙唇，产品重点不在强显色，而在低存在感和边界干净。",
    features: ["低饱和", "薄透底妆", "干净边界", "裸粉腮红", "灰棕眉眼", "豆沙唇"],
    skus: ["低遮瑕持妆粉底液", "奶杏裸粉腮红", "灰棕细眉笔", "豆沙唇泥"],
    categories: ["粉底液", "腮红", "眉笔", "唇泥"]
  },
  {
    keywords: ["清冷", "骨相", "灰调", "冷感"],
    title: "清冷骨相妆：灰棕修容和低色彩眼唇",
    summary: "相关笔记共同点是降低彩度、强调面部结构，常见 SKU 集中在灰棕修容、冷粉腮红、细闪眼影和低饱和唇釉。",
    features: ["清冷感", "灰调", "骨相突出", "低彩度", "冷粉腮红", "轮廓收紧"],
    skus: ["灰棕修容盘", "冷粉雾面腮红", "低饱和眼影盘", "灰粉唇釉"],
    categories: ["修容", "腮红", "眼影", "唇釉"]
  },
  {
    keywords: ["雾面", "高级", "通勤", "低饱和"],
    title: "低饱和雾面妆：柔焦底妆和弱光泽色彩",
    summary: "笔记里反复出现柔焦底妆、雾面腮红、低饱和眼影和雾面唇釉，整体避免强珠光和高亮水光。",
    features: ["雾面", "柔焦", "低饱和", "通勤", "边界柔和", "弱光泽"],
    skus: ["柔焦粉底液", "雾面杏粉腮红", "大地色哑光眼影", "雾面豆沙唇釉"],
    categories: ["粉底液", "腮红", "眼影", "唇釉"]
  },
  {
    keywords: ["氛围", "约会", "甜美", "粉"],
    title: "粉调氛围妆：腮红重心和水润唇部",
    summary: "小红书笔记常把氛围感建立在腮红面积、唇部水润度和轻微卧蚕提亮上，SKU 候选更偏粉杏、玫瑰和水光质地。",
    features: ["粉调", "氛围感", "腮红重心", "水润唇", "卧蚕提亮", "柔和轮廓"],
    skus: ["粉杏腮红", "水光玫瑰唇釉", "卧蚕提亮笔", "轻薄粉底液"],
    categories: ["腮红", "唇釉", "卧蚕笔", "粉底液"]
  }
];

const defaultPreset: XhsPreset = {
  keywords: [],
  title: "妆容目标综合搜索：先拆特点再找产品能力",
  summary: "未命中特定妆容词时，系统按底妆、色彩、眼唇重心和质地四条线拆解，再从小红书常见清单中抽象产品能力。",
  features: ["目标拆解", "底妆质地", "色彩重心", "产品能力", "SKU 候选"],
  skus: ["适配目标的粉底液", "匹配色系腮红", "同风格唇釉", "基础眼影盘"],
  categories: ["粉底液", "腮红", "唇釉", "眼影"]
};

function pickPreset(query: string): XhsPreset {
  const normalized = query.toLowerCase();
  const ranked = presets
    .map((preset) => ({
      preset,
      score: preset.keywords.filter((keyword) => normalized.includes(keyword)).length
    }))
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.score > 0 ? ranked[0].preset : defaultPreset;
}

function extractTerms(text: string, terms: string[]): string[] {
  return terms.filter((term) => text.includes(term));
}

function extractSkuMentions(text: string, preset: XhsPreset): string[] {
  const mentions = text.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,24}(粉底液|腮红|眉笔|唇泥|唇釉|修容盘|修容|眼影盘|眼影|卧蚕笔)/g) ?? [];
  return Array.from(new Set([...mentions.slice(0, 8), ...preset.skus]));
}

function buildSeedSource(query: string, preset: XhsPreset, now: string): SourceItem {
  return {
    id: makeId("src"),
    sourceType: "manual_seed",
    searchQuery: query,
    title: "妆容特点到 SKU 的人工种子规则",
    author: "LOOKTRACE seed",
    rawText: `常见品类：${preset.categories.join("、")}；常见 SKU：${preset.skus.join("、")}`,
    summary: "用于在账号池接入前保证文字 MVP 能稳定跑通。",
    metadata: {
      mode: "seed"
    },
    createdAt: now
  };
}

function buildResultFromSources(query: string, conversationId: string, sources: SourceItem[], preset: XhsPreset): XhsSearchResult {
  const allText = sources.map((source) => `${source.rawText} ${source.summary}`).join(" ");
  const features = Array.from(new Set([...extractTerms(allText, preset.features), ...preset.features]));
  const categories = Array.from(new Set([...extractTerms(allText, preset.categories), ...preset.categories]));
  const skus = extractSkuMentions(allText, preset);
  const now = new Date().toISOString();

  return {
    sources,
    evidence: sources.map((source, index) => ({
      id: makeId("ev"),
      sourceItemId: source.id,
      lookFeatures: features,
      skuMentions: skus,
      categoryPatterns: categories,
      confidence: index === 0 ? 0.82 : 0.68,
      createdAt: now
    }))
  };
}

function buildMockResult(query: string, conversationId: string, mode = process.env.XHS_SOURCE_MODE || "mock"): XhsSearchResult {
  const preset = pickPreset(query);
  const now = new Date().toISOString();
  const accountId = process.env.XHS_ACCOUNT_POOL_CONFIG ? "configured-pool" : "mock-account-a";

  const sources: SourceItem[] = [
    {
      id: makeId("src"),
      sourceType: "xhs_account_search",
      searchQuery: query,
      xhsAccountId: accountId,
      title: preset.title,
      author: "小红书账号池",
      rawText: preset.summary,
      summary: preset.summary,
      metadata: {
        mode,
        conversationId,
        queryStrategy: "intent_specific"
      },
      createdAt: now
    },
    buildSeedSource(query, preset, now)
  ];

  return buildResultFromSources(query, conversationId, sources, preset);
}

async function searchXhsOfficialApi(query: string, conversationId: string): Promise<XhsSearchResult> {
  const baseUrl = process.env.XHS_OFFICIAL_API_BASE_URL?.replace(/\/$/, "");
  const apiKey = process.env.XHS_OFFICIAL_API_KEY;

  if (!baseUrl || !apiKey) {
    return buildMockResult(query, conversationId, "official_api_not_configured");
  }

  const response = await fetch(`${baseUrl}/search`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, conversationId })
  });

  if (!response.ok) {
    return buildMockResult(query, conversationId, "official_api_failed");
  }

  const payload = await response.json().catch(() => null) as {
    sources?: OfficialSourcePayload[];
  } | null;
  const preset = pickPreset(query);
  const now = new Date().toISOString();
  const officialSources = payload?.sources?.map((source): SourceItem => ({
    id: makeId("src"),
    sourceType: "xhs_official_api",
    sourceUrl: source.sourceUrl,
    searchQuery: query,
    title: source.title || "小红书官方 API 搜索结果",
    author: source.author || "小红书官方 API",
    rawText: source.rawText || source.summary || "",
    summary: source.summary || source.rawText || "官方 API 返回了结果，但没有摘要字段。",
    metadata: {
      mode: "official_api",
      conversationId,
      queryStrategy: "intent_specific"
    },
    createdAt: now
  })) ?? [];

  if (officialSources.length === 0) {
    return buildMockResult(query, conversationId, "official_api_empty");
  }

  return buildResultFromSources(query, conversationId, [
    ...officialSources.slice(0, 3),
    buildSeedSource(query, preset, now)
  ], preset);
}

async function searchXhsLocalBrowser(query: string, conversationId: string): Promise<XhsSearchResult> {
  const preset = pickPreset(query);
  const now = new Date().toISOString();

  try {
    const result = await searchXhsWithLocalBrowser(query);
    const browserText = [result.rawText, ...result.snippets].filter(Boolean).join("\n");
    const summary = result.loginRequired
      ? "本机小红书浏览器需要先登录或完成验证，已使用人工种子规则兜底。"
      : (result.snippets[0] || result.rawText || "本机小红书搜索完成，但页面文本较少。").slice(0, 260);

    const sources: SourceItem[] = [
      {
        id: makeId("src"),
        sourceType: "xhs_local_browser",
        sourceUrl: result.url,
        searchQuery: query,
        xhsAccountId: "local-browser-profile",
        title: `本机小红书搜索：${query}`,
        author: "本机已登录小红书账号",
        rawText: browserText || summary,
        summary,
        metadata: {
          mode: "local_browser",
          conversationId,
          queryStrategy: "intent_specific",
          noteLinkCount: result.noteLinks.length,
          loginRequired: result.loginRequired
        },
        createdAt: now
      },
      buildSeedSource(query, preset, now)
    ];

    return buildResultFromSources(query, conversationId, sources, preset);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "本机浏览器搜索失败";
    const sources: SourceItem[] = [
      {
        id: makeId("src"),
        sourceType: "xhs_local_browser",
        searchQuery: query,
        xhsAccountId: "local-browser-profile",
        title: "本机小红书搜索未连上",
        author: "LOOKTRACE local browser",
        rawText: errorMessage,
        summary: `本机小红书浏览器暂不可用：${errorMessage}。已使用人工种子规则兜底。`,
        metadata: {
          mode: "local_browser_failed",
          conversationId,
          queryStrategy: "intent_specific"
        },
        createdAt: now
      },
      buildSeedSource(query, preset, now)
    ];

    return buildResultFromSources(query, conversationId, sources, preset);
  }
}

export async function searchXhsEvidence(query: string, conversationId: string): Promise<XhsSearchResult> {
  const mode = process.env.XHS_SOURCE_MODE || "mock";

  if (mode === "local_browser") {
    return searchXhsLocalBrowser(query, conversationId);
  }

  if (mode === "official_api") {
    return searchXhsOfficialApi(query, conversationId);
  }

  return buildMockResult(query, conversationId, mode);
}
