import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  formatTranscript,
  isFetchableTranscriptUrl,
  parseSrt,
  transcriptHost
} from "../../lib/xhs/transcript.ts";

/**
 * `.srt` → 带 `[MM:SS]` 的纯文本。格式与解析口径见 SSOT 第 2.3 节。
 *
 * 这里的样本是**真实字幕**（`xhs-subtitle-sample.srt`，2026-09-26 取），
 * 合成样本只用来覆盖真实样本没有的分支。
 */

async function sample() {
  return readFile("test/L1/fixtures/xhs-subtitle-sample.srt", "utf8");
}

test("真实 .srt：空行分块、`-->` 前后切分、毫秒用逗号", async () => {
  const parsed = parseSrt(await sample());
  assert.ok("cues" in parsed, "真实样本必须解析成功");
  assert.ok(parsed.cues.length > 10);
  assert.equal(parsed.cues[0].start, "00:00", "`00:00:00,000` → `[00:00]`");
  assert.match(parsed.cues[0].text, /猫素亚裔妆/);
  // 时间戳统一成累计分钟，只有一种格式。
  for (const cue of parsed.cues) assert.match(cue.start, /^\d{2}:\d{2}$/);
});

test("解析：序号线不进口播正文，多行正文用空格接起来", () => {
  const parsed = parseSrt("1\n00:01:05,500 --> 00:01:08,000\n先上妆前\n再上粉底\n\n2\n00:01:08,000 --> 00:01:09,000\n定妆\n");
  assert.ok("cues" in parsed);
  assert.deepEqual(parsed.cues, [
    { start: "01:05", text: "先上妆前 再上粉底" },
    { start: "01:08", text: "定妆" }
  ]);
});

test("解析：超过一小时是累计分钟，不是 [HH:MM:SS]", () => {
  const parsed = parseSrt("1\n01:15:30,000 --> 01:15:31,000\n一小时十五分\n");
  assert.ok("cues" in parsed);
  assert.equal(parsed.cues[0].start, "75:30", "格式只有一种，模型不用猜是哪种");
});

test("解析：BOM 与没有时间轴的块都跳过，不算失败", () => {
  const parsed = parseSrt("﻿1\n00:00:01,000 --> 00:00:02,000\n正文\n\n本字幕由 XX 生成\n");
  assert.ok("cues" in parsed);
  assert.equal(parsed.cues.length, 1);
});

test("解析：认不出结构就是失败，不返回「能读几条算几条」", () => {
  // 有时间轴但时间格式变了 = 格式漂移，宁可整篇失败也不要静默丢内容。
  const drift = parseSrt("1\n00:00:01.000 --> 00:00:02.000\n正文\n");
  assert.ok("cues" in drift, "点号是逗号的无害变体，要收");

  const bad = parseSrt("1\n00:00 --> 00:00:02\n正文\n");
  assert.ok("failed" in bad, "认不出来就不猜");
  assert.match(bad.failed, /时间轴/);

  assert.ok("failed" in parseSrt("就是一段普通文字，没有时间轴"));
  assert.ok("failed" in parseSrt("1\n00:00:01,000 --> 00:00:02,000\n\n2\n00:00:03,000 --> 00:00:04,000\n\n"),
    "有时间轴但一条正文都没有，同样是失败");
});

test("格式化：每条带 [MM:SS] 前缀，超上限切在整行边界", () => {
  const cues = [
    { start: "00:00", text: "大家好" },
    { start: "00:04", text: "第一步先上妆前" },
    { start: "00:09", text: "第二步上粉底" }
  ];
  const full = formatTranscript(cues, 1000);
  assert.equal(full.truncated, false);
  assert.equal(full.text, "[00:00] 大家好\n[00:04] 第一步先上妆前\n[00:09] 第二步上粉底");

  const cut = formatTranscript(cues, 20);
  assert.equal(cut.truncated, true);
  assert.ok(cut.text.length <= 20);
  assert.ok(!cut.text.includes("\n\n"));
  assert.ok(full.text.startsWith(cut.text), "截的是尾巴，不是中间");
});

test("白名单：只放行 https + xhscdn.com / rednotecdn.com（含子域）", () => {
  // 字幕实际在 rednotecdn 上——只认 xhscdn.com 会让整条链路永远拿不到字幕。
  assert.ok(isFetchableTranscriptUrl("https://sns-subtitle-s8.rednotecdn.com/subtitle/x.srt?sign=abc"));
  assert.ok(isFetchableTranscriptUrl("https://sns-v28.rednotecdn.com/stream/x"));
  assert.ok(isFetchableTranscriptUrl("https://sns-img-hw.xhscdn.com/a.jpg"));
  assert.ok(isFetchableTranscriptUrl("https://xhscdn.com/a.jpg"), "裸域名也算");
  assert.equal(isFetchableTranscriptUrl("http://sns-subtitle-s8.rednotecdn.com/x.srt"), false, "只走 https");
  assert.equal(isFetchableTranscriptUrl("https://evil.example.com/x.srt"), false);
  // 后缀伪装：不能只看 endsWith 字符串。
  assert.equal(isFetchableTranscriptUrl("https://notxhscdn.com/x.srt"), false);
  assert.equal(isFetchableTranscriptUrl("https://xhscdn.com.evil.com/x.srt"), false);
  assert.equal(isFetchableTranscriptUrl(undefined), false);
  assert.equal(isFetchableTranscriptUrl("不是一个地址"), false);

  assert.equal(transcriptHost("https://evil.example.com/a.srt?sign=SECRET"), "evil.example.com",
    "排障只报 host，签名参数不进日志");
});
