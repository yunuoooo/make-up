import { formatTranscript, isFetchableTranscriptUrl, parseSrt, transcriptHost } from "./transcript.ts";
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
/** 图文详情：笔记本体在 `data.data[0].note_list[0]`。 */
const DETAIL_PATH = "/api/v1/xiaohongshu/app_v2/get_image_note_detail";
/** 视频详情：笔记本体在 `data.data[0]`，**没有 `note_list` 那一层**（SSOT 第 2.3 节）。 */
const VIDEO_DETAIL_PATH = "/api/v1/xiaohongshu/app_v2/get_video_note_detail";

/** 正文上限（字符）。SSOT 第 5 节：样例正文 300+ 字，这条只在极端长文时触发。 */
const TEXT_LIMIT = 8000;
/** 单篇图片上限。 */
const IMAGE_LIMIT = 9;
/** 搜索预览上限。上游卡片自带的是截断预览，这里只是防御性封顶。 */
const PREVIEW_LIMIT = 120;
/**
 * 字幕上限（字符）。**刻意不复用正文的 `TEXT_LIMIT`**：正文 8000 够用，但十分钟的教程
 * 字幕会超过它，而字幕被截断的代价比正文大——讲解是连续的，丢了尾巴等于没讲完。
 * 样本是 418 秒 / 6053 字符（视频理解规格第 5 节）。
 */
const TRANSCRIPT_LIMIT = 20000;
/**
 * 取 `.srt` 时带的 UA（SSOT 第 2.3 节：抽样脚本如此，**是否必需未验证**）。
 * 稳妥照带，别裸请求。
 */
const TRANSCRIPT_USER_AGENT = "Mozilla/5.0";
/** 人声缺失时退到连续值的阈值：`speech_ratio` 低于它按「没有人声」处理。 */
const SPEECH_RATIO_FLOOR = 0.05;
/**
 * 取 `.srt` 的尝试次数。
 *
 * **这不违反「计费过就不重试」的纪律**（SSOT 第 4 节）：`.srt` 走 CDN、不经过 TikHub、不计费，
 * 重试的代价只有时间；而 TikHub 的详情调用响应即计费，一次都不许重试。
 *
 * 2026-09-26 实测遇到过一次瞬时 `ECONNRESET`（字幕 CDN 的另一个节点），同一个地址重试即成功。
 * 不重试的话，一条本来拿得到的字幕会变成 `transcript-failed`，模型只能降级——而**它的替代方案
 * 是重新打开这条笔记，那要再付一次详情调用的钱**。
 */
const TRANSCRIPT_ATTEMPTS = 2;

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
  /**
   * 读一篇笔记的详情。**两个端点按类型分流，调用前就要定**（视频理解规格第 3.2 节）：
   * 两个端点的响应形状不同，而每次尝试都计费——不能靠「失败了再试另一个」。
   *
   * `noteType` 取自搜索条目（`video` 走视频端点，其余走图文端点）。
   */
  getNoteDetail(noteId: string, options?: { noteType?: string; signal?: AbortSignal }): Promise<XhsNoteDetail | null>;
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

/**
 * **视频**详情的笔记本体在哪：`data.data[0]`——数组元素**直接就是笔记**，没有 `note_list` 包装。
 *
 * ⚠️ 这一层是视频端点最容易踩的地方：真实的视频响应是 `body.data.data[0]`，
 * 2026-09-26 实调复核过（同一个数组里 `[1]`、`[2]` 是**推荐笔记**，所以必须取 `[0]`）。
 * SSOT 第 2.3 节曾把它写成 `data.data.data[0]`（多一层 `.data`），**已按实测改正**。
 *
 * 与 `pickDetailEntry` 分开写，但**别指望分错会报错**：把视频响应喂给 `pickDetailEntry`
 * 会走「是数组就取 `[0]`」那条分支，把笔记**碰巧**映射出来（2026-09-26 实测）。分错是静默故障，
 * 所以分流靠的是**调用前就知道的类型**（`getNoteDetail` 的 `noteType`），不是形状试探。
 * 形状漂移是这条链路最贵的失败，所以其余形态（多包一层 `.data`、`note_list`、`note` 包装）一并收。
 */
function pickVideoDetailEntry(data: unknown): Record<string, unknown> | null {
  let current: unknown = data;
  if (typeof current === "string") {
    try {
      current = JSON.parse(current);
    } catch {
      return null;
    }
  }
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

  const wrapper = asRecord(current);
  if (wrapper) {
    if (Array.isArray(wrapper.data)) current = wrapper.data;
    else if (Array.isArray(wrapper.note_list)) current = wrapper.note_list;
    else if (asRecord(wrapper.note)) return asRecord(wrapper.note);
  }
  if (Array.isArray(current)) current = current[0];
  return asRecord(current);
}

/** 丢掉一篇笔记时要说清「上游到底回了什么」：只列顶层字段名，不含任何值。 */
function describeShape(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "响应体不是对象";
  const keys = Object.keys(entry as Record<string, unknown>);
  return keys.length ? `上游返回的字段：${keys.slice(0, 40).join(", ")}` : "响应体是空对象";
}

/** 详情缺 id 时用请求参数兜底（Just One 那次线上事故的教训：缺 id 不能丢整篇）。 */
function noteIdFrom(entry: Record<string, unknown>, fallbackNoteId: string): string {
  for (const key of ["id", "note_id", "noteId"]) {
    const noteId = noteIdOf(entry[key]);
    if (noteId) return noteId;
  }
  return fallbackNoteId;
}

/** 话题只取 `.name`，其余（id / type / record_count）都是页内状态。 */
function tagsOf(entry: Record<string, unknown>): string[] {
  if (!Array.isArray(entry.hash_tag)) return [];
  return entry.hash_tag
    .map((tag) => optionalText((tag ?? {})?.name))
    .filter((name): name is string => Boolean(name));
}

function toDetail(entry: Record<string, unknown>, fallbackNoteId: string): XhsNoteDetail | null {
  const noteId = noteIdFrom(entry, fallbackNoteId);
  if (!noteId) return null;

  const user = (entry.user ?? {}) as Record<string, unknown>;
  const { text, truncated } = textBody(entry.desc);
  const tags = tagsOf(entry);
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

/** `video_info_v2` 那棵树：播放地址、字幕、时长、人声都在它下面。 */
function videoInfo(entry: Record<string, unknown>): Record<string, unknown> {
  return (entry.video_info_v2 ?? {}) as Record<string, unknown>;
}

function videoNode(entry: Record<string, unknown>): Record<string, unknown> {
  const media = (videoInfo(entry).media ?? {}) as Record<string, unknown>;
  return (media.video ?? {}) as Record<string, unknown>;
}

/**
 * 时长**统一成秒**。上游三处口径不一致（SSOT 第 2.3 节）：`capa.duration` 与
 * `media.video.duration` 是秒、`stream[].duration` 是**毫秒**。这里只认 `media.video.duration`——
 * 它和字幕、播放地址在同一棵树里，不会三处混用。
 */
function videoDurationSeconds(entry: Record<string, unknown>): number | undefined {
  const seconds = count(videoNode(entry).duration);
  return seconds > 0 ? seconds : undefined;
}

/**
 * 封面帧。视频的 `images_list` 通常就是那一张封面，**这里是它为空时的兜底**，
 * 顺序按 SSOT 第 8 节：`first_frame` → `thumbnail` → `thumbnail_dim`。
 */
function videoFrameUrl(entry: Record<string, unknown>): string | undefined {
  const image = (videoInfo(entry).image ?? {}) as Record<string, unknown>;
  return normalizeImageUrl(image.first_frame)
    ?? normalizeImageUrl(image.thumbnail)
    ?? normalizeImageUrl(image.thumbnail_dim);
}

/**
 * 人声判据。**`hasHumanVoice` 是字符串 `"true"` / `"false"`，不是布尔**
 * （SSOT 第 2.3 节）——按布尔比会永远不成立，这是本条最容易写错的地方。
 * 字段缺失时才退到连续值 `speech_ratio`，解析失败按「不知道」处理，不让它把整篇带崩。
 */
function hasNoHumanVoice(entry: Record<string, unknown>): boolean {
  const opaque = (videoNode(entry).opaque1 ?? {}) as Record<string, unknown>;
  if (opaque.hasHumanVoice === "false") return true;
  if (opaque.hasHumanVoice !== undefined) return false;
  let ratio: unknown;
  try {
    ratio = (JSON.parse(String(opaque.audioClsInfo ?? "{}")) as Record<string, unknown>).speech_ratio;
  } catch {
    return false;
  }
  const parsed = typeof ratio === "number" ? ratio : Number(ratio);
  return Number.isFinite(parsed) && parsed < SPEECH_RATIO_FLOOR;
}

/**
 * 语言优先级 **`source` → `zh-CN` → 其余第一个非空的**（SSOT 第 2.3 节）。
 * `source` 是原始语言轨——中文视频的原始轨就是中文，所以它排第一。
 * 语言取自 `subtitles` 的**键名**，不是数组项里的 `language` 字段。
 */
function pickSubtitleTrack(subtitles: unknown): { lang: string; url: string } | null {
  const table = (subtitles ?? {}) as Record<string, unknown>;
  if (!table || typeof table !== "object") return null;
  for (const lang of ["source", "zh-CN", ...Object.keys(table)]) {
    const tracks = table[lang];
    if (!Array.isArray(tracks)) continue;
    for (const track of tracks) {
      const url = (track as Record<string, unknown>)?.url;
      if (typeof url === "string" && url.trim()) return { lang, url: url.trim() };
    }
  }
  return null;
}

/**
 * 视频详情 → 内部类型。字段与图文**重合但不保证一致**（SSOT 第 8 节），所以各自一个函数。
 *
 * `playUrl` **刻意不映射**：没有消费者，而且它是带签名的 URL——不进工具输出、日志、SSE、trace
 * （视频理解规格第 4.1 节）。将来真要做画面路线再取。
 */
function toVideoDetail(entry: Record<string, unknown>, fallbackNoteId: string): XhsNoteDetail | null {
  const noteId = noteIdFrom(entry, fallbackNoteId);
  if (!noteId) return null;

  const user = (entry.user ?? {}) as Record<string, unknown>;
  const { text, truncated } = textBody(entry.desc);
  const tags = tagsOf(entry);
  const title = oneLine(entry.title);
  const images = imageUrls(entry.images_list);
  if (images.length === 0) {
    const frame = videoFrameUrl(entry);
    if (frame) images.push(frame);
  }
  // 与图文同一条判据：内容全空才算「这篇没有东西可给」。
  if (!title && !text && tags.length === 0 && images.length === 0) return null;

  const durationSeconds = videoDurationSeconds(entry);
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
    truncated,
    ...(durationSeconds ? { durationSeconds } : {})
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
  const transcriptSeconds = Number(env.XHS_API_TRANSCRIPT_LIMIT ?? TRANSCRIPT_LIMIT);
  const transcriptLimit = Number.isFinite(transcriptSeconds) && transcriptSeconds > 0
    ? Math.floor(transcriptSeconds)
    : TRANSCRIPT_LIMIT;
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

  /**
   * 视频的字幕：**先判人声、再取字幕**（视频理解规格第 4.2 节）。
   *
   * 三种缺失都是**预期内结果**，不是故障：详情本身是成功的，笔记照样返回，只是口播内容缺了。
   * 所以这里返回带 `transcriptIssue` 的笔记，而不是抛错。
   *
   * `.srt` 走 CDN 不走 TikHub，但照样计入本轮耗时预算——它消耗的是同一个用户等待的时间
   * （规格第 5 节）。它**不计入调用次数**，因为不计费。
   */
  async function attachTranscript(
    note: XhsNoteDetail,
    entry: Record<string, unknown>,
    signal: AbortSignal | undefined
  ): Promise<XhsNoteDetail> {
    // 没有人声时**根本不发那次 `.srt` 请求**：省一次网络往返，也避免把「空字幕」和
    // 「取不到字幕」混成同一个 reason。
    if (hasNoHumanVoice(entry)) {
      return { ...note, transcriptIssue: { reason: "no-voice", detail: "上游标记这条视频没有人声" } };
    }
    const track = pickSubtitleTrack(videoNode(entry).subtitles);
    if (!track) {
      return { ...note, transcriptIssue: { reason: "no-transcript", detail: "响应里没有非空的字幕轨" } };
    }
    const url = normalizeUrl(track.url);
    if (!url || !isFetchableTranscriptUrl(url)) {
      // 地址来自上游响应，直接 fetch 等于把「取哪个地址」的决定权交给上游——这是 SSRF 面。
      // 只报 host，**不带签名参数**（签名 URL 不进日志/SSE/trace）。
      return {
        ...note,
        transcriptIssue: {
          reason: "transcript-failed",
          detail: `字幕地址不在允许的域名内（${transcriptHost(track.url)}）`
        }
      };
    }
    const fetched = await fetchTranscript(url, signal);
    if ("failed" in fetched) {
      return { ...note, transcriptIssue: { reason: "transcript-failed", detail: fetched.failed } };
    }
    const parsed = parseSrt(fetched.text);
    if ("failed" in parsed) {
      return { ...note, transcriptIssue: { reason: "transcript-failed", detail: `字幕解析失败：${parsed.failed}` } };
    }
    return { ...note, transcript: { lang: track.lang, ...formatTranscript(parsed.cues, transcriptLimit) } };
  }

  /**
   * 取一次 `.srt`。**只对连接层的即时失败重试一次**：
   * - 超时**不**重试——重试会把等待翻倍，而本轮预算只有 60 秒；
   * - HTTP 错误码**不**重试——签名错了重试还是错（`403` 不会自己好）。
   *
   * 超时信号按**每次尝试**新建：`AbortSignal.timeout` 是一次性的，复用会让第二次立刻失败。
   */
  async function fetchTranscript(
    url: string,
    signal: AbortSignal | undefined
  ): Promise<{ text: string } | { failed: string }> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= TRANSCRIPT_ATTEMPTS; attempt += 1) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          headers: { "user-agent": TRANSCRIPT_USER_AGENT },
          signal: composed
        });
        if (!response.ok) return { failed: `字幕下载失败（HTTP ${response.status}）` };
        return { text: await response.text() };
      } catch (error) {
        lastError = error;
        const name = (error as { name?: string } | null)?.name;
        if (signal?.aborted || name === "TimeoutError" || name === "AbortError") break;
      }
    }
    return { failed: `字幕下载失败（${errorLabel(lastError)}）` };
  }

  return {
    configured,

    async searchNotes(keyword, searchOptions = {}) {
      if (!configured) return { notes: [], hasMore: false, page: searchOptions.page ?? 1 };
      const page = searchOptions.page ?? 1;
      // 有状态分页：首屏只传 keyword + page，第二页起带上首屏给的凭据（SSOT 第 2.1 节）。
      // **不传 `note_type`**：它的默认值就是「不限」，图文与视频一起返回（视频理解规格第 3.1 节）。
      // 不传比显式传中文字面量更不容易抄错，要单独验证视频端点时再从外面加。
      const data = await call(SEARCH_PATH, {
        keyword,
        page: String(page),
        sort_type: "general",
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
        // 视频条目**要留下**，它的 `noteType` 就是详情阶段分流到哪个端点的依据
        // （视频理解规格第 3.2 节）。这里曾经把 video 挡掉，挡的正是现在要的东西。
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
      // 分流必须在**调用前**定：两个端点的响应形状不同，而每次尝试都计费，
      // 所以不存在「先试一个、失败了再试另一个」这种退路（SSOT 第 2.2 节）。
      const isVideo = detailOptions.noteType === "video";
      const data = await call(
        isVideo ? VIDEO_DETAIL_PATH : DETAIL_PATH,
        { note_id: noteId },
        detailOptions.signal,
        { endpoint: "detail", noteId }
      );
      const entry = isVideo ? pickVideoDetailEntry(data.data) : pickDetailEntry(data.data);
      // 空业务数据：这篇确实没内容（供应商明示：这种响应也计费）。
      if (!entry) return null;
      const note = isVideo ? toVideoDetail(entry, noteId) : toDetail(entry, noteId);
      if (!note) {
        // 有数据但读不出内容 = 上游形状变了。带上字段名，别让下一次排查从头再走一遍。
        throw new XhsApiError(`详情响应里没有可用的正文/标题/图片（${describeShape(entry)}）`, {
          code: SHAPE_DRIFT_CODE,
          retryable: false
        });
      }
      if (!isVideo) return note;
      return attachTranscript(note, entry, detailOptions.signal);
    }
  };
}
