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
/**
 * 详情用 V6：供应商标记的推荐版本，且多给运费（`delivery`）与券后价（`item.couponPrice`），
 * 这两样 V8 都没有。代价是结构从平铺变成嵌套，而且**没有 `detail_url`**——链接改由
 * `itemId` 拼（`cards.ts` 的 `itemUrl()`）。形状差异见 SSOT 第 4.2/4.3 节。
 */
const DETAIL_PATH = "/api/taobao/get-item-detail/v6";

/** 每日配额、余额、TOKEN 上限：等多久都是同一个错，必须整批停下。 */
export const QUOTA_ERROR_CODES = new Set([303, 601, 602]);
/**
 * 超出速率限制：**不是**配额耗尽。上游只在「用户 × 接口」配了速率（每分钟/每小时）时才返它，
 * 过一会儿自己会好，所以既不整批停、也不归 `quotaLimited`——消费方按「退避后重试一次，
 * 仍失败只算这一件」处理（SSOT 第 3 节把 302 和 303/601/602 分开列，就是为这个）。
 */
export const RATE_LIMIT_ERROR_CODES = new Set([302]);
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

  /** 上游限流：瞬时错误，退避后可以再试一次。 */
  get rateLimited(): boolean {
    return RATE_LIMIT_ERROR_CODES.has(this.code);
  }

  get authFailed(): boolean {
    return AUTH_ERROR_CODES.has(this.code);
  }
}

/**
 * 商品卡片总开关，默认**关**。
 *
 * 淘宝是采集类接口，按次计费，一轮妆容要打好几次搜索和详情。调试、演示，
 * 或者只是不想烧钱的时候，在 `.env` 里把 `TAOBAO_CARDS_ENABLED` 关掉即可——
 * 代码、技能、token 都不用动。
 *
 * 判据从严：只有 `"true"` / `"1"` 算开，没写、写空、写错都按关处理。这个方向的
 * 默认值只会少花钱，不会让人意外被扣费。
 */
export function productCardsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = (env.TAOBAO_CARDS_ENABLED ?? "").trim().toLowerCase();
  return value === "true" || value === "1";
}

export type TaobaoClient = {
  /**
   * 可以发请求：**总开关打开，且配了 token**。任一不满足都不发请求，
   * 调用方据此让整条卡片链路安静降级（连 `pending` 都不发）。
   */
  configured: boolean;
  searchItems(
    keyword: string,
    options?: { page?: number; signal?: AbortSignal; tag?: string }
  ): Promise<TaobaoSearchItem[]>;
  getItemDetail(
    itemId: string,
    options?: { signal?: AbortSignal; tag?: string }
  ): Promise<TaobaoItemDetail | null>;
};

/**
 * 单次上游调用的观测信息。
 *
 * **刻意没有 URL**：token 走 query 参数，URL 永远不进观测数据——沿用本文件顶部
 * 「不把请求 URL 放进任何错误信息或日志」的既有纪律。
 */
export type TaobaoCallInfo = {
  endpoint: "search" | "detail";
  durationMs: number;
  ok: boolean;
  /** 业务码（见 SSOT 第 3 节）；-1 表示没拿到信封（网络错误、超时、取消）。 */
  code?: number;
  /** 上游 requestId，用于对账。 */
  requestId?: string;
  keyword?: string;
  itemId?: string;
  /**
   * 调用方贴的上下文标签，原样回传。`cards.ts` 用它把一次调用归到发起它的那张卡片，
   * 观测层据此把 `taobao.search` / `taobao.detail` 挂到所属 `taobao.card` 之下。
   * 适配器不解释它的含义。
   */
  tag?: string;
};

export type TaobaoClientOptions = {
  /** 测试注入，默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 测试注入，默认读 process.env。 */
  env?: Record<string, string | undefined>;
  /** 纯观测回调：每次上游调用（含重试）记一条。抛错不影响调用本身。 */
  onCall?: (info: TaobaoCallInfo) => void;
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

/**
 * 图组条目：V6/V8 给裸地址字符串，V3 给 `{url}`。两种形状都收——只认一种的话，
 * 上游换形状不会报错，只会静默退化成「图组全空、只剩 pic_url 一张图」。
 */
function imageEntryUrl(raw: unknown): string | undefined {
  if (typeof raw === "string") return normalizeUrl(raw);
  return normalizeUrl((raw as { url?: unknown } | null)?.url);
}

/** 嵌套块（V6 的 `item` / `seller`）：缺失或不是对象时给空对象，让平铺兜底链继续走。 */
function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? (value as Record<string, any>) : {};
}

/** 商品 ID：V6 回字符串、V8 回数字，统一成字符串；缺失时用请求里的 itemId。 */
function itemIdOf(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
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
  // 开关与 token 是「与」的关系：开关默认关，所以配了 token 也不会自动开始烧钱。
  const configured = productCardsEnabled(env) && Boolean(token);

  /** 观测是纯旁路：回调抛错只丢一条观测，不能让淘宝调用失败。 */
  function report(info: TaobaoCallInfo): void {
    try {
      options.onCall?.(info);
    } catch {
      // 忽略。
    }
  }

  async function call(
    path: string,
    params: Record<string, string>,
    signal: AbortSignal | undefined,
    descriptor: Pick<TaobaoCallInfo, "endpoint" | "keyword" | "itemId" | "tag">
  ): Promise<Record<string, unknown>> {
    if (!configured) throw new TaobaoApiError("淘宝商品卡片未启用（TAOBAO_CARDS_ENABLED）或未配置 token", { code: -1, retryable: false });

    const url = new URL(`${baseUrl}${path}`);
    url.searchParams.set("token", token);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const timeout = AbortSignal.timeout(timeoutMs);
    const composedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const startedAt = performance.now();
    const done = (ok: boolean, extra: { code?: number; requestId?: string } = {}) =>
      report({ ...descriptor, durationMs: Math.round(performance.now() - startedAt), ok, ...extra });

    let response: Response;
    try {
      response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: composedSignal });
    } catch (error) {
      done(false, { code: -1 });
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
      done(false, { code, ...(requestId ? { requestId } : {}) });
      const message = typeof envelope.message === "string" && envelope.message ? `：${envelope.message}` : "";
      throw new TaobaoApiError(`${path} 业务失败 code=${code}${message}`, {
        code,
        requestId,
        retryable: code === 301 || response.status >= 500
      });
    }
    done(true, { code, ...(requestId ? { requestId } : {}) });
    return (envelope.data ?? {}) as Record<string, unknown>;
  }

  return {
    configured,

    async searchItems(keyword, searchOptions = {}) {
      // 开关关着或没配凭据时整条链路安静降级：不发请求，也不把「没开」当成错误抛给上层。
      if (!configured) return [];
      const data = await call(
        SEARCH_PATH,
        { keyword, page: String(searchOptions.page ?? 1) },
        searchOptions.signal,
        { endpoint: "search", keyword, ...(searchOptions.tag ? { tag: searchOptions.tag } : {}) }
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
      const data = await call(DETAIL_PATH, { itemId: String(itemId) }, detailOptions.signal, {
        endpoint: "detail",
        itemId: String(itemId),
        ...(detailOptions.tag ? { tag: detailOptions.tag } : {})
      });

      // V6 是嵌套结构（`item` / `seller`），V8、V3 是平铺。**嵌套优先、平铺兜底**：
      // 只认一种形状的话，上游回退版本不会报错，只会让卡片静默退化成「空标题 + 空图」。
      const item = asObject(data.item);
      const seller = asObject(data.seller);

      const images: string[] = [];
      const rawImages = Array.isArray(item.images)
        ? (item.images as unknown[])
        : Array.isArray(data.item_imgs)
          ? (data.item_imgs as unknown[])
          : [];
      for (const raw of rawImages) {
        const url = imageEntryUrl(raw);
        if (url) images.push(url);
      }
      if (!images.length) {
        const fallback = normalizeUrl(data.pic_url);
        if (fallback) images.push(fallback);
      }

      const detail: TaobaoItemDetail = {
        numIid: itemIdOf(item.itemId ?? data.num_iid, String(itemId)),
        // V6 只有 title；title_cn 是 V8 的兜底字段，留着只为接住平铺形状。
        title: cleanText(item.title) || cleanText(data.title) || cleanText(data.title_cn),
        images,
        // 券后价只在现价缺失时才顶上——挂出来的价得和商品页对得上，不能拿券后价冒充现价。
        price: optionalText(item.price) ?? optionalText(item.couponPrice) ?? optionalText(data.price),
        // V6 没有 detail_url：值就是空的，由消费方按 itemId 拼规范详情页（消费方 spec 第 7 节）。
        detailUrl: normalizeUrl(data.detail_url),
        shop: optionalText(seller.shopName) ?? optionalText(data.nick)
      };
      // 三样都没有说明这条详情没取到东西，按失败处理，而不是当作一张空卡片。
      // V6 下 detailUrl 恒空，这条判据实际落在标题与图上——正是最该守住的两样。
      if (!detail.title && !detail.images.length && !detail.detailUrl) return null;
      return detail;
    }
  };
}
