// 实验：TikHub 视频笔记端点到底返回什么字段。
// 只跑两次调用（1 次搜索 + 1 次详情），都计费。token 只进请求头，不打印。
// 用法：node --env-file=.env test/L3/probes/xhs-video-probe.mjs

const BASE = (process.env.XHS_API_BASE_URL || "https://api.tikhub.io").replace(/\/+$/, "");
const TOKEN = (process.env.XHS_API_TOKEN || "").trim();

if (!TOKEN) {
  console.error("XHS_API_TOKEN 为空，不发请求。");
  process.exit(1);
}

/** 把带签名的 URL 脱敏：保留 host + path，query 折叠。 */
function safeUrl(value) {
  if (typeof value !== "string") return value;
  try {
    const u = new URL(value);
    const q = [...u.searchParams.keys()];
    return `${u.origin}${u.pathname}${q.length ? `?<${q.length} 个签名参数: ${q.join(",")}>` : ""}`;
  } catch {
    return value.length > 80 ? value.slice(0, 80) + "…" : value;
  }
}

async function call(path, params) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" }
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { http: response.status, body: null, raw: text.slice(0, 300) };
  }
  return { http: response.status, body };
}

/** 递归列出字段路径（只列名字与类型，URL 值脱敏）。 */
function shape(value, prefix = "", depth = 0, out = []) {
  if (depth > 4 || out.length > 120) return out;
  if (Array.isArray(value)) {
    out.push(`${prefix}[] (${value.length} 项)`);
    if (value[0] !== undefined) shape(value[0], `${prefix}[0].`, depth + 1, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const path = prefix ? `${prefix}${k}` : k;
      if (v && typeof v === "object") {
        shape(v, `${path}.`, depth + 1, out);
      } else {
        const shown = typeof v === "string" && /^https?:/.test(v) ? safeUrl(v) : JSON.stringify(v);
        out.push(`${path} = ${typeof v === "string" ? `"${String(shown).slice(0, 120)}"` : shown}`);
      }
    }
    return out;
  }
  out.push(`${prefix} = ${JSON.stringify(value)}`);
  return out;
}

console.log("=== 调用 1/2：搜索视频笔记（note_type=视频笔记）===");
const search = await call("/api/v1/xiaohongshu/app_v2/search_notes", {
  keyword: "妆容教程",
  note_type: "视频笔记",
  page: "1"
});

console.log(`HTTP ${search.http}`);
console.log(`外层 code=${search.body?.code} message=${search.body?.message ?? ""}`);
console.log(`内层 code=${search.body?.data?.code} success=${search.body?.data?.success} msg=${search.body?.data?.msg ?? ""}`);
if (search.body?.cache_url) console.log(`排障用 cache_url: ${safeUrl(search.body.cache_url)}`);

const items = search.body?.data?.data?.items ?? [];
console.log(`\n条目数: ${items.length}`);

const videoNotes = [];
for (const entry of items) {
  const note = entry?.note ?? entry?.note_card ?? entry;
  if (!note?.id) continue;
  videoNotes.push({ id: note.id, type: note.type, title: String(note.title ?? "").slice(0, 30) });
}
console.log("条目 id / type / 标题：");
for (const n of videoNotes.slice(0, 8)) console.log(`  ${n.id}  type=${n.type}  ${n.title}`);
console.log(`\n其中 type=video 的: ${videoNotes.filter((n) => n.type === "video").length} 条`);

const target = videoNotes.find((n) => n.type === "video") ?? videoNotes[0];
if (!target) {
  console.log("\n没有拿到任何条目 id，实验止步（搜索没返回可用 id）。");
  process.exit(0);
}
console.log(`\n拿它做详情实验: ${target.id}（type=${target.type}）`);

console.log("\n=== 调用 2/2：get_video_note_detail ===");
const detail = await call("/api/v1/xiaohongshu/app_v2/get_video_note_detail", { note_id: target.id });
console.log(`HTTP ${detail.http}`);
console.log(`外层 code=${detail.body?.code} message=${detail.body?.message ?? ""}`);
console.log(`内层 code=${detail.body?.data?.code} success=${detail.body?.data?.success} msg=${detail.body?.data?.msg ?? ""}`);
if (detail.body?.cache_url) console.log(`排障用 cache_url: ${safeUrl(detail.body.cache_url)}`);

if (detail.body?.data?.code !== 0 || detail.body?.data?.success !== true) {
  console.log("\n内层没成功，原始（截断）:");
  console.log(JSON.stringify(detail.body?.data ?? detail.body, null, 2).slice(0, 800));
  process.exit(0);
}

// 详情形状：SSOT 说图文是 data.data[0].note_list[0]，视频端点待验。
const inner = detail.body.data.data;
console.log(`\n内层 data 类型: ${Array.isArray(inner) ? `数组(${inner.length})` : typeof inner}`);
const entry = Array.isArray(inner) ? (inner[0]?.note_list?.[0] ?? inner[0]) : (inner?.note_list?.[0] ?? inner?.note ?? inner);
if (!entry || typeof entry !== "object") {
  console.log("取不到笔记本体，原始（截断）:", JSON.stringify(inner, null, 2).slice(0, 800));
  process.exit(0);
}

console.log("\n=== 笔记本体的字段（视频端点）===");
for (const line of shape(entry)) console.log(`  ${line}`);

// 专门找播放地址
console.log("\n=== 疑似播放地址的字段 ===");
const hits = [];
(function hunt(value, prefix = "", depth = 0) {
  if (depth > 5 || !value) return;
  if (Array.isArray(value)) return value.forEach((v, i) => hunt(v, `${prefix}[${i}].`, depth + 1));
  if (typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    const path = `${prefix}${k}`;
    if (typeof v === "string" && /^https?:/.test(v) && /(video|stream|play|media|mp4|master)/i.test(k + v)) {
      hits.push(`${path} → ${safeUrl(v)}`);
    }
    hunt(v, `${path}.`, depth + 1);
  }
})(entry);
console.log(hits.length ? hits.map((h) => `  ${h}`).join("\n") : "  （没找到明显的播放地址字段）");
