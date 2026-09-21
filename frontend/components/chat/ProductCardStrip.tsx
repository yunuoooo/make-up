"use client";

import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, ShoppingBag } from "lucide-react";
import { Skeleton } from "@/frontend/components/ui/skeleton";
import { cn } from "@/frontend/lib/utils";
import type { ProductCard, ProductCardsState } from "@/lib/commerce/types";

/**
 * 答案下方的商品卡片条：横向滑动，一卡一件「需要购买的首选」。
 * 卡片数据来自服务端补全（图与链接来自淘宝），这里只负责展示，不做任何拼链接的动作。
 */
export function ProductCardStrip({ state }: { state?: ProductCardsState }) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  if (!state || (state.expected === 0 && state.items.length === 0)) return null;

  const pending = Math.max(0, state.expected - state.items.length);

  // 全部失败时不留一条空卡片条，只说明情况——答案里的表格仍然可用。
  if (state.status === "unavailable" && state.items.length === 0) {
    return (
      <p className="mt-5 rounded-[16px] border border-black/[.07] bg-white px-4 py-3 text-[13px] leading-6 text-[#7d756f]">
        淘宝商品信息暂不可用，可点表格里的商品名自行搜索。
      </p>
    );
  }

  const scrollByCard = (direction: 1 | -1) => {
    const node = scrollerRef.current;
    if (!node) return;
    const card = node.querySelector<HTMLElement>("[data-product-card]");
    const step = (card?.offsetWidth ?? 240) + 16;
    node.scrollBy({ left: step * direction, behavior: "smooth" });
  };

  return (
    <section className="mt-6" aria-label="可在淘宝购买的首选商品">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-[#312d2a]">
          需要购买的首选 · {state.items.length || state.expected} 件
        </h3>
        <span className="text-[11px] text-[#a29c96]">图片与价格来自淘宝，以商品页为准</span>
      </div>

      <div className="relative mt-3">
        <div
          ref={scrollerRef}
          className="scrollbar-thin flex snap-x snap-mandatory gap-4 overflow-x-auto pb-3"
        >
          {state.items.map((card) => (
            <ProductCardTile key={card.id} card={card} />
          ))}
          {Array.from({ length: pending }).map((_, index) => (
            <SkeletonTile key={`pending_${index}`} label={state.categories[state.items.length + index] ?? "商品"} />
          ))}
        </div>

        {state.items.length + pending > 1 ? (
          <>
            <ScrollButton side="left" onClick={() => scrollByCard(-1)} />
            <ScrollButton side="right" onClick={() => scrollByCard(1)} />
          </>
        ) : null}
      </div>

      {state.status === "partial" ? (
        <p className="mt-1 text-[11px] text-[#a29c96]">
          其余 {Math.max(state.failed.length, pending)} 件暂时没取到淘宝信息
          {state.failed.some((item) => item.reason.includes("额度")) ? "（本轮淘宝查询额度受限）" : ""}
        </p>
      ) : null}
    </section>
  );
}

function ScrollButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? "上一件商品" : "下一件商品"}
      className={cn(
        "absolute top-[38%] hidden size-9 -translate-y-1/2 place-items-center rounded-full border border-black/[.08] bg-white/95 text-[#4e4843] shadow-[0_6px_18px_rgba(40,35,32,.12)] backdrop-blur transition hover:text-[#a23d5d] md:grid",
        side === "left" ? "-left-3" : "-right-3"
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

function ProductCardTile({ card }: { card: ProductCard }) {
  const [imageBroken, setImageBroken] = useState(false);
  const showImage = Boolean(card.image) && !imageBroken;

  return (
    <article
      data-product-card
      className="w-[214px] shrink-0 snap-start overflow-hidden rounded-[18px] border border-black/[.07] bg-white shadow-[0_8px_24px_rgba(40,35,32,.05)] sm:w-[238px]"
    >
      <div className="relative aspect-square bg-[#f2eeeb]">
        {showImage ? (
          <img
            src={card.image}
            alt={card.title || `${card.brand}${card.name}`}
            loading="lazy"
            // 淘宝图床有防盗链，去掉 referrer 才能直接显示。
            referrerPolicy="no-referrer"
            onError={() => setImageBroken(true)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <span className="absolute inset-0 grid place-items-center text-[#c5bdb7]">
            <ShoppingBag className="size-7" />
          </span>
        )}

        <span className="absolute left-2.5 top-2.5 rounded-full bg-white/92 px-2 py-0.5 text-[11px] font-medium text-[#4e4843] backdrop-blur">
          {card.category}
        </span>
        {card.section === "optional" ? (
          <span className="absolute right-2.5 top-2.5 rounded-full bg-[#eeeae7]/95 px-2 py-0.5 text-[11px] text-[#706963]">
            按需
          </span>
        ) : null}
      </div>

      <div className="flex min-h-[168px] flex-col p-3.5">
        <p className="line-clamp-2 text-[13px] font-medium leading-5 text-[#2c2825]">
          {card.title || `${card.brand} ${card.name}`}
        </p>
        <p className="mt-1.5 text-[12px] leading-5 text-[#857e78]">
          {card.brand}
          {card.shade ? ` · ${card.shade}` : ""}
        </p>
        <p className="mt-2 text-[15px] font-semibold text-[#a23d5d]">
          {card.price ? `¥${card.price.replace(/^¥/, "")}` : "价格见淘宝"}
        </p>

        <a
          href={card.purchaseUrl}
          target="_blank"
          rel="noreferrer noopener nofollow"
          className="mt-auto inline-flex items-center justify-center gap-1.5 rounded-[12px] bg-[#242421] px-3 py-2 text-[13px] font-medium text-white transition hover:bg-[#3a3935]"
        >
          去淘宝
          <ExternalLink className="size-3.5" />
        </a>
      </div>
    </article>
  );
}

function SkeletonTile({ label }: { label: string }) {
  return (
    <article
      data-product-card
      className="w-[214px] shrink-0 snap-start overflow-hidden rounded-[18px] border border-black/[.07] bg-white sm:w-[238px]"
      aria-hidden
    >
      <Skeleton className="aspect-square w-full rounded-none" />
      <div className="flex min-h-[168px] flex-col p-3.5">
        <p className="text-[12px] text-[#a29c96]">正在取 {label} 的淘宝商品…</p>
        <Skeleton className="mt-3 h-3.5 w-full" />
        <Skeleton className="mt-2 h-3.5 w-2/3" />
        <Skeleton className="mt-auto h-9 w-full rounded-[12px]" />
      </div>
    </article>
  );
}
