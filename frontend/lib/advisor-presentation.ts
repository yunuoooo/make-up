import type { Root, RootContent, PhrasingContent, Blockquote } from "mdast";
import { KIT_CATEGORIES } from "../../lib/kit/categories.ts";

/** Presentation only: keep the saved answer and commerce product block unchanged. */
const SUMMARY_PREFIX = /^(?:一句话(?:整体(?:妆效)?|妆效)?|整体妆效|妆效摘要|摘要)\s*[：:]\s*/;
const SOURCE_HEADING = /^(?:本轮(?:小红书)?来源|参考来源|参考资料|来源(?:与证据)?)(?:$|[\s（(:：])/;
const INTERNAL_HEADING = /^(?:妆匣核对(?:结果)?|视频提及但未采用|未采用的(?:视频)?产品|口播产品核对)(?:$|[\s（(:：])/;
const INVITATION_HEADING = /^(?:第二条(?:消息)?|个性化邀请|让推荐更适合你|更适合你的版本)/;
const SECTION_HEADING = /^(?:核心|可选|非必要|必要|按需)(?:.*(?:特点|选品|拆解|解析)|[：:]|$)/;

type TextNode = { type: string; value?: string; children?: TextNode[] };

export function nodeText(node: TextNode): string {
  return node.type === "text" || node.type === "inlineCode" ? node.value ?? ""
    : (node.children ?? []).map(nodeText).join("");
}

export function cleanAdvisorTitle(value: string): string {
  return value
    .replace(/\s*[（(]小红书(?:实时|实施)?研究[）)]\s*$/, "")
    .replace(/\s*[·｜|—–-]\s*(?:第[一二三\d]+轮.*|通用(?:方案|推荐).*)$/, "")
    .trim();
}

function stripPrefix(nodes: PhrasingContent[], pattern: RegExp): void {
  const first = nodes[0];
  if (first?.type === "text") first.value = first.value.replace(pattern, "");
  else if (first && "children" in first) stripPrefix(first.children as PhrasingContent[], pattern);
}

function isLegend(text: string): boolean {
  return /💰/.test(text) && /✅/.test(text)
    && (/^(?:图例|标记说明)\s*[：:]/.test(text) || (text.length < 130 && /需要购买|需新增/.test(text)));
}

/**
 * Work on parsed Markdown blocks, not raw HTML or regexes spanning entire answers.
 * This also upgrades older saved answers without modifying the underlying research.
 */
export function presentAdvisorAnswer(tree: Root): void {
  const visible: RootContent[] = [];
  const sources: RootContent[] = [];
  const isRecommendation = tree.children.some((node) => node.type === "heading" && SECTION_HEADING.test(nodeText(node).trim()));
  let titleSeen = false;
  let hasSummary = false;
  let stepsDepth = 0;
  let imageSeen = false;

  for (let index = 0; index < tree.children.length; index++) {
    const node = tree.children[index];
    const text = nodeText(node).trim();

    if (node.type === "heading") {
      if (stepsDepth && node.depth <= stepsDepth) stepsDepth = 0;
      if (SOURCE_HEADING.test(text) || (isRecommendation && (INTERNAL_HEADING.test(text) || INVITATION_HEADING.test(text)))) {
        const section: RootContent[] = [];
        while (index + 1 < tree.children.length) {
          const next = tree.children[index + 1];
          if (next.type === "heading" && next.depth <= node.depth) break;
          section.push(next);
          index++;
        }
        if (SOURCE_HEADING.test(text)) sources.push(...section);
        // Failed kit reads still affect the interpretation of purchasing advice.
        else if (/妆匣核对/.test(text) && section.some((item) => /(?:未能|未成功|无法|失败|没有).*?(?:读|核对)|(?:读取|核对).*?失败/.test(nodeText(item)))) {
          visible.push({ type: "paragraph", children: [{ type: "text", value: "妆匣暂未核对，以下产品为候选建议。" }] });
        }
        continue;
      }
      if (SECTION_HEADING.test(text)) {
        const optional = /非必要|可选|按需/.test(text);
        node.children = [{ type: "text", value: optional ? "可选特点与选品解析" : "核心特点与选品解析" }];
        node.depth = 2;
        node.data = { hProperties: { "data-advisor-section": optional ? "optional" : "core" } };
      } else if (/^(?:决定妆效的)?(?:执行顺序|上妆步骤|上妆顺序)/.test(text)) {
        stepsDepth = node.depth;
        node.children = [{ type: "text", value: "上妆步骤" }];
        node.data = { hProperties: { "data-advisor-section": "steps" } };
      } else if (!titleSeen && !/^(?:整体妆效图|参考妆效|妆效参考图)/.test(text)) {
        node.children = [{ type: "text", value: cleanAdvisorTitle(text) }];
        node.depth = 1;
        titleSeen = true;
      }
    }

    if (node.type === "paragraph") {
      if (isLegend(text)) continue;
      if (imageSeen && /^来源\s*[：:]/.test(text)) {
        sources.push(node);
        continue;
      }
      if (text === "已结合妆匣") {
        node.data = { hProperties: { "data-advisor-kit": true } };
      } else if (!hasSummary && SUMMARY_PREFIX.test(text)) {
        stripPrefix(node.children, SUMMARY_PREFIX);
        node.data = { hName: "section", hProperties: { "data-advisor-summary": true } };
        hasSummary = true;
      }
      if (node.children.some((child) => child.type === "image")) imageSeen = true;
    }

    if (node.type === "list" && node.ordered && stepsDepth) {
      node.data = { hProperties: { "data-advisor-steps": true } };
      node.children.forEach((item, step) => {
        item.data = { hProperties: { "data-advisor-step": step + (node.start ?? 1) } };
      });
    }

    if (node.type === "table") {
      const firstRow = node.children[0];
      if (firstRow?.children.length === 5 && /区域|部位/.test(nodeText(firstRow.children[0]))) {
        firstRow.children[4].children = [{ type: "text", value: "建议产品" }];
        const labels = firstRow.children.map(nodeText);
        node.data = { hProperties: { "data-advisor-table": true } };
        node.children.slice(1).forEach((row) => row.children.forEach((cell, column) => {
          cell.data = { hProperties: { "data-label": labels[column], ...(column === 4 ? { "data-advisor-products": true } : {}) } };
        }));
      }
    }
    visible.push(node);
  }

  // Shopping cards remain inside the same assistant message, before its sources.
  visible.push({ type: "paragraph", children: [], data: { hName: "aside", hProperties: { "data-advisor-shopping": true } } });
  if (sources.length) {
    visible.push({
      type: "blockquote",
      data: { hName: "details", hProperties: { "data-advisor-sources": true } },
      children: [
        { type: "paragraph", children: [{ type: "text", value: "本轮来源" }], data: { hName: "summary" } },
        { type: "blockquote", children: sources as Blockquote["children"], data: { hName: "div" } }
      ]
    });
  }
  tree.children = visible;
}

export function remarkAdvisorPresentation() {
  return presentAdvisorAnswer;
}

export type ProductSuggestion = {
  status: "owned" | "pending" | "buy";
  name: string;
  shade?: string;
  alternative?: boolean;
  notes: string[];
};

const CATEGORY_LABELS = new Set(KIT_CATEGORIES.flatMap((category) => [category.name, ...category.aliases]));
const MARKER = /^(✅|💰|❔|❓)\s*/u;
const EVIDENCE_LABELS = /(?:🧩\s*特征匹配|↔️?\s*替代(?:选项)?|🎙️?\s*(?:视频)?口播(?:明确)?提及|🎬\s*视频笔记元数据提及|🖼️?\s*图文明示(?:同款)?)/gu;
const NOTE_PREFIX = /^(?:色号待|适合|用于|需要|待确认|偏干|偏油|半哑光|哑光|清透|滋润|妆效|根据|🎙|🧩|↔|🎬|🖼|\d|#)/u;

function cleanProductText(value: string): string {
  return value.replace(EVIDENCE_LABELS, "")
    .replace(/(?:\(|（)不适用(?:色号)?(?:\)|）)/g, "")
    .replace(/^(?:同款|口播首选|口播条件备选)\s*[：:]?\s*/, "")
    .replace(/^[\s，,；;：:]+|[\s，,；;：:]+$/g, "")
    .trim();
}

/** Parse only marked product cells; plain text and ordinary tables stay ordinary. */
export function parseProductSuggestions(value: string): ProductSuggestion[] {
  return value.replace(/<br\s*\/?>/gi, " ").split(/(?=[✅💰❔❓])/u)
    .flatMap((raw): ProductSuggestion[] => {
      const marker = raw.trim().match(MARKER)?.[1];
      if (!marker) return [];
      const status = marker === "✅" ? "owned" : marker === "💰" ? "buy" : "pending";
      let body = raw.trim().replace(MARKER, "").replace(/^(?:已有可复用|已有记录|已有|需要买|需要购买|补购|待确认)\s*[：:]?\s*/, "");
      const alternative = body.match(/^(?:备选|条件备选)(?:[（(]([^）)]+)[）)])?\s*[：:]\s*/);
      if (alternative) body = body.slice(alternative[0].length);
      const parts = body.split(/[|｜]/).map(cleanProductText).filter(Boolean);
      const legacyCategory = parts.length >= 3 && CATEGORY_LABELS.has(parts[0]);
      const category = legacyCategory ? parts.shift() : undefined;
      let name = parts.shift() ?? "";
      // Old answers use category | brand | product | shade. New answers put the
      // entire identity in one field. Keep facts; never infer missing product names.
      if (parts.length && !NOTE_PREFIX.test(parts[0]) && legacyCategory) {
        name += ` ${parts.shift()}`;
      }
      const categoryFamily = KIT_CATEGORIES.find((item) => item.name === category || item.aliases.includes(category ?? ""));
      if (category && categoryFamily && ![categoryFamily.name, ...categoryFamily.aliases].some((label) => name.includes(label))) name += ` ${category}`;
      let shade: string | undefined;
      const notes: string[] = [];
      for (const part of parts) {
        const unknownShade = part.match(/^色号待(?:试|定|确认)\s*[：:]?\s*(.*)$/);
        if (unknownShade) {
          shade = "色号待定";
          if (unknownShade[1]) notes.push(unknownShade[1]);
        } else if (/^(?:色号\s*[：:]?\s*)?#?\d[\w.\-]*(?:\s|$)/.test(part) && !shade) {
          shade = part.replace(/^色号\s*[：:]?\s*/, "");
        } else if (!/^(?:不适用|不适用色号)$/.test(part)) notes.push(part);
      }
      name = name.replace(/\s*色号待(?:试|定|确认)\s*$/, () => { shade = "色号待定"; return ""; });
      if (status === "pending") {
        const conditions = ["肤色", "肤质", "发色", "眼型"].filter((key) => notes.some((note) => note.includes(key)));
        if (conditions.length && notes.some((note) => /待确认|需要先确认|取决于|需.*确认/.test(note))) {
          // Keep concise product properties; replace only the long unresolved-condition explanation.
          const retained = notes.filter((note) => !conditions.some((key) => note.includes(key)));
          notes.splice(0, notes.length, ...retained, `需要根据${conditions.join("、")}进一步分析`);
        }
      }
      if (alternative?.[1] && !notes.length) notes.push(alternative[1]);
      return name ? [{ status, name, ...(shade ? { shade } : {}), ...(alternative ? { alternative: true } : {}), notes }] : [];
    })
    .sort((a, b) => ({ owned: 0, pending: 1, buy: 2 }[a.status] - { owned: 0, pending: 1, buy: 2 }[b.status]));
}

export function parseExecutionStep(value: string, index: number): { title: string; actions: string[] } {
  const named = value.match(/^([^：:]{1,16})[：:]\s*([\s\S]*)$/);
  const body = named ? named[2] : value;
  const actions = body.split(/\s*(?:→|⟶|⇒)\s*/).map((part) => part.replace(/[。；;]\s*$/, "").trim()).filter(Boolean);
  return { title: named?.[1] ?? `步骤 ${index}`, actions };
}
