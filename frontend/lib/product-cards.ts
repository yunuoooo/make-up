import type { ProductCard, ProductCardFailure, ProductCardsEvent, ProductCardsState } from "@/lib/commerce/types";

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

export type ProductCardStripView = {
  /** 已到卡片，按商品清单的品类顺序排好。 */
  items: ProductCard[];
  /** 仍在取、需要骨架卡的品类；只在 status === "pending" 时有值。 */
  pendingLabels: string[];
};

/**
 * 卡片条的渲染视图：排序 + 骨架。
 *
 * 两个线上真实问题都收在这里，组件只负责画：
 *
 * 1. **done 之后绝不能再出骨架**。失败件不会再有 `items` 事件，靠
 *    `expected - items.length` 算出来的骨架会永远停在「正在取…」，看起来像卡片没加载完。
 *    失败件整件不渲染：这是展示取舍，失败原因留在 state.failed 与观测里，不占卡片位。
 * 2. 已到卡片按 `categories` 的顺序排，而不是按到达顺序。并发补全时到达顺序是乱的，
 *    按到达顺序排会让卡片条和答案里的表格对不上。
 */
export function productCardStripView(state: ProductCardsState): ProductCardStripView {
  const order = new Map<string, number>();
  state.categories.forEach((category, index) => {
    if (!order.has(category)) order.set(category, index);
  });
  const items = state.items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const left = order.get(a.item.category) ?? Number.MAX_SAFE_INTEGER;
      const right = order.get(b.item.category) ?? Number.MAX_SAFE_INTEGER;
      return left - right || a.index - b.index;
    })
    .map(({ item }) => item);

  if (state.status !== "pending") {
    return { items, pendingLabels: [] };
  }

  const remaining = state.categories.filter(
    (category) => !state.items.some((item) => item.category === category)
  );
  const pending = Math.max(0, state.expected - state.items.length);
  return {
    items,
    pendingLabels: Array.from({ length: pending }, (_, index) => remaining[index] ?? "商品")
  };
}
