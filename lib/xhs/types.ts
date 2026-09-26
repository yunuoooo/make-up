/**
 * 小红书取数的内部类型：技能和工具层只认这里的字段。
 *
 * 上游字段名、取值链和映射规则见 docs/specs/09-24-tikhub-xhs-ssot.md 第 8 节；
 * 换供应商时改的是映射实现（同目录的 tikhub.ts），不是这些类型。
 */

export type XhsNoteStats = {
  liked: number;
  comments: number;
  collected: number;
  shared: number;
};

export type XhsNoteSummary = {
  noteId: string;
  title: string;
  authorName?: string;
  /** `normal` 图文 / `video` 视频。 */
  noteType?: string;
  /** 展示用日期 `YYYY-MM-DD`（服务端把 Unix 秒格式化好，不让模型换算时间戳）。 */
  postedAt?: string;
  stats?: XhsNoteStats;
  /** **截断预览**，不是正文：实测约 60 字符（SSOT 第 6 节）。 */
  preview?: string;
  cover?: string;
};

/**
 * 视频字幕：带 `[MM:SS]` 时间戳的纯文本（`lib/xhs/transcript.ts` 负责解析与格式化）。
 *
 * 刻意不是 `segments` 数组：消费者是模型不是前端，`[MM:SS]` 前缀比 JSON 对象省 token、
 * 读起来也自然（视频理解规格第 3.3 节）。
 */
export type XhsTranscript = {
  /** 语言轨的**键名**：`source`（原始语言）/ `zh-CN` / …（SSOT 第 2.3 节）。 */
  lang: string;
  text: string;
  truncated: boolean;
};

/**
 * 字幕没拿到的原因。**这三种都是预期内的结果，不是故障**：详情本身是成功的，
 * 笔记照样返回，只是口播内容缺了——所以用 `reason` 表达，不抛错。
 *
 * `detail` 是「卡在哪一步」的事实描述（域名不允许 / 下载失败 / 格式认不出），
 * 只有 `transcript-failed` 会用到；面向模型的那句话由工具层组装。
 */
export type XhsTranscriptIssue = {
  reason: "no-voice" | "no-transcript" | "transcript-failed";
  detail: string;
};

export type XhsNoteDetail = {
  noteId: string;
  title: string;
  authorName?: string;
  noteType?: string;
  postedAt?: string;
  ipLocation?: string;
  /** 正文全文。只有详情接口给全，搜索的 preview 不能替代（SSOT 第 6 节）。 */
  text: string;
  tags: string[];
  stats?: XhsNoteStats;
  images: string[];
  /** 正文被截断到上限时为 true。 */
  truncated: boolean;
  /** 视频时长，**统一成秒**（上游三处口径不一致，SSOT 第 2.3 节）。只有视频笔记有。 */
  durationSeconds?: number;
  /** 视频字幕。**只在取到并解析成功时出现**（视频理解规格第 4.1 节）。 */
  transcript?: XhsTranscript;
  /** 字幕没拿到时的原因。与 `transcript` 互斥。 */
  transcriptIssue?: XhsTranscriptIssue;
};

export type XhsSearchPage = {
  notes: XhsNoteSummary[];
  hasMore: boolean;
  page: number;
};

/**
 * 单次上游调用的观测信息。
 *
 * **刻意没有 URL**：完整 URL 永远不进观测数据、日志或错误信息（沿用本仓库既有的纪律）。
 * 换到 TikHub 之后 token 走**请求头**，URL 本身已经不含凭据了，所以这里的理由是
 * 「少一处会泄漏的东西」而不是「URL 里有 token」——纪律不变，只是依据变了。
 */
export type XhsCallInfo = {
  endpoint: "search" | "detail";
  durationMs: number;
  ok: boolean;
  /** 业务码（SSOT 第 4 节）；负数是我们自己的：-1 没拿到信封，-2 信封正常但形状读不出内容。 */
  code?: number;
  /** 上游 requestId，用于对账。 */
  requestId?: string;
  keyword?: string;
  noteId?: string;
};
