/**
 * `.srt` 字幕 → 带 `[MM:SS]` 时间戳的纯文本。
 *
 * 消费者是模型不是前端（视频理解规格第 3.3 节）：`[MM:SS]` 前缀比 JSON 对象省 token、
 * 读起来也自然；时间戳由服务端格式化好，和 `postedAt` 一样**不让模型做换算**。
 *
 * 格式与解析口径见 SSOT 第 2.3 节：标准 SRT，空行分块、块内找含 `-->` 的那一行、
 * 它前面是序号、后面是正文（正文可能多行）。**认不出结构就不猜**——格式漂移在这条链路上
 * 已经发生过，静默丢内容比明确失败贵得多。
 */

/**
 * 允许取字幕的 CDN 域名（含子域）。
 *
 * 字幕地址来自上游响应，直接 fetch 等于把「取哪个地址」的决定权交给上游——那是 SSRF 面。
 * `xhscdn.com` 是小红的图片/视频 CDN，`rednotecdn.com` 是**字幕与头像/封面帧**实际所在的域名。
 *
 * ⚠️ 视频理解规格第 6.1 节只写了 `xhscdn.com`，**那样会拒掉全部真实字幕**：
 * 2026-09-26 实测字幕地址是 `sns-subtitle-s8.rednotecdn.com`（SSOT 第 2.3 节）。
 * 两个都要认，否则这条链路永远只会给出 `transcript-failed`。
 */
const ALLOWED_HOSTS = ["xhscdn.com", "rednotecdn.com"];

export type TranscriptCue = {
  /** 已格式化的起点，`MM:SS`（累计分钟，见 `stamp`）。 */
  start: string;
  text: string;
};

export type ParsedTranscript = { cues: TranscriptCue[] } | { failed: string };

/** 只允许 https 且落在白名单域名内。`undefined`／读不出 host 一律不放行。 */
export function isFetchableTranscriptUrl(raw: string | undefined): raw is string {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return ALLOWED_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

/** 排障用的 host，**不含签名参数**（签名 URL 不进日志/SSE/trace，SSOT 第 6.4 节）。 */
export function transcriptHost(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return "地址读不出来";
  }
}

/**
 * `HH:MM:SS,mmm` → `MM:SS`。
 *
 * 只输出一种格式：累计分钟（75 分钟的视频就是 `[75:30]`，不会变成 `[01:15:30]`），
 * 免得模型一会儿读两位一会儿读三位。毫秒分隔符按 SSOT 是**逗号**，点号的变体一并收——
 * 那是同一个格式的无害变体，为它整篇失败不划算。
 */
function stamp(raw: string): string | null {
  const match = /^(\d{1,3}):([0-5]\d):([0-5]\d)[,.](\d{1,3})$/.exec(raw.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return `${String(minutes).padStart(2, "0")}:${match[3]}`;
}

/**
 * 解析 `.srt`。**整篇结构认不出就是失败**，不返回「能读几条算几条」：
 * 半份字幕会让模型以为讲解就到这里。
 */
export function parseSrt(input: string): ParsedTranscript {
  const blocks = input.replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  const cues: TranscriptCue[] = [];
  let blocksWithAxis = 0;

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const axis = lines.findIndex((line) => line.includes("-->"));
    // 没有时间轴的块是噪声（BOM、尾注、广告行），跳过。
    if (axis === -1) continue;
    blocksWithAxis += 1;
    const start = stamp(lines[axis].split("-->")[0]);
    // 有时间轴却读不出来 = 格式漂移，明确失败。
    if (!start) return { failed: `时间轴不是 HH:MM:SS,mmm：${lines[axis].split("-->")[0].trim().slice(0, 40)}` };
    const text = lines.slice(axis + 1).join(" ").trim();
    if (text) cues.push({ start, text });
  }

  if (blocksWithAxis === 0) return { failed: "整份文件里没有一行时间轴" };
  if (cues.length === 0) return { failed: "有时间轴但一条正文都没有" };
  return { cues };
}

/**
 * 拼成 `[MM:SS] 正文` 的多行文本，超上限截断。
 *
 * 上限独立于正文的 `TEXT_LIMIT`（视频理解规格第 5 节）：正文 8000 字符够用，但十分钟的
 * 教程字幕会超过它，而**字幕被截断的代价比正文大**——讲解是连续的，丢了尾巴等于没讲完。
 */
export function formatTranscript(cues: TranscriptCue[], limit: number): { text: string; truncated: boolean } {
  const text = cues.map((cue) => `[${cue.start}] ${cue.text}`).join("\n");
  if (text.length <= limit) return { text, truncated: false };
  const head = text.slice(0, limit);
  // 切在整行边界：半句话的尾行会让模型以为讲解就停在那里。
  const lastBreak = head.lastIndexOf("\n");
  return { text: lastBreak > 0 ? head.slice(0, lastBreak) : head, truncated: true };
}
