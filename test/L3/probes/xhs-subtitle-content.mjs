// 取回 3 条真实字幕正文，看里面到底有没有具体化妆品名字。
// 全程读免费 cache，不打 TikHub。
const CACHES = [
  "https://cache.tikhub.io/api/v1/cache/public/396d6e99-4744-435e-9a2b-18f0afe632a4?sign=EXPIRED_REPLACE_ME",
  "https://cache.tikhub.io/api/v1/cache/public/42c80629-c87f-43c0-9d00-0b6242257dd2?sign=EXPIRED_REPLACE_ME",
  "https://cache.tikhub.io/api/v1/cache/public/bd113ad7-e5a8-4b7e-a844-857c6baab75e?sign=EXPIRED_REPLACE_ME"
];

function parseSrt(text) {
  return text
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split("\n").filter((l) => l.trim());
      if (lines.length < 2) return null;
      const timeLine = lines.find((l) => l.includes("-->"));
      if (!timeLine) return null;
      const start = timeLine.split("-->")[0].trim();
      const body = lines.slice(lines.indexOf(timeLine) + 1).join(" ").trim();
      return body ? { start, body } : null;
    })
    .filter(Boolean);
}

const allText = [];
for (const [i, url] of CACHES.entries()) {
  try {
    const b = await (await fetch(url)).json();
    const inner = b?.data?.data?.data;
    const entry = Array.isArray(inner) ? (inner[0]?.note_list?.[0] ?? inner[0]) : (inner?.note_list?.[0] ?? inner?.note ?? inner);
    const title = entry?.title ?? "(无标题)";
    const subs = entry?.video_info_v2?.media?.video?.subtitles ?? {};
    // 优先 source 轨（原始语言），退 zh-CN
    const pick = subs.source?.[0]?.url ?? subs["zh-CN"]?.[0]?.url;
    if (!pick) { console.log(`\n### #${i + 1} ${title}\n  (无字幕轨)`); continue; }
    const srtUrl = pick.replace(/^http:\/\//, "https://");
    const r = await fetch(srtUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) { console.log(`\n### #${i + 1} ${title}\n  字幕取回失败 HTTP ${r.status}（签名可能已过期）`); continue; }
    const text = await r.text();
    const cues = parseSrt(text);
    console.log(`\n${"=".repeat(70)}\n### #${i + 1} ${title}\n轨: ${subs.source ? "source" : "zh-CN"} · ${cues.length} 条字幕 · ${text.length} 字符\n${"=".repeat(70)}`);
    for (const c of cues) console.log(`[${c.start}] ${c.body}`);
    allText.push({ title, text: cues.map((c) => c.body).join("\n") });
  } catch (e) {
    console.log(`\n### #${i + 1} 出错: ${e.message}`);
  }
}

// 粗筛：找出像「产品指代」的句子
console.log(`\n\n${"#".repeat(70)}\n# 粗筛：含产品指代词的句子\n${"#".repeat(70)}`);
const patterns = /(这个|这款|这支|这只|这瓶|这罐|用的|推荐|色号|牌子|品牌|同款|\d+号色|唇釉|粉底|气垫|眼影|腮红|修容|遮瑕|散粉|高光|眉笔|睫毛膏|口红|面霜|精华|防晒|妆前)/;
for (const { title, text } of allText) {
  console.log(`\n--- ${title} ---`);
  const hits = text.split("\n").filter((l) => patterns.test(l));
  console.log(hits.slice(0, 25).map((l) => "  " + l).join("\n") || "  (无)");
  console.log(`  ... 命中 ${hits.length} 句 / 共 ${text.split("\n").length} 句`);
}
