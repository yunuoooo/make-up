import { makeId } from "@/lib/storage/json-store";
import type { EvidenceItem, SourceItem } from "@/lib/types/domain";

type XhsPreset = {
  keywords: string[];
  title: string;
  summary: string;
  features: string[];
  skus: string[];
  categories: string[];
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

export async function searchXhsEvidence(query: string, conversationId: string): Promise<{
  sources: SourceItem[];
  evidence: EvidenceItem[];
}> {
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
        mode: process.env.XHS_SOURCE_MODE || "mock",
        conversationId,
        queryStrategy: "intent_specific"
      },
      createdAt: now
    },
    {
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
    }
  ];

  const evidence: EvidenceItem[] = sources.map((source, index) => ({
    id: makeId("ev"),
    sourceItemId: source.id,
    lookFeatures: preset.features,
    skuMentions: preset.skus,
    categoryPatterns: preset.categories,
    confidence: index === 0 ? 0.82 : 0.68,
    createdAt: now
  }));

  return { sources, evidence };
}
