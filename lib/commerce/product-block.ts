import type { ProductRef, ProductSection } from "./types.ts";

/**
 * 技能在答案末尾附的机器可读商品清单：服务端靠它拿到「确定的化妆品」，
 * 前端靠它把这段不展示给用户的 JSON 藏起来。契约见
 * docs/specs/09-21-taobao-product-cards.md 第 6.1 节。
 *
 * 两侧共用同一份实现：前端在流式阶段也要隐藏这段块，否则用户会看到半截 JSON。
 */

export const PRODUCT_BLOCK_INFO = "looktrace-products";
export const PRODUCTS_VERSION = "looktrace.products.v1";
export const DEFAULT_PRODUCT_LIMIT = 8;

const MAX_TEXT_LENGTH = 60;
const MAX_SHADE_LENGTH = 40;
/** 开栅栏允许行首空白，便于模型缩进输出。 */
const OPEN_FENCE = /^\s*```\s*looktrace-products\s*$/i;
const CLOSE_FENCE = /^\s*```\s*$/;

/**
 * 扫描一遍文本：切出所有块，同时给出「去掉块以后」的正文。
 * 未闭合的块按块对待——流式输出到一半时，正文里不能留下半截 JSON。
 */
function scan(text: string): { blocks: string[]; kept: string[] } {
  const blocks: string[] = [];
  const kept: string[] = [];
  let buffer: string[] | null = null;

  for (const line of text.split("\n")) {
    const clean = line.replace(/\r$/, "");
    if (buffer) {
      if (CLOSE_FENCE.test(clean)) {
        blocks.push(buffer.join("\n"));
        buffer = null;
      } else {
        buffer.push(clean);
      }
      continue;
    }
    if (OPEN_FENCE.test(clean)) {
      buffer = [];
      continue;
    }
    kept.push(clean);
  }

  if (buffer) blocks.push(buffer.join("\n"));
  return { blocks, kept };
}

/** 块被摘掉后可能留下多余空行，收一下但不动正文里的其他排版。 */
function tidy(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trimEnd();
}

/** 剥离机器可读块，返回可展示的正文。流式与最终文本共用。 */
export function stripProductBlock(text: string): string {
  return tidy(scan(text).kept.join("\n"));
}

/**
 * 提取商品清单并剥离块。
 * 块存在但校验不过时：清单为空，**块照样剥离**——否则原始 JSON 会显示给用户。
 */
export function extractProductBlock(
  text: string,
  options: { limit?: number } = {}
): { items: ProductRef[]; text: string } {
  const limit = Math.max(1, options.limit ?? DEFAULT_PRODUCT_LIMIT);
  const { blocks, kept } = scan(text);
  const cleaned = tidy(kept.join("\n"));

  // 技能要求只出一个块，但模型可能把「必要／非必要」拆成两个：
  // 合并所有能解析的块再去重，比只认第一个更接近它本来想表达的意思。
  const merged: ProductRef[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    for (const ref of parseProductList(block, limit) ?? []) {
      const key = productKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(ref);
      if (merged.length >= limit) return { items: merged, text: cleaned };
    }
  }
  return { items: merged, text: cleaned };
}

/** 缓存键、去重键和卡片 id 共用：归一化后的 品牌|品名|色号。 */
export function productKey(ref: Pick<ProductRef, "brand" | "name" | "shade">): string {
  return [ref.brand, ref.name, ref.shade ?? ""]
    .map((part) => part.trim().toLowerCase().replace(/\s+/g, " "))
    .join("|");
}

/** 用于「标题包含品牌名」这类包含判断。 */
export function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[（）()【】\[\]、，,。.·．\-—_/\\]/g, "");
}

function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function normalizeRef(entry: unknown): ProductRef | null {
  if (!entry || typeof entry !== "object") return null;
  const raw = entry as Record<string, unknown>;
  const category = cleanText(raw.category, MAX_TEXT_LENGTH);
  const brand = cleanText(raw.brand, MAX_TEXT_LENGTH);
  const name = cleanText(raw.name, MAX_TEXT_LENGTH);
  if (!category || !brand || !name) return null;

  const shade = cleanText(raw.shade, MAX_SHADE_LENGTH);
  const section: ProductSection = raw.section === "optional" ? "optional" : "necessary";
  return shade ? { category, brand, name, shade, section } : { category, brand, name, section };
}

function parseProductList(raw: string, limit: number): ProductRef[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const root = parsed as { version?: unknown; items?: unknown };
  if (root.version !== PRODUCTS_VERSION) return null;
  if (!Array.isArray(root.items)) return null;

  const items: ProductRef[] = [];
  const seen = new Set<string>();
  for (const entry of root.items) {
    const ref = normalizeRef(entry);
    if (!ref) continue;
    const key = productKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(ref);
    if (items.length >= limit) break;
  }
  return items.length ? items : null;
}
