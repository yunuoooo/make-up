import crypto from "node:crypto";
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

type TaobaoAdapterStatus = {
  mode: "placeholder" | "live";
  reason: string;
};

type TaobaoConfig = {
  appKey: string;
  appSecret: string;
  adzoneId: string;
  endpoint: string;
  signMethod: "md5" | "hmac";
};

type UnknownRecord = Record<string, unknown>;

function taobaoSearchUrl(candidate: SkuCandidate): string {
  return `https://s.taobao.com/search?q=${encodeURIComponent([
    candidate.brand,
    candidate.name,
    candidate.shade,
    candidate.category
  ].filter(Boolean).join(" "))}`;
}

function readTaobaoConfig(): TaobaoConfig | null {
  const appKey = process.env.TAOBAO_APP_KEY || process.env.TAOBAO_API_KEY;
  const appSecret = process.env.TAOBAO_APP_SECRET || process.env.TAOBAO_API_SECRET;
  const adzoneId = process.env.TAOBAO_ADZONE_ID;

  if (!appKey || !appSecret || !adzoneId) return null;

  return {
    appKey,
    appSecret,
    adzoneId,
    endpoint: process.env.TAOBAO_API_ENDPOINT || "https://eco.taobao.com/router/rest",
    signMethod: process.env.TAOBAO_SIGN_METHOD === "hmac" ? "hmac" : "md5"
  };
}

export function getTaobaoAdapterStatus(): TaobaoAdapterStatus {
  const appKey = process.env.TAOBAO_APP_KEY || process.env.TAOBAO_API_KEY;
  const appSecret = process.env.TAOBAO_APP_SECRET || process.env.TAOBAO_API_SECRET;

  if (!appKey || !appSecret) {
    return { mode: "placeholder", reason: "淘宝 API 未配置，返回淘宝搜索占位链接" };
  }

  if (!process.env.TAOBAO_ADZONE_ID) {
    return { mode: "placeholder", reason: "淘宝 API 已配置 key，但缺少 TAOBAO_ADZONE_ID，返回搜索占位链接" };
  }

  return { mode: "live", reason: "已请求淘宝客物料搜索 API" };
}

function formatTaobaoTimestamp(date = new Date()): string {
  const chinaTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (value: number) => value.toString().padStart(2, "0");

  return [
    chinaTime.getUTCFullYear(),
    "-",
    pad(chinaTime.getUTCMonth() + 1),
    "-",
    pad(chinaTime.getUTCDate()),
    " ",
    pad(chinaTime.getUTCHours()),
    ":",
    pad(chinaTime.getUTCMinutes()),
    ":",
    pad(chinaTime.getUTCSeconds())
  ].join("");
}

function signTaobaoParams(params: Record<string, string>, config: TaobaoConfig): string {
  const payload = Object.keys(params)
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join("");

  if (config.signMethod === "hmac") {
    return crypto.createHmac("md5", config.appSecret).update(payload).digest("hex").toUpperCase();
  }

  return crypto.createHash("md5").update(`${config.appSecret}${payload}${config.appSecret}`).digest("hex").toUpperCase();
}

async function callTaobaoApi(method: string, businessParams: Record<string, string>, config: TaobaoConfig): Promise<unknown> {
  const params: Record<string, string> = {
    method,
    app_key: config.appKey,
    timestamp: formatTaobaoTimestamp(),
    format: "json",
    v: "2.0",
    sign_method: config.signMethod,
    simplify: "true",
    ...businessParams
  };
  params.sign = signTaobaoParams(params, config);

  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: new URLSearchParams(params)
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`淘宝 API HTTP ${response.status}`);
  }

  const errorResponse = isRecord(payload) ? payload.error_response : undefined;
  if (isRecord(errorResponse)) {
    throw new Error(String(errorResponse.msg ?? errorResponse.sub_msg ?? "淘宝 API 返回错误"));
  }

  return payload;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function asRecordArray(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function extractMaterialItems(payload: unknown): UnknownRecord[] {
  if (!isRecord(payload)) return [];

  const response = isRecord(payload.tbk_dg_material_optional_response)
    ? payload.tbk_dg_material_optional_response
    : payload;
  const resultList = isRecord(response.result_list) ? response.result_list : response.resultList;

  if (isRecord(resultList)) {
    const mapData = resultList.map_data ?? resultList.mapData;
    const directItems = asRecordArray(mapData);
    if (directItems.length > 0) return directItems;
  }

  return asRecordArray(response.map_data ?? response.mapData ?? response.result_list);
}

function makeTaobaoQuery(candidate: SkuCandidate): string {
  return [
    candidate.brand,
    candidate.name,
    candidate.shade,
    candidate.category
  ].filter(Boolean).join(" ");
}

function normalizeTaobaoOffer(item: UnknownRecord, fallbackUrl: string): {
  title?: string;
  price?: string;
  channel?: string;
  purchaseUrl?: string;
} {
  const price = getString(item, ["zk_final_price", "final_price", "reserve_price", "price"]);
  const userType = getString(item, ["user_type", "userType"]);
  const title = getString(item, ["title", "short_title", "item_description"]);
  const purchaseUrl = getString(item, ["coupon_click_url", "click_url", "item_url", "url"]) ?? fallbackUrl;

  return {
    title,
    price: price ? `¥${price}` : undefined,
    channel: userType === "1" ? "天猫" : "淘宝",
    purchaseUrl
  };
}

async function hydrateCandidateWithTaobao(candidate: SkuCandidate, config: TaobaoConfig): Promise<SkuCandidate> {
  const fallbackUrl = taobaoSearchUrl(candidate);
  const payload = await callTaobaoApi("taobao.tbk.dg.material.optional", {
    q: makeTaobaoQuery(candidate),
    adzone_id: config.adzoneId,
    page_no: "1",
    page_size: "10",
    platform: "1",
    sort: "total_sales_des"
  }, config);

  const [firstItem] = extractMaterialItems(payload);
  if (!firstItem) {
    return {
      ...candidate,
      price: candidate.price ?? "淘宝 API 未返回匹配价格",
      channel: "淘宝",
      purchaseUrl: candidate.purchaseUrl ?? fallbackUrl,
      offerStatus: "placeholder"
    };
  }

  const offer = normalizeTaobaoOffer(firstItem, fallbackUrl);

  return {
    ...candidate,
    name: candidate.name || offer.title || candidate.name,
    price: offer.price ?? candidate.price ?? "淘宝 API 未返回价格",
    channel: offer.channel ?? "淘宝",
    purchaseUrl: offer.purchaseUrl ?? fallbackUrl,
    offerStatus: offer.price ? "live" : "placeholder"
  };
}

export async function hydrateTaobaoOffers(candidates: SkuCandidate[]): Promise<SkuCandidate[]> {
  const config = readTaobaoConfig();

  if (!config) {
    return candidates.map((candidate) => ({
      ...candidate,
      price: priceByCategory[candidate.category] ?? "待淘宝 API 接入",
      channel: "淘宝搜索占位",
      purchaseUrl: candidate.purchaseUrl ?? taobaoSearchUrl(candidate),
      offerStatus: "placeholder"
    }));
  }

  const hydrated = await Promise.all(candidates.map(async (candidate) => {
    try {
      return await hydrateCandidateWithTaobao(candidate, config);
    } catch {
      return {
        ...candidate,
        price: candidate.price ?? priceByCategory[candidate.category] ?? "淘宝 API 查询失败",
        channel: "淘宝搜索占位",
        purchaseUrl: candidate.purchaseUrl ?? taobaoSearchUrl(candidate),
        offerStatus: "placeholder" as const
      };
    }
  }));

  return hydrated;
}
