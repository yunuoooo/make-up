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
/**
 * 2 → 4（2026-11-02）。上游现在是 10–40s 一件，8 件商品两两串行时尾部必然撞 60s 预算：
 * 实测两轮 8 件分别只补出 5 件和 3 件，其中 2 件是「超出本轮淘宝查询预算」。
 * 并发 4 只影响同时在跑的请求数，总请求数、总费用不变；302 的降并发逻辑照旧生效。
 */
export const DEFAULT_CONCURRENCY = 4;
/**
 * 命中 302（超出速率限制）后的退避时长。上游的限流窗口以分钟/小时计，退避只是让一次
 * 突发的并发撞上限制后能站起来，不是等窗口过去——所以它是「重试一次」而不是「等到成功」。
 * 失败调用不计费（SSOT 第 8.1 节），这一次等待只花时间，不花钱。
 */
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5_000;

/** 详情失败时的兜底链接：这是该商品的规范详情页，不是搜索结果页。 */
export function itemUrl(numIid: string): string {
  return `https://item.taobao.com/item.htm?id=${encodeURIComponent(numIid)}`;
}

/** 搜索词 = 品牌 + 品名 + 色号，压空白、去首尾标点、限长。 */
export function buildSearchKeyword(ref: ProductRef): string {
  return composeKeyword([ref.brand, ref.name, ref.shade]);
}

function composeKeyword(parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/^[\s，,。.、；;：:！!？?]+/, "")
    .replace(/[\s，,。.、；;：:！!?？]+$/, "")
    .slice(0, 60)
    .trim();
}

/**
 * 品牌里的拉丁部分：`MAC 魅可` → `MAC`，`Kiss Me 奇士美` → `Kiss Me`。
 * 淘宝搜索结果标题通常只带其中一个写法；带上重复的中文别名反而更容易让采集失败
 * （2026-11-02 实测：`MAC 魅可 唇线笔（Lip Pencil）` 两次 301，`MAC 唇线笔` 正常返回 47 条）。
 * 纯中文品牌没有拉丁部分，返回 undefined，由调用方保留原品牌。
 */
function latinBrand(brand: string): string | undefined {
  const tokens = brand.trim().split(/[\s/]+/).filter(Boolean);
  const latin: string[] = [];
  for (const token of tokens) {
    if (!/^[A-Za-z0-9][A-Za-z0-9.&'’+_-]*$/.test(token)) break;
    latin.push(token);
  }
  return latin.length ? latin.join(" ") : undefined;
}

/**
 * 搜索用的简化品名：去掉括号里的英文译名/补充说明，以及中文名尾部的一串英文。
 * `亮采柔润遮瑕膏（Radiant Creamy Concealer）` → `亮采柔润遮瑕膏`；
 * `花漾美姬 柔雾染眉膏 Heavy Rotation Coloring Eyebrow` → `花漾美姬 柔雾染眉膏`。
 * 纯英文品名不会被清空——只有还剩下中文时才剪尾部的英文。
 */
function simplifyProductName(name: string): string {
  let text = name.replace(/[（(【\[][^）)】\]]*[）)】\]]/g, " ");
  if (/[㐀-鿿]/.test(text)) {
    text = text.replace(/\s+[A-Za-z0-9][A-Za-z0-9 .&'’+_-]*$/, " ");
  }
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 301（采集失败）后的兜底搜索词。
 *
 * 上游的 301 是关键词相关的：同一个商品，带上重复的中文品牌别名或英文括号就容易
 * 采集失败，换成「拉丁品牌 + 简化品名」通常能拿到结果（实测见消费方 spec 第 13 节）。
 * 返回按优先级排好的候选：先简化品名，再退到品牌 + 品类；调用方逐个尝试。
 * 与原搜索词相同或重复的候选会被去掉，所以纯中文、简单品名的商品通常没有兜底词。
 */
export function buildFallbackSearchKeywords(ref: ProductRef): string[] {
  const brand = latinBrand(ref.brand) ?? ref.brand;
  const name = simplifyProductName(ref.name);
  const candidates = [
    composeKeyword([brand, name]),
    composeKeyword([brand, ref.category])
  ];
  const seen = new Set<string>([buildSearchKeyword(ref).toLowerCase()]);
  const keywords: string[] = [];
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (!candidate || seen.has(key)) continue;
    seen.add(key);
    keywords.push(candidate);
  }
  return keywords;
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
  /** 命中 302 后的退避时长，默认 `DEFAULT_RATE_LIMIT_BACKOFF_MS`；测试里调小以免拖慢。 */
  rateLimitBackoffMs?: number;
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

/** 可被 abort 打断的睡眠：调用方断开时不该在这里空等。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** 重试用的上下文：预算与取消都由调用方给，重试自己不许造时间。 */
type RetryContext = {
  signal?: AbortSignal;
  backoffMs: number;
  deadline: number;
  now: () => number;
  /** 命中限流时回调一次——整批据此降并发。 */
  onRateLimit?: () => void;
};

/**
 * 只重试可重试的错：采集失败（301）、HTTP 5xx、网络超时各立刻重试一次；
 * 限流（302）退避后重试一次。配额（303/601/602）与凭据错直接抛出，由上层整批停下。
 *
 * 302 是这里唯一会「等一下」的错：它是瞬时的，而失败的调用不计费，所以退避重试不吃成本。
 * 但预算不够就不等了——宁可少一张卡，也不让答案等着淘宝。
 */
async function withRetry<T>(operation: () => Promise<T>, retry: RetryContext): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof TaobaoApiError)) throw error;
    if (error.retryable) return await operation();
    if (error.rateLimited) {
      retry.onRateLimit?.();
      if (retry.now() + retry.backoffMs < retry.deadline) {
        await sleep(retry.backoffMs, retry.signal);
        return await operation();
      }
    }
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
    // V6 没有 `detail_url`，这条兜底现在是常态而非例外：链接按**详情自己的** itemId 拼
    // （上游若把请求重定向到别的商品，详情里的 ID 才是我们真正拿到数据的那一件）。
    purchaseUrl: detail.detailUrl ?? itemUrl(detail.numIid),
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
  const rateLimitBackoffMs = Math.max(0, options.rateLimitBackoffMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS);

  const cards: ProductCard[] = [];
  const failed: ProductCardFailure[] = [];
  let stopReason: string | null = null;
  let cursor = 0;
  /**
   * 命中过 302：本轮剩余请求降到并发 1（SSOT 第 3 节给 302 的处置是「降并发或放弃」）。
   * 只降不升——限流窗口以分钟/小时计，本批剩下的这点时间不够它恢复，再撞一次只是多花时间。
   */
  let throttled = false;

  const retry: RetryContext = {
    signal: options.signal,
    backoffMs: rateLimitBackoffMs,
    deadline,
    now,
    onRateLimit: () => {
      throttled = true;
    }
  };

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

  /**
   * 搜索；301（采集失败）时换简化关键词再试。
   *
   * 301 是关键词相关的：原词重试一次仍失败时，直接放弃会让这一件永远不出卡。
   * 兜底词只换关键词、不换商品，失败的调用也不计费；预算不够时不再尝试，
   * 避免为了救一件把后面的卡片饿死。兜底也失败就抛**原始** 301，失败原因不会被
   * 兜底词的错误盖掉。
   */
  async function searchWithFallback(ref: ProductRef, key: string, keyword: string): Promise<TaobaoSearchItem[]> {
    try {
      return await withRetry(
        () => options.client.searchItems(keyword, { page: 1, signal: options.signal, tag: key }),
        retry
      );
    } catch (error) {
      if (!(error instanceof TaobaoApiError) || error.code !== 301) throw error;
      for (const fallback of buildFallbackSearchKeywords(ref)) {
        if (retry.now() >= retry.deadline) break;
        try {
          return await withRetry(
            () => options.client.searchItems(fallback, { page: 1, signal: options.signal, tag: key }),
            retry
          );
        } catch (fallbackError) {
          // 配额/凭据这类致命错必须整批停下，不能被「换关键词」吞掉。
          if (isFatal(fallbackError)) throw fallbackError;
          // 只有 301 才值得换下一个候选；其它失败（超时、5xx、302）不再换词，
          // 按原始 301 记这一件的失败原因。
          if (!(fallbackError instanceof TaobaoApiError) || fallbackError.code !== 301) break;
        }
      }
      throw error;
    }
  }

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

    // tag 把这次调用归到发起它的那张卡片：并发补全时，观测层靠它才能把
    // taobao.search / taobao.detail 挂到**所属**卡片之下，而不是整批之下。
    const found = await searchWithFallback(ref, key, keyword);
    const picked = pickSearchItem(found, ref.brand);
    if (!picked) {
      fail(ref, "淘宝没有搜到可用商品");
      report({ ref, ok: false, cacheHit: false, reason: "淘宝没有搜到可用商品" });
      return;
    }

    let detail: TaobaoItemDetail | null = null;
    try {
      detail = await withRetry(
        () => options.client.getItemDetail(picked.numIid, { signal: options.signal, tag: key }),
        retry
      );
    } catch (error) {
      if (isFatal(error)) throw error;
      // 详情失败/超时/限流：回退搜索结果的图与拼出的详情页，不算整件失败——
      // 302 走的就是这条路：搜索已经拿到商品了，卡片照出，只是标成 search 回退。
    }

    const card = detail ? cardFromDetail(ref, picked, detail) : cardFromSearch(ref, picked);
    cards.push(card);
    options.cache?.set(key, card);
    await options.onCard?.(card);
    report({ ref, ok: true, cacheHit: false, detailLevel: card.detailLevel });
  }

  async function worker(index: number): Promise<void> {
    while (cursor < targets.length) {
      if (options.signal?.aborted) return;
      // 降并发：留一个 worker 把剩下的商品走完，多出来的在**取下一件之前**退场，
      // 所以正在跑的那件不受影响。
      if (index > 0 && throttled) return;
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
        //
        // 两种情况都报**自己的**原因：并发是 2，另一个 worker 可能已经写了 stopReason，
        // 拿它当这张卡片的原因会把真实的错误码盖掉（比如把 302 记成「额度受限」）。
        const reason = isFatal(error) ? (stopReason = fatalReason(error)) : failureReason(error);
        fail(ref, reason);
        report({ ref, ok: false, cacheHit: false, reason });
        continue;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index)));

  const status: ProductCardsStatus = cards.length === 0 ? "unavailable" : failed.length ? "partial" : "ok";
  return { status, cards, failed };
}
