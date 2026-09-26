// 抽样：视频笔记的字幕覆盖率，跨排序、跨热度，并看是否与「有人声」相关。
// 打 2 次搜索 + 10 次详情（计费）。cache_url 会打印，后续复检免费。
// 用法：node --env-file=.env test/L3/probes/xhs-subtitle-coverage.mjs

const BASE = (process.env.XHS_API_BASE_URL || "https://api.tikhub.io").replace(/\/+$/, "");
const TOKEN = (process.env.XHS_API_TOKEN || "").trim();
if (!TOKEN) { console.error("XHS_API_TOKEN 为空"); process.exit(1); }

async function call(path, params) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" } });
  return { http: r.status, body: await r.json() };
}

function pick(body) {
  const inner = body?.data?.data;
  const entry = Array.isArray(inner) ? (inner[0]?.note_list?.[0] ?? inner[0]) : (inner?.note_list?.[0] ?? inner?.note ?? inner);
  if (!entry) return null;
  const v = entry?.video_info_v2?.media?.video ?? {};
  const subs = v.subtitles ?? {};
  const langs = Object.keys(subs).filter((k) => Array.isArray(subs[k]) && subs[k].length > 0);
  const opaque = v.opaque1 ?? {};
  let speechRatio = null;
  try { speechRatio = JSON.parse(opaque.audioClsInfo ?? "{}").speech_ratio ?? null; } catch {}
  return {
    id: entry.id,
    title: String(entry.title ?? "").slice(0, 22),
    noteType: entry.type,
    duration: entry?.video_info_v2?.capa?.duration ?? null,
    likes: entry.liked_count ?? null,
    langs,
    hasHumanVoice: opaque.hasHumanVoice ?? null,
    speechRatio,
    isSupportSubtitle: opaque.isSupportSubtitle ?? null
  };
}

const sorts = [
  ["general", "综合（偏热门）"],
  ["time_descending", "最新（偏新发布）"]
];

const rows = [];
for (const [sortType, label] of sorts) {
  console.log(`\n=== 搜索：${label} ===`);
  const s = await call("/api/v1/xiaohongshu/app_v2/search_notes", { keyword: "妆容教程", note_type: "视频笔记", sort_type: sortType, page: "1" });
  const items = s.body?.data?.data?.items ?? [];
  const notes = items.map((e) => (e.note ?? e.note_card ?? e)).filter((n) => n?.id && n.type === "video");
  console.log(`  拿到 ${notes.length} 条 video，取前 5 条做详情`);
  // 取前 5 条（热度最高的）
  const sample = notes.slice(0, 5);
  const details = await Promise.all(sample.map((n) => call("/api/v1/xiaohongshu/app_v2/get_video_note_detail", { note_id: n.id })));
  details.forEach((d, i) => {
    const info = pick(d.body);
    if (!info) { console.log(`  #${i + 1} 映射失败`); return; }
    rows.push({ sort: label, ...info });
    console.log(`  #${i + 1} [${info.langs.length ? info.langs.join("/") : "无字幕"}] ${String(info.duration).padStart(4)}s 赞${String(info.likes).padStart(6)} 人声=${info.hasHumanVoice} speech=${info.speechRatio?.toFixed(2) ?? "?"}  ${info.title}`);
  });
}

console.log("\n\n========== 汇总 ==========");
const withSub = rows.filter((r) => r.langs.length > 0);
console.log(`总数 ${rows.length} · 有字幕 ${withSub.length} · 覆盖率 ${(withSub.length / rows.length * 100).toFixed(0)}%`);
for (const [label] of sorts.map((s) => [s[1]])) {
  const sub = rows.filter((r) => r.sort === label);
  const ok = sub.filter((r) => r.langs.length > 0).length;
  console.log(`  ${label}: ${ok}/${sub.length}`);
}

console.log("\n语言轨道分布:");
const langCount = {};
for (const r of withSub) for (const l of r.langs) langCount[l] = (langCount[l] ?? 0) + 1;
for (const [l, c] of Object.entries(langCount).sort((a, b) => b[1] - a[1])) console.log(`  ${l}: ${c}`);

console.log("\n有字幕 vs 人声 的交叉:");
const voiceYes = rows.filter((r) => r.hasHumanVoice === "true");
const voiceNo = rows.filter((r) => r.hasHumanVoice !== "true");
console.log(`  有人声 ${voiceYes.length} 条，其中带字幕 ${voiceYes.filter((r) => r.langs.length).length}`);
console.log(`  无人声 ${voiceNo.length} 条，其中带字幕 ${voiceNo.filter((r) => r.langs.length).length}`);

console.log("\n无字幕的样本（看是否有共性）:");
for (const r of rows.filter((r) => !r.langs.length)) {
  console.log(`  ${String(r.duration).padStart(4)}s 赞${String(r.likes).padStart(6)} 人声=${r.hasHumanVoice} speech=${r.speechRatio?.toFixed(2) ?? "?"} ${r.title}`);
}
