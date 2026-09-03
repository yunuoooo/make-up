import type { SearchPlan } from "@/lib/types/domain";

const styleTerms = ["白开水", "清透", "低饱和", "妈生", "清冷", "骨相", "灰调", "冷感", "雾面", "高级", "通勤", "氛围", "约会", "甜美", "淡妆"];
const effectTerms = ["不显脏", "干净", "自然", "柔焦", "水润", "哑光", "显气色", "消肿", "提亮", "轮廓", "幼态", "成熟"];
const productTerms = ["粉底", "底妆", "腮红", "眉", "唇", "口红", "唇釉", "唇泥", "修容", "眼影", "卧蚕"];
const genericRequests = ["推荐一下", "给我推荐", "买什么", "化妆品", "想化妆", "好看一点"];
const medicalTerms = ["治好", "治疗", "皮肤问题", "泛红严重", "刺痛", "过敏", "烂脸", "皮肤病"];

function uniqueTerms(message: string, terms: string[]): string[] {
  return terms.filter((term) => message.includes(term));
}

function cleanQuery(message: string): string {
  return message
    .replace(/小红书/g, "")
    .replace(/搜/g, "")
    .replace(/[，。！？!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildSearchPlan(message: string): SearchPlan {
  const trimmed = message.trim();
  const styles = uniqueTerms(trimmed, styleTerms);
  const effects = uniqueTerms(trimmed, effectTerms);
  const products = uniqueTerms(trimmed, productTerms);
  const hasMedicalIntent = medicalTerms.some((term) => trimmed.includes(term));
  const concreteTerms = [...styles, ...effects, ...products];
  const hasOnlyGenericRequest = genericRequests.some((term) => trimmed.includes(term)) && concreteTerms.length === 0;
  const isClearEnough = trimmed.length >= 8 && concreteTerms.length > 0 && !hasOnlyGenericRequest;

  if (hasMedicalIntent && concreteTerms.length === 0) {
    return {
      isClearEnough: false,
      intentSummary: "皮肤问题不能作为妆容 SKU 推荐目标",
      xhsQuery: "",
      taobaoQueries: [],
      clarificationQuestion: "这不是医疗建议，化妆品也不能承诺治好皮肤问题。如果你的目标是遮盖泛红或降低妆面存在感，我需要先确认你想完成的具体妆容目标。",
      assumptions: ["持续泛红、刺痛、过敏等情况应优先看皮肤科。"]
    };
  }

  if (!isClearEnough) {
    return {
      isClearEnough: false,
      intentSummary: "妆容目标还不够明确",
      xhsQuery: "",
      taobaoQueries: [],
      clarificationQuestion: "我需要先确认一个点：你想完成的是哪种妆容目标？比如白开水妆、清冷骨相妆、低饱和通勤妆，或者一个具体场景。",
      assumptions: ["不会在目标不清楚时硬给 SKU，避免变成泛导购。"]
    };
  }

  const baseQuery = cleanQuery(trimmed);
  const xhsTerms = [...new Set([...styles, ...effects, "妆容拆解", "产品清单", "SKU"])]
    .slice(0, 8)
    .join(" ");
  const xhsQuery = xhsTerms || `${baseQuery} 妆容拆解 产品清单 SKU`;

  const taobaoQueries = [
    [...new Set([...styles, ...products, "化妆品"])].slice(0, 6).join(" "),
    [...new Set([...effects, ...products, "色号"])].slice(0, 6).join(" ")
  ].filter(Boolean);

  return {
    isClearEnough: true,
    intentSummary: concreteTerms.length > 0 ? concreteTerms.slice(0, 6).join("、") : baseQuery,
    xhsQuery,
    taobaoQueries: taobaoQueries.length > 0 ? taobaoQueries : [`${baseQuery} 化妆品 SKU`],
    assumptions: [
      "先用小红书找妆容特点和常见产品路径。",
      "再用淘宝按 SKU 或品类关键词补价格、渠道和购买入口。"
    ]
  };
}
