import { normalizeForMatch, productKey } from "./product-block.ts";
import { TaobaoApiError, type TaobaoClient } from "./taobao.ts";
import type {
  ProductCard,
  ProductCardFailure,
  ProductCardsCache,
  ProductCardsStatus,
  ProductRef,
  TaobaoItemDetail,
  TaobaoSearchItem
} from "./types.ts";

/**
 * 把技能给出的商品清单补全成卡片：逐件 搜索 → 选品 → 详情。
 * 规则（选品、并发、预算、配额停止）见 docs/specs/09-21-taobao-product-cards.md 第 7 节。
 */

export const DEFAULT_CARD_LIMIT = 8;
export const DEFAULT_BUDGET_MS = 60_000;
export const DEFAULT_CONCURRENCY = 2;

/** 详情失败时的兜底链接：这是该商品的规范详情页，不是搜索结果页。 */
export function itemUrl(numIid: string): string {
  return `https://item.taobao.com/item.htm?id=${encodeURIComponent(numIid)}`;
}

/** 搜索词 = 品牌 + 品名 + 色号，压空白、去首尾标点、限长。 */
export function buildSearchKeyword(ref: ProductRef): string {
  return [ref.brand, ref.name, ref.shade]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/^[\s，,。.、；;：:！!？?]+/, "")
    .replace(/[\s，,。.、；;：:！!?？]+$/, "")
    .slice(0, 60)
    .trim();
}

/**
 * 选品：跳过广告位（isP4p），优先「标题包含品牌名」的第一条，
 * 前 3 条都不含品牌名时取第一条。整页全是广告位时退而取广告——仍是可购买商品，
 * 总比不出卡好。
 */
export function pickSearchItem(items: TaobaoSearchItem[], brand: string): TaobaoSearchItem | undefined {
  const usable = items.filter((item) => item.numIid && item.title);
  if (!usable.length) return undefined;

  const organic = usable.filter((item) => !item.isP4p);
  const pool = organic.length ? organic : usable;

  const target = normalizeForMatch(brand);
  if (target) {
    const matched = pool.slice(0, 3).find((item) => normalizeForMatch(item.title).includes(target));
    if (matched) return matched;
  }
  return pool[0];
}

/** 单张卡片的结局，供观测层开合一条 `taobao.card`。 */
export type ProductCardRun = {
  ref: ProductRef;
  ok: boolean;
  cacheHit: boolean;
  /** 详情层还是搜索回退；失败时没有值。回退率就是从这里统计的。 */
  detailLevel?: "detail" | "search";
  reason?: string;
};

export type BuildProductCardsOptions = {
  client: TaobaoClient;
  limit?: number;
  budgetMs?: number;
  concurrency?: number;
  signal?: AbortSignal;
  cache?: ProductCardsCache;
  now?: () => number;
  /** 每解析出一张就回调一次，调用方据此渐进式推事件。 */
  onCard?: (card: ProductCard) => void | Promise<void>;
  /**
   * 观测挂钩：一张卡片进入 / 离开补全流程各回调一次，**在 `handle(ref)` 之外**。
   * 纯旁路，抛错不影响结果；没开观测时完全没有开销。
   */
  onCardStart?: (ref: ProductRef) => void;
  onCardFinish?: (run: ProductCardRun) => void;
};

export type ProductCardsOutcome = {
  status: ProductCardsStatus;
  cards: ProductCard[];
  failed: ProductCardFailure[];
};

function isFatal(error: unknown): error is TaobaoApiError {
  return error instanceof TaobaoApiError && (error.quotaLimited || error.authFailed);
}

function fatalReason(error: TaobaoApiError): string {
  return error.quotaLimited ? "淘宝查询额度受限" : "淘宝凭据失效";
}

function failureReason(error: unknown): string {
  if (error instanceof TaobaoApiError) {
    return error.code === -1 ? error.message : `淘宝接口失败 code=${error.code}`;
  }
  return "淘宝查询失败";
}

/** 只重试可重试的错（采集失败 301、HTTP 5xx、网络超时）；配额与凭据错直接抛出。 */
async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TaobaoApiError && error.retryable) return await operation();
    throw error;
  }
}

function cardFromDetail(ref: ProductRef, picked: TaobaoSearchItem, detail: TaobaoItemDetail): ProductCard {
  const image = detail.images[0] ?? picked.picUrl;
  const price = detail.price ?? picked.price;
  const shop = detail.shop ?? picked.shop;
  return {
    id: productKey(ref),
    category: ref.category,
    brand: ref.brand,
    name: ref.name,
    ...(ref.shade ? { shade: ref.shade } : {}),
    section: ref.section,
    title: detail.title || picked.title,
    ...(image ? { image } : {}),
    ...(price ? { price } : {}),
    ...(shop ? { shop } : {}),
    purchaseUrl: detail.detailUrl ?? itemUrl(picked.numIid),
    detailLevel: "detail"
  };
}

/** 详情没取到：用搜索结果的图和链接，卡片标记为 search 回退。 */
function cardFromSearch(ref: ProductRef, picked: TaobaoSearchItem): ProductCard {
  return {
    id: productKey(ref),
    category: ref.category,
    brand: ref.brand,
    name: ref.name,
    ...(ref.shade ? { shade: ref.shade } : {}),
    section: ref.section,
    title: picked.title,
    ...(picked.picUrl ? { image: picked.picUrl } : {}),
    ...(picked.price ? { price: picked.price } : {}),
    ...(picked.shop ? { shop: picked.shop } : {}),
    purchaseUrl: itemUrl(picked.numIid),
    detailLevel: "search"
  };
}

export async function buildProductCards(
  items: ProductRef[],
  options: BuildProductCardsOptions
): Promise<ProductCardsOutcome> {
  const now = options.now ?? (() => Date.now());
  const limit = Math.max(1, options.limit ?? DEFAULT_CARD_LIMIT);
  const budgetMs = Math.max(1, options.budgetMs ?? DEFAULT_BUDGET_MS);
  const targets = items.slice(0, limit);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, targets.length || 1));
  const deadline = now() + budgetMs;

  const cards: ProductCard[] = [];
  const failed: ProductCardFailure[] = [];
  let stopReason: string | null = null;
  let cursor = 0;

  const fail = (ref: ProductRef, reason: string) => {
    failed.push({ brand: ref.brand, name: ref.name, reason });
  };

  /** 观测回调是纯旁路：抛错只丢一条观测，不能影响卡片产出。 */
  const report = (run: ProductCardRun) => {
    try {
      options.onCardFinish?.(run);
    } catch {
      // 忽略。
    }
  };

  const reportStart = (ref: ProductRef) => {
    try {
      options.onCardStart?.(ref);
    } catch {
      // 忽略。
    }
  };

  async function handle(ref: ProductRef): Promise<void> {
    const key = productKey(ref);
    const cached = options.cache?.get(key);
    if (cached) {
      cards.push(cached);
      await options.onCard?.(cached);
      report({ ref, ok: true, cacheHit: true, detailLevel: cached.detailLevel });
      return;
    }

    const keyword = buildSearchKeyword(ref);
    if (!keyword) {
      fail(ref, "商品名不完整");
      report({ ref, ok: false, cacheHit: false, reason: "商品名不完整" });
      return;
    }

    // tag 把这次调用归到发起它的那张卡片：并发是 2，观测层靠它才能把
    // taobao.search / taobao.detail 挂到**所属**卡片之下，而不是整批之下。
    const found = await withRetry(() => options.client.searchItems(keyword, { page: 1, signal: options.signal, tag: key }));
    const picked = pickSearchItem(found, ref.brand);
    if (!picked) {
      fail(ref, "淘宝没有搜到可用商品");
      report({ ref, ok: false, cacheHit: false, reason: "淘宝没有搜到可用商品" });
      return;
    }

    let detail: TaobaoItemDetail | null = null;
    try {
      detail = await withRetry(() => options.client.getItemDetail(picked.numIid, { signal: options.signal, tag: key }));
    } catch (error) {
      if (isFatal(error)) throw error;
      // 详情失败/超时：回退搜索结果的图与拼出的详情页，不算整件失败。
    }

    const card = detail ? cardFromDetail(ref, picked, detail) : cardFromSearch(ref, picked);
    cards.push(card);
    options.cache?.set(key, card);
    await options.onCard?.(card);
    report({ ref, ok: true, cacheHit: false, detailLevel: card.detailLevel });
  }

  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      if (options.signal?.aborted) return;
      const ref = targets[cursor++];
      if (stopReason) {
        fail(ref, stopReason);
        continue;
      }
      if (now() >= deadline) {
        fail(ref, "超出本轮淘宝查询预算");
        continue;
      }
      reportStart(ref);
      try {
        await handle(ref);
      } catch (error) {
        // 抛出只可能是配额/凭据这类致命错；软失败已经在 handle 里就地报告过了，
        // 所以这里不会重复报告同一张卡片。
        if (isFatal(error)) {
          stopReason = fatalReason(error);
          fail(ref, stopReason);
        } else {
          fail(ref, failureReason(error));
        }
        report({ ref, ok: false, cacheHit: false, reason: stopReason ?? failureReason(error) });
        continue;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const status: ProductCardsStatus = cards.length === 0 ? "unavailable" : failed.length ? "partial" : "ok";
  return { status, cards, failed };
}
