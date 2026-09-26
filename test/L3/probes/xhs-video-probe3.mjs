// 定向探测 3：从【免费的 cache_url】读响应，验字幕与视频能否直接下载。
// 不再打 TikHub，不产生任何计费。
// 用法：node --env-file=.env test/L3/probes/xhs-video-probe3.mjs

const CACHE_URL = "https://cache.tikhub.io/api/v1/cache/public/4f1ca4b5-918f-4bd3-93c4-4afb35611345?sign=EXPIRED_REPLACE_ME";

const cache = await fetch(CACHE_URL, { headers: { Accept: "application/json" } });
const body = await cache.json();
console.log(`cache 读取 HTTP ${cache.status}`);

const inner = body?.data?.data?.data;
console.log(`内层 data: ${Array.isArray(inner) ? `数组(${inner.length})` : typeof inner}`);
const entry = Array.isArray(inner) ? (inner[0]?.note_list?.[0] ?? inner[0]) : (inner?.note_list?.[0] ?? inner?.note ?? inner);
const video = entry?.video_info_v2?.media?.video;
const stream = entry?.video_info_v2?.media?.stream;

console.log("\n=== media.stream 的 codec 键与每项的字段 ===");
console.log(`codec 键: ${Object.keys(stream ?? {}).join(", ")}`);
for (const [codec, list] of Object.entries(stream ?? {})) {
  console.log(`\n[${codec}] ${Array.isArray(list) ? list.length : "?"} 项`);
  for (const item of (Array.isArray(list) ? list : []).slice(0, 3)) {
    console.log(`  stream_type=${item.stream_type} codec=${item.video_codec} ${item.width}x${item.height} ` +
      `weight=${item.weight} default=${item.default_stream} duration=${item.duration}ms ` +
      `\n    master_url: ${item.master_url}` +
      `\n    backup_urls: ${(item.backup_urls ?? []).length} 个` +
      (item.audio_bitrate ? `\n    audio_bitrate=${item.audio_bitrate} channels=${item.audio_channels}` : ""));
  }
}

// 单位陷阱核对
console.log("\n=== duration 单位核对（三个字段）===");
console.log(`  capa.duration        = ${entry?.video_info_v2?.capa?.duration}`);
console.log(`  media.video.duration = ${video?.duration}`);
const firstStream = Object.values(stream ?? {})[0]?.[0];
console.log(`  stream[0].duration   = ${firstStream?.duration}  (看着是毫秒)`);

// ---- 下载验证：字幕 ----
const normalize = (u) => u.replace(/^http:\/\//i, "https://");
const subUrl = normalize(video?.subtitles?.["zh-CN"]?.[0]?.url ?? "");
console.log(`\n=== 验 1：中文字幕能否直接取 ===\n  ${subUrl.split("?")[0]}`);
if (subUrl) {
  try {
    const r = await fetch(subUrl, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.xiaohongshu.com/" } });
    console.log(`  HTTP ${r.status} · content-type=${r.headers.get("content-type")} · ${r.headers.get("content-length") ?? "?"} bytes`);
    if (r.ok) {
      const text = await r.text();
      console.log(`  正文字符数: ${text.length}`);
      console.log("  --- 前 400 字 ---");
      console.log(text.slice(0, 400).split("\n").map((l) => "  " + l).join("\n"));
    }
  } catch (e) {
    console.log(`  取字幕失败: ${e.message}`);
  }
}

// ---- 下载验证：视频（只取前 256KB，验防盗链）----
const videoUrl = normalize(firstStream?.master_url ?? "");
console.log(`\n=== 验 2：视频直链能否下载（只取前 256KB）===\n  ${videoUrl.split("?")[0]}`);
if (videoUrl) {
  for (const [label, headers] of [
    ["裸请求（无 Referer/UA）", {}],
    ["带 UA + Referer", { "User-Agent": "Mozilla/5.0", Referer: "https://www.xiaohongshu.com/" }]
  ]) {
    try {
      const r = await fetch(videoUrl, { headers: { ...headers, Range: "bytes=0-262143" } });
      const buf = await r.arrayBuffer();
      const magic = new TextDecoder().decode(new Uint8Array(buf.slice(4, 12)));
      console.log(`  ${label}: HTTP ${r.status} · ${buf.byteLength} bytes · ftyp=${JSON.stringify(magic)} · ` +
        `content-range=${r.headers.get("content-range") ?? "-"} · type=${r.headers.get("content-type")}`);
    } catch (e) {
      console.log(`  ${label}: 失败 ${e.message}`);
    }
  }
}

// ---- 备用地址 ----
console.log(`\n=== 备用地址（backup_urls）===\n${(firstStream?.backup_urls ?? []).map((u) => "  " + normalize(u).split("?")[0]).join("\n") || "  （无）"}`);
