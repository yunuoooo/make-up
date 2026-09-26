/**
 * 取数记录页面的取值与显示助手。
 *
 * 这里读的是**工具返回的原始 JSON**（`unknown`），不是内部类型——页面要展示的就是那一份。
 * 所以一律窄化取值、拿不到就当没有，**不做类型断言**：断言会在上游改字段（或旧会话是更早的
 * 形状）时让整页白屏，而排查工具白屏是最不划算的一种失败。
 */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 只收非空字符串：空串在界面上和「没有」没区别，展示上是噪声。 */
export function asText(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "";
}

export function asNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function asStrings(value: unknown): string[] {
  return asList(value).map(asText).filter(Boolean);
}

/** 绝对时间（排查时要对得上日志，所以不用「3 分钟前」那种相对说法）。 */
export function timeLabel(ms: number): string {
  if (!ms) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(ms));
}

export type TranscriptLine = { stamp: string; body: string };

/**
 * 字幕文本 → 可渲染的行。文本本身就是 `[MM:SS] 正文` 的一行一条（服务端格式化好的），
 * 所以这里只是把它拆开展示，**不做任何改写**：若哪天格式变了，认不出的行原样返回。
 */
export function splitTranscript(value: unknown): TranscriptLine[] {
  return asText(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
      return match ? { stamp: match[1], body: match[2] } : { stamp: "", body: line };
    });
}

/** 互动数：只展示大于 0 的项，四项全 0 就当没有。 */
export function statItems(value: unknown): { label: string; value: string }[] {
  const stats = asRecord(value);
  if (!stats) return [];
  const rows: { label: string; value: string }[] = [];
  for (const [key, label] of [["liked", "赞"], ["collected", "藏"], ["comments", "评"], ["shared", "转"]] as const) {
    const count = asNumber(stats[key]);
    if (count !== null && count > 0) rows.push({ label, value: count.toLocaleString("zh-CN") });
  }
  return rows;
}

/** 秒 → `7:23`。视频时长用，比 `443 秒` 好读。 */
export function durationLabel(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return "";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
}
