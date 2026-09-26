// 检索字幕里的【指代】与【位置指引】——看产品信息是靠什么被引出的。
// 全程读免费 cache，不打 TikHub。
const CACHES = [
  "https://cache.tikhub.io/api/v1/cache/public/396d6e99-4744-435e-9a2b-18f0afe632a4?sign=EXPIRED_REPLACE_ME",
  "https://cache.tikhub.io/api/v1/cache/public/42c80629-c87f-43c0-9d00-0b6242257dd2?sign=EXPIRED_REPLACE_ME",
  "https://cache.tikhub.io/api/v1/cache/public/bd113ad7-e5a8-4b7e-a844-857c6baab75e?sign=EXPIRED_REPLACE_ME"
];

function parseSrt(text) {
  return text.split(/\n\s*\n/).map((block) => {
    const lines = block.split("\n").filter((l) => l.trim());
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) return null;
    const body = lines.slice(i + 1).join(" ").trim();
    return body ? { start: lines[i].split("-->")[0].trim(), body } : null;
  }).filter(Boolean);
}

// 分类检索
const CATS = {
  "① 位置指引（评论区/链接/橱窗/左上角…）": /(评论区|留言区|置顶|链接|橱窗|购物车|小黄车|简介|下方|左上角|右上角|左下角|右下角|截图|自取|搜一下|店铺)/,
  "② 品牌/同款 字样": /(牌子|品牌|同款|旗舰店|官网)/,
  "③ 指示代词 + 品类（这一款/这支/这个+品类）": /(这一款|这款|这一支|这支|这一个|这个|这只|这瓶|这罐|这一盘|这盘|这颗|这块)[^，。！？]{0,8}(粉底|腮红|眼影|口红|唇釉|唇泥|高光|修容|遮瑕|散粉|眉笔|眼线|睫毛|面霜|精华|隔离|防晒|妆前|粉扑|刷子|提亮|唇线|眼珠|美瞳|假睫毛)/,
  "④ 纯指示代词（这个/这支，后面没跟品类）": /(这个|这支|这只|这款|这瓶|这罐|这一款)[^，。！？]{0,4}(好|很|真|是|来|用|颜色|质地|色号)/
};

const all = [];
for (const [i, url] of CACHES.entries()) {
  const b = await (await fetch(url)).json();
  const inner = b?.data?.data?.data;
  const entry = Array.isArray(inner) ? (inner[0]?.note_list?.[0] ?? inner[0]) : (inner?.note_list?.[0] ?? inner?.note ?? inner);
  const subs = entry?.video_info_v2?.media?.video?.subtitles ?? {};
  const pick = subs.source?.[0]?.url ?? subs["zh-CN"]?.[0]?.url;
  if (!pick) continue;
  const r = await fetch(pick.replace(/^http:\/\//, "https://"), { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) continue;
  const cues = parseSrt(await r.text());
  all.push({ title: String(entry?.title ?? "").slice(0, 30), cues });
}

console.log("=== 位置指引 / 品牌字样 / 指代 的逐条命中 ===\n");
for (const { title, cues } of all) {
  console.log(`\n${"─".repeat(72)}\n### ${title}  (${cues.length} 条)\n${"─".repeat(72)}`);
  for (const [cat, re] of Object.entries(CATS)) {
    const hits = cues.filter((c) => re.test(c.body));
    console.log(`\n${cat}  → ${hits.length} 条`);
    for (const h of hits.slice(0, 12)) console.log(`   [${h.start}] ${h.body}`);
    if (hits.length > 12) console.log(`   … 另有 ${hits.length - 12} 条`);
  }
}

console.log(`\n\n${"#".repeat(72)}\n# 汇总\n${"#".repeat(72)}`);
const total = all.reduce((n, v) => n + v.cues.length, 0);
console.log(`视频 ${all.length} 条 · 字幕共 ${total} 条`);
for (const [cat, re] of Object.entries(CATS)) {
  const n = all.reduce((acc, v) => acc + v.cues.filter((c) => re.test(c.body)).length, 0);
  console.log(`  ${cat}: ${n} 条 (${(n / total * 100).toFixed(1)}%)`);
}
