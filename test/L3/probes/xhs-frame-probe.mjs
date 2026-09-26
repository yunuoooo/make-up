// 试：小红书 CDN 的 frame/ URL 能否按序号取到不同帧（若成立，抽帧就不需要 ffmpeg）。
// 读的是免费 cache，不产生 TikHub 计费。
import { createHash } from "node:crypto";

const CACHE_URL = "https://cache.tikhub.io/api/v1/cache/public/4f1ca4b5-918f-4bd3-93c4-4afb35611345?sign=EXPIRED_REPLACE_ME";

const b = await (await fetch(CACHE_URL)).json();
const inner = b?.data?.data?.data;
const entry = inner[0]?.note_list?.[0] ?? inner[0];
const img = entry?.video_info_v2?.image ?? {};

console.log("封面字段（去掉签名）:");
for (const [k, v] of Object.entries(img)) console.log(`  ${k}: ${String(v).split("?")[0]}`);

const thumb = img.thumbnail;
if (!thumb) {
  console.log("\n没有 thumbnail 字段，止步。");
  process.exit(0);
}

console.log("\n=== 试改帧序号（_0 → _N）===");
const seen = new Map();
for (const idx of [0, 1, 2, 3, 5, 10, 30, 60, 100, 200, 500, 1000]) {
  const u = thumb.replace(/_\d+\.webp/, `_${idx}.webp`);
  try {
    const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } });
    const buf = Buffer.from(await r.arrayBuffer());
    const h = createHash("md5").update(buf).digest("hex").slice(0, 12);
    const dup = seen.has(h) ? ` ⚠ 与 _${seen.get(h)} 字节相同` : "";
    if (!seen.has(h)) seen.set(h, idx);
    console.log(`  _${String(idx).padEnd(5)} HTTP ${r.status} · ${String(buf.length).padStart(7)}B · md5=${h}${dup}`);
  } catch (e) {
    console.log(`  _${idx}: 失败 ${e.message}`);
  }
}
console.log(`\n不同的图片数: ${seen.size} / 12`);
