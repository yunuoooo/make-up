// 定向探测 2：展开 stream_types / bound / 字幕字段，并打印完整 cache_url（24h 内复查免费）。
// 只跑 1 次详情调用。用法：node --env-file=.env test/L3/probes/xhs-video-probe2.mjs <noteId>

const BASE = (process.env.XHS_API_BASE_URL || "https://api.tikhub.io").replace(/\/+$/, "");
const TOKEN = (process.env.XHS_API_TOKEN || "").trim();
const NOTE_ID = process.argv[2] || "6a86e5fc00000000280006f7";

if (!TOKEN) {
  console.error("XHS_API_TOKEN 为空，不发请求。");
  process.exit(1);
}

function safe(value) {
  if (typeof value !== "string" || !/^https?:/.test(value)) return value;
  try {
    const u = new URL(value);
    return `${u.origin}${u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    return value.slice(0, 60);
  }
}

const url = new URL(`${BASE}/api/v1/xiaohongshu/app_v2/get_video_note_detail`);
url.searchParams.set("note_id", NOTE_ID);
const response = await fetch(url, {
  headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" }
});
const body = await response.json();

console.log(`HTTP ${response.status} · 外层 code=${body?.code}`);
console.log(`内层 code=${body?.data?.code} success=${body?.data?.success}`);
console.log(`\n★ 完整 cache_url（24h 内可直接打开复查，不再计费）：\n${body?.cache_url ?? "(无)"}`);

const inner = body?.data?.data;
console.log(`\n内层 data: ${Array.isArray(inner) ? `数组(${inner.length})` : typeof inner}`);
const entry = Array.isArray(inner) ? (inner[0]?.note_list?.[0] ?? inner[0]) : (inner?.note_list?.[0] ?? inner?.note ?? inner);

console.log("\n=== video_info_v2 完整展开（URL 只留 origin+path）===");
const vi = entry?.video_info_v2;
console.log(JSON.stringify(vi, (k, v) => safe(v), 2));

console.log("\n=== 全笔记里所有 URL 字段（去重，按字段名）===");
const seen = new Map();
(function hunt(value, prefix = "", depth = 0) {
  if (depth > 8 || !value) return;
  if (Array.isArray(value)) return value.forEach((v, i) => hunt(v, `${prefix}[${i}]`, depth + 1));
  if (typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    const path = `${prefix}.${k}`;
    if (typeof v === "string" && /^https?:/.test(v)) {
      const host = (() => { try { return new URL(v).host; } catch { return "?"; } })();
      const key = `${k} @ ${host}`;
      if (!seen.has(key)) seen.set(key, path);
    }
    hunt(v, path, depth + 1);
  }
})(entry);
for (const [key, path] of seen) console.log(`  ${key}\n      首次出现于 ${path}`);

console.log("\n=== 字幕相关字段 ===");
const subs = [];
(function hunt2(value, prefix = "", depth = 0) {
  if (depth > 8 || !value) return;
  if (Array.isArray(value)) return value.forEach((v, i) => hunt2(v, `${prefix}[${i}]`, depth + 1));
  if (typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    const path = `${prefix}.${k}`;
    if (/subtitle|sub_title|caption|translat|lang/i.test(k)) subs.push(`${path} = ${JSON.stringify(v)?.slice(0, 200)}`);
    hunt2(v, path, depth + 1);
  }
})(entry);
console.log(subs.length ? subs.join("\n") : "  （没有字幕字段）");
