import { readJson, writeJson } from "./json-store.ts";
import type { ProductCard, ProductCardsCache } from "../commerce/types.ts";

/**
 * 商品卡片的落盘缓存。上游按次计费，而同一个妆容会被反复问，
 * 所以按「品牌|品名|色号」缓存已解析好的卡片——缓存的是卡片而不是上游原始响应，
 * 页内状态和详情 HTML 不进本地文件。
 */

const fileName = "taobao-cards.json";
const DEFAULT_TTL_SECONDS = 86400;

type CacheEntry = { cachedAt: number; card: ProductCard };
type CacheFile = { version: 1; entries: Record<string, CacheEntry> };

export type FileProductCardsCache = ProductCardsCache & { save(): Promise<void> };

export type LoadCacheOptions = {
  /** 缓存 TTL，秒；默认取 TAOBAO_CACHE_TTL_SECONDS 或 24 小时。 */
  ttlSeconds?: number;
  now?: () => number;
};

function resolveTtlSeconds(options: LoadCacheOptions = {}): number {
  if (typeof options.ttlSeconds === "number") return options.ttlSeconds;
  const fromEnv = Number(process.env.TAOBAO_CACHE_TTL_SECONDS ?? DEFAULT_TTL_SECONDS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_TTL_SECONDS;
}

export async function loadProductCardsCache(options: LoadCacheOptions = {}): Promise<FileProductCardsCache> {
  const now = options.now ?? (() => Date.now());
  const ttlMs = resolveTtlSeconds(options) * 1000;
  const file = await readJson<CacheFile>(fileName, { version: 1, entries: {} });
  const entries = new Map<string, CacheEntry>();

  for (const [key, entry] of Object.entries(file.entries ?? {})) {
    if (!entry || typeof entry.cachedAt !== "number" || !entry.card) continue;
    if (now() - entry.cachedAt >= ttlMs) continue;
    entries.set(key, entry);
  }

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.cachedAt >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return entry.card;
    },

    set(key, card) {
      entries.set(key, { cachedAt: now(), card });
    },

    async save() {
      // 读一次再合并：同一时间可能有另一轮请求写进过新条目，不能整份覆盖掉。
      const existing = await readJson<CacheFile>(fileName, { version: 1, entries: {} });
      const merged: Record<string, CacheEntry> = { ...(existing.entries ?? {}) };
      for (const [key, entry] of entries) {
        const previous = merged[key];
        if (!previous || previous.cachedAt <= entry.cachedAt) merged[key] = entry;
      }
      await writeJson<CacheFile>(fileName, { version: 1, entries: merged });
    }
  };
}
