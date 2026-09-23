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
};

export type XhsSearchPage = {
  notes: XhsNoteSummary[];
  hasMore: boolean;
  page: number;
};

/**
 * 单次上游调用的观测信息。
 *
 * **刻意没有 URL**：token 走 query 参数，完整 URL 永远不进观测数据、日志或错误信息
 * （沿用本仓库既有的纪律，见 SSOT 第 11 节）。
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
