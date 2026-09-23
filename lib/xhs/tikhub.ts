import type { XhsCallInfo, XhsNoteDetail, XhsNoteStats, XhsNoteSummary, XhsSearchPage } from "./types.ts";

/**
 * TikHub 的小红书适配器。端点、参数、信封、错误码、计费陷阱和映射规则全部来自
 * docs/specs/09-24-tikhub-xhs-ssot.md——换供应商、换接口版本或字段改名，只改这个文件，
 * 上层（工具扩展、技能）不感知。
 *
 * 与 Just One 最大的三处不同（SSOT 第 10 节）：
 * 1. 鉴权在**请求头**（`Authorization: Bearer`），token 不进 URL；
 * 2. 成功判据是**两层**：外层 `code === 200`（HTTP 语义）且内层 `data.code === 0` / `success === true`；
 * 3. **响应即计费**：内层「服务异常」和空内容都已经花过钱，所以**不重试**——重试等于再付一次。
 */

const DEFAULT_BASE_URL = "https://api.tikhub.io";
const SEARCH_PATH = "/api/v1/xiaohongshu/app_v2/search_notes";
const DETAIL_PATH = "/api/v1/xiaohongshu/app_v2/get_image_note_detail";

/** 正文上限（字符）。SSOT 第 5 节：样例正文 300+ 字，这条只在极端长文时触发。 */
const TEXT_LIMIT = 8000;
/** 单篇图片上限。 */
const IMAGE_LIMIT = 9;
/** 搜索预览上限。上游卡片自带的是截断预览，这里只是防御性封顶。 */
const PREVIEW_LIMIT = 120;
/**
 * 检索固定只取图文笔记。TikHub 的 `note_type` 是**中文枚举**（SSOT 第 2.1 节），
 * 与 Just One 的 `NORMAL_NOTE` 等价。技能的产出要一张能看清妆效的完成妆画面，
 * 而视频笔记在本链路上只有封面——所以让它在服务端就过滤掉。
 */
const NOTE_TYPE = "普通笔记";

/** 限流与套餐额度：重试只会继续烧额度，必须整批停下。 */
export const QUOTA_STATUS_CODES = new Set([429]);
/** 凭据无效或无权：整批停下等配置修好。 */
export const AUTH_STATUS_CODES = new Set([401, 403]);
/** 不是上游的码：-1 = 连响应都没拿到（网络/超时）；-2 = 信封正常但内容读不出来。 */
export const NO_ENVELOPE_CODE = -1;
export const SHAPE_DRIFT_CODE = -2;

export class XhsApiError extends Error {
  readonly code: number;
  readonly requestId?: string;
  readonly retryable: boolean;
  /** 上游明确说过这次已经计费（TikHub 的成功响应与「服务异常」都算）。 */
  readonly billed: boolean;

  constructor(message: string, options: { code: number; requestId?: string; retryable: boolean; billed?: boolean }) {
    super(message);
    this.name = "XhsApiError";
    this.code = options.code;
    this.requestId = options.requestId;
    this.retryable = options.retryable;
    this.billed = options.billed === true;
  }

  get quotaLimited(): boolean {
    return QUOTA_STATUS_CODES.has(this.code);
  }

  get authFailed(): boolean {
    return AUTH_STATUS_CODES.has(this.code);
  }
}

export type XhsClient = {
  /** 配了 token 才会发请求；为空即「未配置」，调用方据此整条链路降级。 */
  configured: boolean;
  searchNotes(keyword: string, options?: { page?: number; signal?: AbortSignal }): Promise<XhsSearchPage>;
  getNoteDetail(noteId: string, options?: { signal?: AbortSignal }): Promise<XhsNoteDetail | null>;
};

export type XhsClientOptions = {
  /** 测试注入，默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 测试注入，默认读 process.env。 */
  env?: Record<string, string | undefined>;
  /** 纯观测回调：每次上游调用记一条。抛错不影响调用本身。 */
  onCall?: (info: XhsCallInfo) => void;
};

export function xhsApiToken(env: Record<string, string | undefined> = process.env): string {
  return (env.XHS_API_TOKEN ?? "").trim();
}

/** 可以发请求的唯一判据：token 非空。空 token ＝ 不发任何请求、链路降级。 */
export function xhsApiConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return xhsApiToken(env).length > 0;
}

/** 协议相对、http、带 HEIF 的地址统一补成能直接渲染的 https + jpg（SSOT 第 5 节）。 */
function normalizeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (trimmed.startsWith("http://")) return `https://${trimmed.slice(7)}`;
  return trimmed.startsWith("https://") ? trimmed : undefined;
}

function normalizeImageUrl(value: unknown): string | undefined {
  const url = normalizeUrl(value);
  // 不要求 format 前面是斜杠：真实地址里它既可能是 `…/w/608/format/heif/q/56`，
  // 也可能整段查询就是以 `?format/heif` 开头的（测试里那条就是这样）。
  return url ? url.replace(/format\/heif/gi, "format/jpg") : undefined;
}

/**
 * 图片取值链：`url_size_large` → `url` → `url_multi_level.high` → `original`（SSOT 第 5 节）。
 * 形状与 Just One 一致，三个端点的候选字段各不相同，只认一种会静默退化成「没有封面」。
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
  // 详情是平铺的四个 *_count；搜索卡片把它们放在 interact_info 里（SSOT 第 7 节待采样）。
  const interact = (entry.interact_info ?? entry.interactInfo ?? {}) as Record<string, unknown>;
  const stats: XhsNoteStats = {
    liked: count(entry.liked_count ?? interact.liked_count ?? interact.likedCount),
    comments: count(entry.comments_count ?? interact.comment_count ?? interact.commentCount),
    collected: count(entry.collected_count ?? interact.collected_count ?? interact.collectedCount),
    shared: count(entry.shared_count ?? interact.shared_count ?? interact.sharedCount)
  };
  return Object.values(stats).some((value) => value > 0) ? stats : undefined;
}

/** Unix 秒 → `YYYY-MM-DD`（中国大陆时区）。时间戳换算是服务端的活。 */
function postedAt(value: unknown): string | undefined {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

function noteIdOf(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** 首屏给的分页凭据，第二页起要原样带回（SSOT 第 2.1 节）。位置未采样，按候选键名找。 */
function paginationToken(data: Record<string, unknown>, keys: string[]): string {
  const scopes = [data, (data.data ?? {}) as Record<string, unknown>, (data.notes ?? {}) as Record<string, unknown>];
  for (const scope of scopes) {
    for (const key of keys) {
      const value = scope?.[key];
      if (typeof value === "string" && value) return value;
    }
  }
  return "";
}

/**
 * 搜索响应 → 内部类型。**形状未采样**（SSOT 第 7 节），所以按 app_v2 的常见形态容错：
 * 列表可能在 `data.items` / `data.notes` / `data.data.items`，条目可能是 `note_card` 包装或平铺，
 * 键名可能是 snake_case 或 camelCase。只认一种形状，上游换一次就静默变成 0 条。
 */
function searchEntries(data: Record<string, unknown>): unknown[] {
  const nested = (data.data ?? {}) as Record<string, unknown>;
  for (const candidate of [data.items, data.notes, nested.items, nested.notes]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

/**
 * 搜索响应 → 内部类型。
 *
 * **真实形状（2026-09-24 实测，SSOT 第 7 节已更新）**：`data.data.items[].note{…}`，
 * 笔记字段是**平铺的**（`id` / `title` / `desc` / `type` / `user.nickname` / `images_list` /
 * `timestamp` / `*_count`），包装键叫 **`note`**。其余形状（`note_card` / 平铺条目）一并收——
 * 形状猜错一次的代价是「搜索返回 0 条」这种事完全静默，实战里就是这么踩的。
 */
function toSummary(raw: unknown): XhsNoteSummary | null {
  const entry = (raw ?? {}) as Record<string, unknown>;
  const card = (entry.note ?? entry.note_card ?? entry.noteCard ?? entry) as Record<string, unknown>;
  const noteId = noteIdOf(card.id ?? card.note_id ?? card.noteId ?? entry.id ?? entry.note_id);
  const title = oneLine(card.title ?? card.display_title ?? card.displayTitle ?? entry.title);
  if (!noteId || !title) return null;
  const user = (card.user ?? entry.user ?? {}) as Record<string, unknown>;
  const cover = (card.cover ?? entry.cover ?? {}) as Record<string, unknown>;
  const images = Array.isArray(card.images_list) ? card.images_list : [];
  return {
    noteId,
    title,
    authorName: optionalText(user.nickname ?? user.nick_name ?? user.name),
    noteType: optionalText(card.type ?? entry.type),
    postedAt: postedAt(card.time ?? entry.time ?? card.timestamp ?? entry.timestamp),
    stats: statsOf({ ...entry, ...card }),
    preview: oneLine(card.desc ?? entry.desc).slice(0, PREVIEW_LIMIT) || undefined,
    cover: pickImageUrl(cover.url_default ?? cover.urlDefault ?? cover.url_pre) ?? pickImageUrl(images[0])
  };
}

/**
 * 详情的笔记本体在哪：`data.data[0].note_list[0]`（SSOT 第 5 节，V3 式嵌套）。
 * 其余形态（`data[0]` 平铺、`{note}` 包装、JSON 字符串）一并收——形状漂移是这条链路最贵的失败。
 */
function pickDetailEntry(data: unknown): Record<string, unknown> | null {
  let current: unknown = data;
  if (typeof current === "string") {
    try {
      current = JSON.parse(current);
    } catch {
      return null;
    }
  }
  if (Array.isArray(current)) current = current[0];
  if (!current || typeof current !== "object") return null;
  const object = current as Record<string, unknown>;
  if (Array.isArray(object.note_list)) {
    const first = object.note_list[0];
    return first && typeof first === "object" ? (first as Record<string, unknown>) : null;
  }
  if (object.note && typeof object.note === "object") return object.note as Record<string, unknown>;
  return object;
}

/** 丢掉一篇笔记时要说清「上游到底回了什么」：只列顶层字段名，不含任何值。 */
function describeShape(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "响应体不是对象";
  const keys = Object.keys(entry as Record<string, unknown>);
  return keys.length ? `上游返回的字段：${keys.slice(0, 40).join(", ")}` : "响应体是空对象";
}

function toDetail(entry: Record<string, unknown>, fallbackNoteId: string): XhsNoteDetail | null {
  let noteId = "";
  for (const key of ["id", "note_id", "noteId"]) {
    noteId = noteIdOf(entry[key]);
    if (noteId) break;
  }
  if (!noteId) noteId = fallbackNoteId;
  if (!noteId) return null;

  const user = (entry.user ?? {}) as Record<string, unknown>;
  const { text, truncated } = textBody(entry.desc);
  const tags = Array.isArray(entry.hash_tag)
    ? entry.hash_tag
      .map((tag) => optionalText((tag ?? {})?.name))
      .filter((name): name is string => Boolean(name))
    : [];
  const title = oneLine(entry.title);
  const images = imageUrls(entry.images_list);
  // 内容全空才算「这篇没有东西可给」：有标题/正文/话题/图片一律映射出去，绝不因为缺 id 丢整篇。
  if (!title && !text && tags.length === 0 && images.length === 0) return null;
  return {
    noteId,
    title,
    authorName: optionalText(user.nickname ?? user.name),
    noteType: optionalText(entry.type),
    postedAt: postedAt(entry.time),
    ipLocation: optionalText(entry.ip_location),
    text,
    tags,
    stats: statsOf(entry),
    images,
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
  /** 首屏返回的分页凭据，第二页起带上（有状态分页，SSOT 第 2.1 节）。 */
  let searchId = "";
  let searchSessionId = "";

  function report(info: XhsCallInfo): void {
    try {
      options.onCall?.(info);
    } catch {
      // 观测是纯旁路。
    }
  }

  /** 发一次请求并解析两层信封。**响应即计费**，所以这里只在「没拿到响应」时才允许重试。 */
  async function attempt(
    path: string,
    params: Record<string, string>,
    signal: AbortSignal | undefined,
    descriptor: Pick<XhsCallInfo, "endpoint" | "keyword" | "noteId">
  ): Promise<unknown> {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }

    const timeout = AbortSignal.timeout(timeoutMs);
    const composedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const startedAt = performance.now();
    const done = (ok: boolean, extra: { code?: number; requestId?: string } = {}) =>
      report({ ...descriptor, durationMs: Math.round(performance.now() - startedAt), ok, ...extra });

    let response: Response;
    try {
      // token 在请求头：URL 因此可以安全地记录（这里仍然只记 path，保持习惯）。
      response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        signal: composedSignal
      });
    } catch (error) {
      done(false, { code: NO_ENVELOPE_CODE });
      throw new XhsApiError(`${path} ${errorLabel(error)}`, { code: NO_ENVELOPE_CODE, retryable: true });
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    const envelope = (body ?? {}) as Record<string, unknown>;
    const status = typeof envelope.code === "number" ? envelope.code : NO_ENVELOPE_CODE;
    const requestId = typeof envelope.request_id === "string" ? envelope.request_id : undefined;
    const message = typeof envelope.message_zh === "string" && envelope.message_zh ? envelope.message_zh : "";

    // 第一层：外层 code 是 HTTP 语义，200 才算过。
    if (status !== 200) {
      done(false, { code: status, ...(requestId ? { requestId } : {}) });
      throw new XhsApiError(`${path} 请求失败（HTTP ${status}）${message ? `：${message}` : ""}`, {
        code: status,
        requestId,
        // 5xx 是上游故障，值得重试一次；401/403/429/422 重试没有意义。
        retryable: response.status >= 500
      });
    }

    // 第二层：内层才是业务结果。**供应商明示：这一层失败也已经计费。**
    const inner = (envelope.data ?? {}) as Record<string, unknown>;
    const innerCode = typeof inner.code === "number" ? inner.code : 0;
    const success = inner.success !== false;
    if (innerCode !== 0 || !success) {
      const detail = typeof inner.msg === "string" && inner.msg ? inner.msg : "上游服务异常";
      done(false, { code: innerCode === 0 ? -3 : innerCode, ...(requestId ? { requestId } : {}) });
      throw new XhsApiError(`${path} 上游返回「${detail}」（这一次已计费）`, {
        code: innerCode === 0 ? -3 : innerCode,
        requestId,
        retryable: false,
        billed: true
      });
    }

    done(true, { code: status, ...(requestId ? { requestId } : {}) });
    return inner;
  }

  /** 重试只给「没拿到响应」的情况：5xx、网络、超时。计费过的失败一律不重试。 */
  async function call(
    path: string,
    params: Record<string, string>,
    signal: AbortSignal | undefined,
    descriptor: Pick<XhsCallInfo, "endpoint" | "keyword" | "noteId">
  ): Promise<Record<string, unknown>> {
    try {
      return ((await attempt(path, params, signal, descriptor)) ?? {}) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof XhsApiError && error.retryable && !error.billed && !signal?.aborted) {
        return ((await attempt(path, params, signal, descriptor)) ?? {}) as Record<string, unknown>;
      }
      throw error;
    }
  }

  return {
    configured,

    async searchNotes(keyword, searchOptions = {}) {
      if (!configured) return { notes: [], hasMore: false, page: searchOptions.page ?? 1 };
      const page = searchOptions.page ?? 1;
      // 有状态分页：首屏只传 keyword + page，第二页起带上首屏给的凭据（SSOT 第 2.1 节）。
      const data = await call(SEARCH_PATH, {
        keyword,
        page: String(page),
        sort_type: "general",
        note_type: NOTE_TYPE,
        ...(page > 1 && searchId ? { search_id: searchId } : {}),
        ...(page > 1 && searchSessionId ? { search_session_id: searchSessionId } : {})
      }, searchOptions.signal, { endpoint: "search", keyword });

      if (!searchId) searchId = paginationToken(data, ["search_id", "searchId"]);
      if (!searchSessionId) searchSessionId = paginationToken(data, ["search_session_id", "searchSessionId"]);

      const notes: XhsNoteSummary[] = [];
      const seen = new Set<string>();
      let mapped = 0;
      const entries = searchEntries(data);
      for (const raw of entries) {
        const summary = toSummary(raw);
        // 同一笔记跨页去重；搜索条目缺 id 只能跳过（没有可兜底的值——与详情不同）。
        if (!summary) continue;
        mapped += 1;
        if (seen.has(summary.noteId)) continue;
        // 服务端已经按 note_type=普通笔记 过滤过；这里再挡一次明确的 video，
        // 是因为「上游忽略参数」这件事在本链路里已经发生过一次（Just One 的空 data）。
        if (summary.noteType === "video") continue;
        seen.add(summary.noteId);
        notes.push(summary);
      }
      // 有条目却一条都没映射出来 = 形状变了。**不能静默成 0 条**：2026-09-24 就因为包装键
      // 写成 `note_card`（真实是 `note`），两轮搜索都安静地返回 0 条，白花钱还查不出原因。
      if (entries.length > 0 && mapped === 0) {
        throw new XhsApiError(`搜索结果里的条目一条都读不出来（${describeShape(entries[0])}）`, {
          code: SHAPE_DRIFT_CODE,
          retryable: false
        });
      }
      // 分页看 `next_page`：它比 has_more 更直接（SSOT 第 2.1 节）。
      const nextPage = data.next_page ?? (data.data as Record<string, unknown> | undefined)?.next_page;
      const hasMore = data.has_more === true || data.hasMore === true
        || (typeof nextPage === "number" && nextPage > page);
      return { notes, hasMore, page };
    },

    async getNoteDetail(noteId, detailOptions = {}) {
      if (!configured || !noteId) return null;
      const data = await call(DETAIL_PATH, { note_id: noteId }, detailOptions.signal, { endpoint: "detail", noteId });
      const entry = pickDetailEntry(data.data);
      // 空业务数据：这篇确实没内容（供应商明示：这种响应也计费）。
      if (!entry) return null;
      const note = toDetail(entry, noteId);
      if (!note) {
        // 有数据但读不出内容 = 上游形状变了。带上字段名，别让下一次排查从头再走一遍。
        throw new XhsApiError(`详情响应里没有可用的正文/标题/图片（${describeShape(entry)}）`, {
          code: SHAPE_DRIFT_CODE,
          retryable: false
        });
      }
      return note;
    }
  };
}
