import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cleanAdvisorTitle, parseExecutionStep, parseProductSuggestions, remarkAdvisorPresentation } from "../../frontend/lib/advisor-presentation.ts";

const render = (text: string) => renderToStaticMarkup(createElement(ReactMarkdown, {
  children: text, skipHtml: true, remarkPlugins: [remarkGfm, remarkAdvisorPresentation]
}));

test("旧回复：精简开篇与两表，研究过程退出正文，购买入口在折叠来源之前", () => {
  const answer = readFileSync("test/L1/fixtures/advisor-answer.md", "utf8");
  const html = render(answer);
  assert.match(html, /<h1>亚裔妆<\/h1>/);
  assert.match(html, /<section data-advisor-summary="true"><strong>薄而干净/);
  assert.match(html, /核心特点与选品解析/);
  assert.match(html, /可选特点与选品解析/);
  assert.equal((html.match(/<th>建议产品<\/th>/g) ?? []).length, 2);
  for (const removed of ["第一轮通用方案", "妆匣核对结果", "读到 10 件", "图例：", "视频提及但未采用", "口播命中 6", "第二条个性化邀请", "你可以告诉我肤质"]) {
    assert.ok(!html.includes(removed), removed);
  }
  const sourceStart = html.indexOf("<details");
  assert.ok(sourceStart > html.indexOf("data-advisor-shopping"));
  assert.ok(html.indexOf("来源：图文笔记") > sourceStart);
  assert.match(html, /<details data-advisor-sources="true">\s*<summary>本轮来源<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:=|\s|>)/);
  assert.match(html, /data-advisor-step="6"/);
  assert.match(html, /Benefit 贝玲妃/);
});

test("标题只删研究后缀，保留用户选择的风格分支", () => {
  assert.equal(cleanAdvisorTitle("亚裔妆 · 第一轮通用方案（小红书实时研究）"), "亚裔妆");
  assert.equal(cleanAdvisorTitle("亚裔妆 · 日常暖棕版"), "亚裔妆 · 日常暖棕版");
});

test("商品身份、选色条件与备选差异保留，已有稳定排在需要买之前", () => {
  const items = parseProductSuggestions("💰 补购：底妆 | MAC 魅可 | 定制无瑕粉底液 | 色号待试：按颈部试色 | 🧩 特征匹配<br>✅ 已有可复用：底妆 | Benefit 贝玲妃 | 反孔精英妆前乳（不适用色号） | 用于 T 区<br>💰 备选：底妆 | 兰蔻 | 菁纯粉底液 | 色号待试 | ↔️ 替代，适合偏干皮");
  assert.deepEqual(items.map((item) => item.status), ["owned", "buy", "buy"]);
  assert.equal(items[0].name, "Benefit 贝玲妃 反孔精英妆前乳");
  assert.equal(items[1].name, "MAC 魅可 定制无瑕粉底液");
  assert.equal(items[1].shade, "色号待定");
  assert.deepEqual(items[1].notes, ["按颈部试色"]);
  assert.deepEqual(items[2].notes, ["适合偏干皮"]);
  assert.equal(items[2].alternative, true);
  assert.doesNotMatch(JSON.stringify(items), /补购|已有可复用|特征匹配|替代|不适用色号/);
});

test("待确认的已有品不冒充已满足，条件说明清晰且不丢产品名", () => {
  const [item] = parseProductSuggestions("❔ 已有记录：眼影 | MAC | Omega | 待确认：样本一致，提示黄黑皮大量用发灰，需要先确认你的肤色");
  assert.equal(item.status, "pending");
  assert.equal(item.name, "MAC Omega 眼影");
  assert.deepEqual(item.notes, ["需要根据肤色进一步分析"]);
});

test("新格式无需旧分隔串，已知色号与实际使用限制不丢失", () => {
  const items = parseProductSuggestions("✅ KATE 造型眉粉饼 EX-5｜用于眉形打底 💰 MAC 魅可 定制无瑕粉底液 色号待定｜需要根据肤色进一步选色");
  assert.equal(items[0].name, "KATE 造型眉粉饼 EX-5");
  assert.equal(items[1].name, "MAC 魅可 定制无瑕粉底液");
  assert.equal(items[1].shade, "色号待定");
  assert.deepEqual(parseProductSuggestions("✅ 眼线笔｜敏感时停用")[0].notes, ["敏感时停用"]);
  assert.deepEqual(parseProductSuggestions("💰 NARS 遮瑕液｜小范围点涂｜眼下薄涂")[0].notes, ["小范围点涂", "眼下薄涂"]);
});

test("步骤拆分不丢动作，没有标题时不编造部位", () => {
  assert.deepEqual(parseExecutionStep("底妆：保湿 → 薄涂粉底 → 局部定妆。", 1), { title: "底妆", actions: ["保湿", "薄涂粉底", "局部定妆"] });
  assert.deepEqual(parseExecutionStep("先夹睫毛 → 再刷睫毛膏", 2), { title: "步骤 2", actions: ["先夹睫毛", "再刷睫毛膏"] });
});

test("关键失败说明仍可见，普通段落、表格和代码不按研究报告隐藏", () => {
  const html = render("## 妆匣核对结果\n\n妆匣读取失败，本次没有核对成功。\n\n## 核心特点与选品解析\n\n没有实时站内检索。\n\n| 项目 | 说明 |\n| --- | --- |\n| 测试 | 数据 |\n\n```text\n## 视频提及但未采用\n```\n\n<script>alert('x')</script>");
  assert.match(html, /妆匣暂未核对，以下产品为候选建议/);
  assert.match(html, /没有实时站内检索/);
  assert.match(html, /<th>说明<\/th>/);
  assert.match(html, /<code[^>]*>## 视频提及但未采用/);
  assert.doesNotMatch(html, /<script>/);
  const followup = render("## 视频提及但未采用\n\n因为只有品牌信息，无法确认具体产品。");
  assert.match(followup, /因为只有品牌信息，无法确认具体产品/);
});
