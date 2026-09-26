// 在完整响应里猎捕 OCR 文本。全程读免费 cache。
const CACHES = [
  "https://cache.tikhub.io/api/v1/cache/public/396d6e99-4744-435e-9a2b-18f0afe632a4?sign=EXPIRED_REPLACE_ME",
  "https://cache.tikhub.io/api/v1/cache/public/42c80629-c87f-43c0-9d00-0b6242257dd2?sign=EXPIRED_REPLACE_ME",
  "https://cache.tikhub.io/api/v1/cache/public/bd113ad7-e5a8-4b7e-a844-857c6baab75e?sign=EXPIRED_REPLACE_ME"
];

/** 收集全树里所有键名，并单独挑出 ocr 相关的。 */
function scan(value, path = "", out = { keys: new Set(), ocr: [] }, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => scan(v, `${path}[${i}]`, out, depth + 1));
    return out;
  }
  if (typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value)) {
    out.keys.add(k);
    const p = path ? `${path}.${k}` : k;
    if (/ocr/i.test(k)) out.ocr.push({ path: p, value: v });
    scan(v, p, out, depth + 1);
  }
  return out;
}

const bodies = [];
for (const [i, url] of CACHES.entries()) {
  const r = await fetch(url);
  bodies.push(await r.json());
}
console.log(`读回 ${bodies.length} 份 cache\n`);

// 1) 三份响应的键名并集
const allKeys = new Set();
for (const b of bodies) {
  const { keys } = scan(b);
  for (const k of keys) allKeys.add(k);
}
console.log(`=== 响应里出现过的所有键名（${allKeys.size} 个，按字母序）===`);
console.log([...allKeys].sort().join(", "));

// 2) OCR 相关字段
console.log(`\n\n=== 含 "ocr" 的字段 ===`);
for (const [i, b] of bodies.entries()) {
  const { ocr } = scan(b);
  console.log(`\n--- cache #${i + 1}：${ocr.length} 处 ---`);
  for (const { path, value } of ocr) {
    const json = JSON.stringify(value);
    console.log(`  ${path}\n     ${json.length > 300 ? json.slice(0, 300) + "…" : json}`);
  }
}

// 3) 找所有「看起来像成段文本」的字符串字段（可能是 OCR 结果藏在别的名字下）
console.log(`\n\n=== 疑似成段文本的字段（长度 >12 且含中文，排除已知的 desc/title/字幕）===`);
const IGNORE = /(desc|title|nickname|share_info|hash_tag|feedback|widget|debug|placeholder|text_|_text$)/i;
for (const [i, b] of bodies.entries()) {
  const found = [];
  (function walk(v, path = "", depth = 0) {
    if (depth > 12 || v === null || v === undefined) return;
    if (Array.isArray(v)) return v.forEach((x, j) => walk(x, `${path}[${j}]`, depth + 1));
    if (typeof v !== "object") return;
    for (const [k, val] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k;
      if (typeof val === "string" && /[一-龥]/.test(val) && val.length > 12 && !IGNORE.test(p)) {
        found.push(`${p} = ${val.slice(0, 120)}`);
      }
      walk(val, p, depth + 1);
    }
  })(b);
  console.log(`\n--- cache #${i + 1}：${found.length} 处 ---`);
  console.log(found.slice(0, 25).map((f) => "  " + f).join("\n") || "  (无)");
}
