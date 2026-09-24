import type { ProductCardFailure, ProductCardsEvent, ProductCardsState } from "@/lib/commerce/types";

/**
 * 把渐进式的 product_cards 事件合并成 turn 上的卡片状态。
 * 服务端为了不让用户干等，会按 pending → items… → done 分多次推；这里按 id 合并，
 * 同 id 再次出现表示这张卡被升级（例如详情拿回来之后换了更准的图）。
 */

export function emptyProductCards(): ProductCardsState {
  return { status: "pending", expected: 0, categories: [], items: [], failed: [] };
}

function mergeFailures(current: ProductCardFailure[], incoming?: ProductCardFailure[]): ProductCardFailure[] {
  if (!incoming?.length) return current;
  const merged = [...current];
  for (const failure of incoming) {
    const duplicate = merged.some(
      (item) => item.brand === failure.brand && item.name === failure.name && item.reason === failure.reason
    );
    if (!duplicate) merged.push(failure);
  }
  return merged;
}

export function mergeProductCards(
  current: ProductCardsState | undefined,
  event: ProductCardsEvent
): ProductCardsState {
  const base = current ?? emptyProductCards();

  if (event.phase === "pending") {
    return {
      status: "pending",
      expected: event.expected ?? base.expected,
      categories: event.categories ?? base.categories,
      items: base.items,
      failed: base.failed
    };
  }

  if (event.phase === "items") {
    const items = [...base.items];
    for (const card of event.items ?? []) {
      const index = items.findIndex((item) => item.id === card.id);
      if (index >= 0) items[index] = card;
      else items.push(card);
    }
    return { ...base, items, failed: mergeFailures(base.failed, event.failed) };
  }

  return {
    ...base,
    status: event.status ?? (base.items.length ? "ok" : "unavailable"),
    expected: Math.max(base.expected, base.items.length),
    failed: mergeFailures(base.failed, event.failed)
  };
}
