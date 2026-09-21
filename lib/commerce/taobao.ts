import type { TaobaoItemDetail, TaobaoSearchItem } from "./types.ts";

/**
 * Just One API 聚合中转的适配器。字段名、错误码和超时规则全部来自
 * docs/specs/09-21-justoneapi-taobao-ssot.md——换供应商、换接口版本或字段改名，
 * 只改这个文件，上层不感知。
 *
 * token 走 query 参数，所以这里刻意不把请求 URL 放进任何错误信息或日志。
 */

const DEFAULT_BASE_URL = "https://api.justoneapi.com";
const SEARCH_PATH = "/api/taobao/search-item-list/v2";
const DETAIL_PATH = "/api/taobao/get-item-detail/v3";

/** 限流、配额、余额：重试只会继续烧配额，必须整批停下。 */
export const QUOTA_ERROR_CODES = new Set([302, 303, 601, 602]);
/** 凭据失效、权限不足：整批停下等配置修好。 */
export const AUTH_ERROR_CODES = new Set([100, 600]);

export class TaobaoApiError extends Error {
  readonly code: number;
  readonly requestId?: string;
  readonly retryable: boolean;

  constructor(message: string, options: { code: number; requestId?: string; retryable: boolean }) {
    super(message);
    this.name = "TaobaoApiError";
    this.code = options.code;
    this.requestId = options.requestId;
    this.retryable = options.retryable;
  }

  get quotaLimited(): boolean {
    return QUOTA_ERROR_CODES.has(this.code);
  }

  get authFailed(): boolean {
    return AUTH_ERROR_CODES.has(this.code);
  }
}

export type TaobaoClient = {
  configured: boolean;
  searchItems(keyword: string, options?: { page?: number; signal?: AbortSignal }): Promise<TaobaoSearchItem[]>;
  getItemDetail(itemId: string, options?: { signal?: AbortSignal }): Promise<TaobaoItemDetail | null>;
};

export type TaobaoClientOptions = {
  /** 测试注入，默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 测试注入，默认读 process.env。 */
  env?: Record<string, string | undefined>;
};

/** 上游图片是协议相对地址（//img.alicdn.com/...），也可能给 http，统一补成 https。 */
function normalizeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (trimmed.startsWith("http://")) return `https://${trimmed.slice(7)}`;
  return trimmed.startsWith("https://") ? trimmed : undefined;
}

/** 搜索标题里带 <span class=H>关键词</span> 高亮标签，必须去掉才能上卡片。 */
function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function optionalText(value: unknown): string | undefined {
  const text = cleanText(value);
  return text || undefined;
}

function errorLabel(error: unknown): string {
  const value = error as { name?: string; message?: string } | null;
  if (value?.name === "TimeoutError") return "请求超时";
  if (value?.name === "AbortError") return "请求已取消";
  return value?.message ? "网络错误" : "未知错误";
}

export function createTaobaoClient(options: TaobaoClientOptions = {}): TaobaoClient {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (env.TAOBAO_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const token = (env.TAOBAO_API_TOKEN ?? "").trim();
  const timeoutSeconds = Number(env.TAOBAO_API_TIMEOUT_SECONDS ?? 30);
  const timeoutMs = Math.max(1, Number.isFinite(timeoutSeconds) ? timeoutSeconds : 30) * 1000;
  const configured = Boolean(token);

  async function call(
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (!configured) throw new TaobaoApiError("淘宝 API 未配置 TAOBAO_API_TOKEN", { code: -1, retryable: false });

    const url = new URL(`${baseUrl}${path}`);
    url.searchParams.set("token", token);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const timeout = AbortSignal.timeout(timeoutMs);
    const composedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: composedSignal });
    } catch (error) {
      throw new TaobaoApiError(`${path} ${errorLabel(error)}`, { code: -1, retryable: true });
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    const envelope = (body ?? {}) as { code?: unknown; message?: unknown; requestId?: unknown; data?: unknown };
    // 判据只有业务码：HTTP 200 也可能是失败，4xx/5xx 的响应体同样是这个信封。
    const code = typeof envelope.code === "number" ? envelope.code : -1;
    const requestId = typeof envelope.requestId === "string" ? envelope.requestId : undefined;
    if (code !== 0) {
      const message = typeof envelope.message === "string" && envelope.message ? `：${envelope.message}` : "";
      throw new TaobaoApiError(`${path} 业务失败 code=${code}${message}`, {
        code,
        requestId,
        retryable: code === 301 || response.status >= 500
      });
    }
    return (envelope.data ?? {}) as Record<string, unknown>;
  }

  return {
    configured,

    async searchItems(keyword, searchOptions = {}) {
      // 未配置凭据时整条链路安静降级：不发请求，也不把「未配置」当成错误抛给上层。
      if (!configured) return [];
      const data = await call(
        SEARCH_PATH,
        { keyword, page: String(searchOptions.page ?? 1) },
        searchOptions.signal
      );
      const entries = Array.isArray(data.itemsArray) ? (data.itemsArray as unknown[]) : [];
      const items: TaobaoSearchItem[] = [];
      for (const raw of entries) {
        const entry = (raw ?? {}) as Record<string, any>;
        // 一页里混着非商品卡片（只有 customCard / recommendQueryItemList），跳过。
        const numIid = typeof entry.item_id === "string" ? entry.item_id.trim() : "";
        const title = cleanText(entry.title);
        if (!numIid || !title) continue;
        const picUrl = normalizeUrl(entry.uprightImg) ?? normalizeUrl(entry.pic_path);
        const price = typeof entry.price === "string" && entry.price.trim() ? entry.price.trim() : undefined;
        const shop = optionalText(entry.shopInfo?.title) ?? optionalText(entry.nick);
        items.push({
          numIid,
          title,
          ...(picUrl ? { picUrl } : {}),
          ...(price ? { price } : {}),
          ...(shop ? { shop } : {}),
          isP4p: entry.isP4p === "true"
        });
      }
      return items;
    },

    async getItemDetail(itemId, detailOptions = {}) {
      if (!configured) return null;
      const data = await call(DETAIL_PATH, { itemId: String(itemId) }, detailOptions.signal);
      const images: string[] = [];
      if (Array.isArray(data.item_imgs)) {
        for (const raw of data.item_imgs as unknown[]) {
          const url = normalizeUrl((raw as { url?: unknown } | null)?.url);
          if (url) images.push(url);
        }
      }
      if (!images.length) {
        const fallback = normalizeUrl(data.pic_url);
        if (fallback) images.push(fallback);
      }

      const detail: TaobaoItemDetail = {
        numIid: typeof data.num_iid === "string" && data.num_iid ? data.num_iid : String(itemId),
        title: cleanText(data.title),
        images,
        price: typeof data.price === "string" && data.price.trim() ? data.price.trim() : undefined,
        detailUrl: normalizeUrl(data.detail_url),
        shop: optionalText(data.nick)
      };
      // 三样都没有说明这条详情没取到东西，按失败处理，而不是当作一张空卡片。
      if (!detail.title && !detail.images.length && !detail.detailUrl) return null;
      return detail;
    }
  };
}
