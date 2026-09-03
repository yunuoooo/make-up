import type { SkuCandidate } from "@/lib/types/domain";

const priceByCategory: Record<string, string> = {
  "粉底液": "待淘宝 API 接入",
  "腮红": "待淘宝 API 接入",
  "眉笔": "待淘宝 API 接入",
  "唇泥": "待淘宝 API 接入",
  "唇釉": "待淘宝 API 接入",
  "修容": "待淘宝 API 接入",
  "眼影": "待淘宝 API 接入",
  "卧蚕笔": "待淘宝 API 接入"
};

export async function hydrateTaobaoOffers(candidates: SkuCandidate[]): Promise<SkuCandidate[]> {
  const hasTaobaoConfig = Boolean(process.env.TAOBAO_API_KEY && process.env.TAOBAO_API_SECRET);

  return candidates.map((candidate) => ({
    ...candidate,
    price: hasTaobaoConfig ? candidate.price ?? "淘宝 API 待实现" : priceByCategory[candidate.category] ?? "待淘宝 API 接入",
    channel: hasTaobaoConfig ? "淘宝" : "淘宝 API 占位",
    purchaseUrl: hasTaobaoConfig
      ? candidate.purchaseUrl ?? `https://s.taobao.com/search?q=${encodeURIComponent(`${candidate.brand} ${candidate.name}`)}`
      : undefined,
    offerStatus: hasTaobaoConfig ? "live" : "placeholder"
  }));
}
