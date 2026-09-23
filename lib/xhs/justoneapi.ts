import type { XhsCallInfo, XhsNoteDetail, XhsNoteStats, XhsNoteSummary, XhsSearchPage } from "./types.ts";

/**
 * Just One API 的小红书适配器。端点、参数、字段名、错误码、超时和映射规则全部来自
 * docs/specs/09-24-justoneapi-xhs-ssot.md——换供应商、换接口版本或字段改名，只改这个文件，
 * 上层（工具扩展、技能）不感知。
 *
 * token 走 query 参数，所以这里刻意不把请求 URL 放进任何错误信息或日志：只留 path 和 requestId。
 */

const DEFAULT_BASE_URL = "https://api.justoneapi.com";
const SEARCH_PATH = "/api/xiaohongshu/search-note/v4";
const DETAIL_PATH = "/api/xiaohongshu/get-note-detail/v6";

/** 正文上限（字符）。SSOT 第 6 节：典型正文只有几百字符，这条只在极端长文时触发。 */
const TEXT_LIMIT = 8000;
/** 单篇图片上限。样例平均 5.5 张/篇，留余量。 */
const IMAGE_LIMIT = 9;
/** 搜索预览上限。上游实测截断在约 60 字符，这里只是防御性封顶。 */
const PREVIEW_LIMIT = 120;

/** 限流、配额、余额：重试只会继续烧配额，必须整批停下（SSOT 第 4 节）。 */
export const QUOTA_ERROR_CODES = new Set([302, 303, 601, 602]);
/** 凭据失效、权限不足：整批停下等配置修好。 */
export const AUTH_ERROR_CODES = new Set([100, 600]);

export class XhsApiError extends Error {
  readonly code: number;
  readonly requestId?: string;
  readonly retryable: boolean;

  constructor(message: string, options: { code: number; requestId?: string; retryable: boolean }) {
    super(message);
    this.name = "XhsApiError";
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

  /** 能不能改成「重试一次」：只有采集失败和上游内部错误值得重试（SSOT 第 4 节）。 */
  get retryWorthwhile(): boolean {
    return this.code === 301 || this.code === 500;
  }
}

export type XhsClient = {
  /** 配了 token 才会发请求；为空即「未配置」，调用方据此整条链路降级（SSOT 第 11 节）。 */
  configured: boolean;
  searchNotes(keyword: string, options?: { page?: number; signal?: AbortSignal }): Promise<XhsSearchPage>;
  getNoteDetail(noteId: string, options?: { signal?: AbortSignal }): Promise<XhsNoteDetail | null>;
};

export type XhsClientOptions = {
  /** 测试注入，默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 测试注入，默认读 process.env。 */
  env?: Record<string, string | undefined>;
  /** 纯观测回调：每次上游调用（含重试）记一条。抛错不影响调用本身。 */
  onCall?: (info: XhsCallInfo) => void;
};

export function xhsApiToken(env: Record<string, string | undefined> = process.env): string {
  return (env.XHS_API_TOKEN ?? "").trim();
}

/** 可以发请求的唯一判据：token 非空。空 token = 不发任何请求、链路降级，不静默回退到别的来源。 */
export function xhsApiConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return xhsApiToken(env).length > 0;
}

/** 协议相对、http、带 HEIF 的地址统一补成能直接渲染的 https + jpg（SSOT 第 7 节）。 */
function normalizeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (trimmed.startsWith("http://")) return `https://${trimmed.slice(7)}`;
  return trimmed.startsWith("https://") ? trimmed : undefined;
}

/**
 * 搜索接口给的图片**全是 HEIF，浏览器渲染不了**；把 `format/heif` 换成 `format/jpg`
 * 实测返回 image/jpeg，且不影响签名校验（SSOT 第 7 节）。
 */
function normalizeImageUrl(value: unknown): string | undefined {
  const url = normalizeUrl(value);
  return url ? url.replace(/\/format\/heif/gi, "/format/jpg") : undefined;
}

/**
 * 图片取值链：`url_size_large` → `url` → `url_multi_level.high` → `original`（SSOT 第 7 节）。
 * 三个端点的形状各不相同，只认一种的话不会报错，只会静默退化成「没有封面」。
 */
function pickImageUrl(raw: unknown): string | undefined {
  if (typeof raw === "string") return normalizeImageUrl(raw);
  const item = (raw ?? {}) as Record<string, unknown>;
  const multi = (item.url_multi_level ?? {}) as Record<string, unknown>;
  return normalizeImageUrl(item.url_size_large)
    ?? normalizeImageUrl(item.url)
    ?? normalizeImageUrl(multi.high)
    ?? normalizeImageUrl(item.original);
}

function imageUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const urls: string[] = [];
  for (const entry of raw) {
    const url = pickImageUrl(entry);
    if (url && !urls.includes(url)) urls.push(url);
    if (urls.length >= IMAGE_LIMIT) break;
  }
  return urls;
}

/** 正文保留换行（技能要靠它读步骤和话题），只去控制字符、统一行尾、截断。 */
function textBody(value: unknown): { text: string; truncated: boolean } {
  if (typeof value !== "string") return { text: "", truncated: false };
  const cleaned = value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (cleaned.length <= TEXT_LIMIT) return { text: cleaned, truncated: false };
  return { text: cleaned.slice(0, TEXT_LIMIT), truncated: true };
}

function oneLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function optionalText(value: unknown): string | undefined {
  const text = oneLine(value);
  return text || undefined;
}

function count(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function statsOf(entry: Record<string, unknown>): XhsNoteStats | undefined {
  const stats: XhsNoteStats = {
    liked: count(entry.liked_count),
    comments: count(entry.comments_count),
    collected: count(entry.collected_count),
    shared: count(entry.shared_count)
  };
  return Object.values(stats).some((value) => value > 0) ? stats : undefined;
}

/**
 * Unix 秒 → `YYYY-MM-DD`（中国大陆时区）。技能要求「可见日期」，
 * 时间戳换算是服务端的活，不该让模型做。
 */
function postedAt(value: unknown): string | undefined {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

/** 笔记 id：上游回字符串；缺失即跳过该条（SSOT 第 10 节的规则）。 */
function noteIdOf(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** 搜索 V4 的单条 → 内部类型。搜索只负责定位，`preview` 不是正文。 */
function toSummary(raw: unknown): XhsNoteSummary | null {
  const entry = (raw ?? {}) as Record<string, unknown>;
  const noteId = noteIdOf(entry.id);
  const title = oneLine(entry.title);
  if (!noteId || !title) return null;
  const user = (entry.user ?? {}) as Record<string, unknown>;
  const images = Array.isArray(entry.images_list) ? entry.images_list : [];
  return {
    noteId,
    title,
    authorName: optionalText(user.nickname) ?? optionalText(user.name),
    noteType: optionalText(entry.type),
    postedAt: postedAt(entry.timestamp),
    stats: statsOf(entry),
    preview: oneLine(entry.desc).slice(0, PREVIEW_LIMIT) || undefined,
    cover: pickImageUrl(images[0])
  };
}

/** 详情 V6 的 `data[0]` → 内部类型。正文只信这里。 */
function toDetail(raw: unknown): XhsNoteDetail | null {
  const entry = (raw ?? {}) as Record<string, unknown>;
  const noteId = noteIdOf(entry.id);
  if (!noteId) return null;
  const user = (entry.user ?? {}) as Record<string, unknown>;
  const { text, truncated } = textBody(entry.desc);
  const tags = Array.isArray(entry.hash_tag)
    ? entry.hash_tag
      .map((tag) => optionalText((tag ?? {})?.name))
      .filter((name): name is string => Boolean(name))
    : [];
  return {
    noteId,
    title: oneLine(entry.title),
    authorName: optionalText(user.nickname) ?? optionalText(user.name),
    noteType: optionalText(entry.type),
    postedAt: postedAt(entry.time),
    ipLocation: optionalText(entry.ip_location),
    text,
    tags,
    stats: statsOf(entry),
    images: imageUrls(entry.images_list),
    truncated
  };
}

function errorLabel(error: unknown): string {
  const value = error as { name?: string; message?: string } | null;
  if (value?.name === "TimeoutError") return "请求超时";
  if (value?.name === "AbortError") return "请求已取消";
  return "网络错误";
}

export function createXhsClient(options: XhsClientOptions = {}): XhsClient {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (env.XHS_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const token = xhsApiToken(env);
  const timeoutSeconds = Number(env.XHS_API_TIMEOUT_SECONDS ?? 60);
  const timeoutMs = Math.max(1, Number.isFinite(timeoutSeconds) ? timeoutSeconds : 60) * 1000;
  const configured = token.length > 0;

  /** 观测是纯旁路：回调抛错只丢一条观测，不能让取数失败。 */
  function report(info: XhsCallInfo): void {
    try {
      options.onCall?.(info);
    } catch {
      // 忽略。
    }
  }

  /** 发一次请求并解析信封。**判据只有业务码**：HTTP 200 也可能是失败（SSOT 第 4 节）。 */
  async function attempt(
    path: string,
    params: Record<string, string>,
    signal: AbortSignal | undefined,
    descriptor: Pick<XhsCallInfo, "endpoint" | "keyword" | "noteId">
  ): Promise<unknown> {
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
      throw new XhsApiError(`${path} ${errorLabel(error)}`, { code: -1, retryable: true });
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    const envelope = (body ?? {}) as { code?: unknown; message?: unknown; requestId?: unknown; data?: unknown };
    const code = typeof envelope.code === "number" ? envelope.code : -1;
    const requestId = typeof envelope.requestId === "string" ? envelope.requestId : undefined;
    if (code !== 0) {
      done(false, { code, ...(requestId ? { requestId } : {}) });
      const message = typeof envelope.message === "string" && envelope.message ? `：${envelope.message}` : "";
      throw new XhsApiError(`${path} 业务失败 code=${code}${message}`, {
        code,
        requestId,
        retryable: code === 301 || code === 500 || response.status >= 500
      });
    }
    done(true, { code, ...(requestId ? { requestId } : {}) });
    return envelope.data;
  }

  /** 重试一次，只给「采集失败」「上游 5xx」「网络超时」——配额和凭据问题重试只会更糟。 */
  async function call(
    path: string,
    params: Record<string, string>,
    signal: AbortSignal | undefined,
    descriptor: Pick<XhsCallInfo, "endpoint" | "keyword" | "noteId">
  ): Promise<unknown> {
    try {
      return await attempt(path, params, signal, descriptor);
    } catch (error) {
      if (error instanceof XhsApiError && error.retryable && !signal?.aborted) {
        return attempt(path, params, signal, descriptor);
      }
      throw error;
    }
  }

  return {
    configured,

    async searchNotes(keyword, searchOptions = {}) {
      // 未配 token 时不发请求，也不把「没配」当成错误抛给上层（与淘宝链路的降级约定一致）。
      if (!configured) return { notes: [], hasMore: false, page: searchOptions.page ?? 1 };
      const page = searchOptions.page ?? 1;
      const data = (await call(SEARCH_PATH, { keyword, page: String(page) }, searchOptions.signal, {
        endpoint: "search",
        keyword
      }) ?? {}) as Record<string, unknown>;
      const entries = Array.isArray(data.notes) ? data.notes : [];
      const notes: XhsNoteSummary[] = [];
      const seen = new Set<string>();
      for (const raw of entries) {
        const summary = toSummary(raw);
        // 同一笔记跨页去重，服务端做，不指望模型自己发现重复。
        if (!summary || seen.has(summary.noteId)) continue;
        seen.add(summary.noteId);
        notes.push(summary);
      }
      return { notes, hasMore: data.has_more === true, page };
    },

    async getNoteDetail(noteId, detailOptions = {}) {
      if (!configured || !noteId) return null;
      const data = await call(DETAIL_PATH, { noteId }, detailOptions.signal, { endpoint: "detail", noteId });
      // V6 的 data 是数组，data[0] 就是笔记本体（SSOT 第 5.2 节）；容错收对象形式。
      const entry = Array.isArray(data) ? data[0] : data;
      return toDetail(entry);
    }
  };
}
