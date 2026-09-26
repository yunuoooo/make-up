// 实测各段延迟：搜索 / 详情（并行）/ 字幕取回 / 视频下载。
// 打 4 次 TikHub（1 搜索 + 3 详情，计费），字幕与下载不再计费。
// 用法：node --env-file=.env test/L3/probes/xhs-latency-probe.mjs

const BASE = (process.env.XHS_API_BASE_URL || "https://api.tikhub.io").replace(/\/+$/, "");
const TOKEN = (process.env.XHS_API_TOKEN || "").trim();
if (!TOKEN) { console.error("XHS_API_TOKEN 为空"); process.exit(1); }

const t = () => Number(process.hrtime.bigint()) / 1e6;
const ms = (n) => `${n.toFixed(0)}ms`;

async function call(path, params) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  const started = t();
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" } });
  const body = await r.json();
  return { elapsed: t() - started, http: r.status, body };
}

console.log("=== 1. 搜索（单次）===");
const search = await call("/api/v1/xiaohongshu/app_v2/search_notes", { keyword: "妆容教程", note_type: "视频笔记", page: "1" });
console.log(`  搜索延迟: ${ms(search.elapsed)}  (HTTP ${search.http}, code=${search.body?.code})`);

const items = search.body?.data?.data?.items ?? [];
const ids = items.map((e) => (e.note ?? e.note_card ?? e)?.id).filter(Boolean).slice(0, 3);
console.log(`  拿到 ${ids.length} 个 noteId`);

console.log("\n=== 2. 详情（3 个并行）===");
const parallelStart = t();
const details = await Promise.all(ids.map((id) => call("/api/v1/xiaohongshu/app_v2/get_video_note_detail", { note_id: id })));
const parallelTotal = t() - parallelStart;
details.forEach((d, i) => console.log(`  #${i + 1} ${ids[i]} 单个耗时 ${ms(d.elapsed)} · 内层 code=${d.body?.data?.code}`));
console.log(`  3 个并行的墙钟总耗时: ${ms(parallelTotal)}`);
console.log("  cache_url（24h 内复检免费）:");
details.forEach((d, i) => console.log(`    #${i + 1} ${d.body?.cache_url ?? "(无)"}`));

// 从详情里取字幕 URL
function extract(body) {
  const inner = body?.data?.data;
  const entry = Array.isArray(inner) ? (inner[0]?.note_list?.[0] ?? inner[0]) : (inner?.note_list?.[0] ?? inner?.note ?? inner);
  const subs = entry?.video_info_v2?.media?.video?.subtitles ?? {};
  const pick = subs["zh-CN"]?.[0]?.url ?? subs.source?.[0]?.url;
  const stream = entry?.video_info_v2?.media?.stream;
  const all = Object.values(stream ?? {}).flat().filter(Boolean);
  const best = all.find((x) => x.default_stream === 1) ?? all[0];
  const capa = entry?.video_info_v2?.capa?.duration;
  return { subUrl: pick ? pick.replace(/^http:\/\//, "https://") : null, videoUrl: best?.master_url?.replace(/^http:\/\//, "https://") ?? null, duration: capa };
}

console.log("\n=== 4. 字幕取回（并行，不计费）===");
const meta = details.map((d) => extract(d.body));
const subUrls = meta.map((m) => m.subUrl).filter(Boolean);
console.log(`  可用的字幕 URL: ${subUrls.length} / 3`);
if (subUrls.length) {
  const s = t();
  const subs = await Promise.all(subUrls.map((u) => fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.text()).catch((e) => "ERR:" + e.message)));
  const subTotal = t() - s;
  subs.forEach((text, i) => console.log(`  #${i + 1} ${text.length} 字符${text.startsWith("ERR") ? " " + text.slice(0, 60) : ""}`));
  console.log(`  字幕并行总耗时: ${ms(subTotal)}`);
}

console.log("\n=== 5. 视频下载（Range 只取 2MB，不计费）===");
const vurl = meta.find((m) => m.videoUrl)?.videoUrl;
if (vurl) {
  const s = t();
  const r = await fetch(vurl, { headers: { Range: "bytes=0-2097151" } });
  const buf = await r.arrayBuffer();
  const el = t() - s;
  console.log(`  2MB 耗时 ${ms(el)} → 折算 ~${(2 / (el / 1000)).toFixed(1)} MB/s`);
  const dur = meta.find((m) => m.duration)?.duration;
  if (dur) {
    const full = 74.5; // 上次实测 71MB / 418s 的量级，用 2MB 抽样外推
    console.log(`  外推：按此速率，整段下载量级 ≈ ${(full / (2 / (el / 1000))).toFixed(1)}s（仅参考）`);
  }
}

console.log("\n=== 汇总 ===");
console.log(`  搜索            ${ms(search.elapsed)}`);
console.log(`  详情×3 并行     ${ms(parallelTotal)}`);

