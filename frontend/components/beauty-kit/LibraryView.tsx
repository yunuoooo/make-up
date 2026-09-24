"use client";

import { MoreHorizontal, PackageOpen, PencilLine, Plus, Search, Trash2 } from "lucide-react";
import type { UserProduct } from "@/lib/types/domain";
import { Button } from "@/frontend/components/ui/button";
import { Input } from "@/frontend/components/ui/input";
import { productTags } from "@/frontend/lib/formatters";

type LibraryViewProps = {
  /** 已经过搜索和品类筛选的产品。 */
  products: UserProduct[];
  totalCount: number;
  searchTerm: string;
  categoryFilter: string;
  categories: string[];
  onSearchChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  onCreate: () => void;
  onEdit: (product: UserProduct) => void;
  onDelete: (product: UserProduct) => void;
};

/** 卡片左侧的品类色块：按顺序轮换三种品牌色。 */
const SWATCH_STYLES = [
  "bg-[#f7dfe6] text-[#a84362]",
  "bg-[#e8e3de] text-[#6b5e55]",
  "bg-[#e4ece5] text-[#4f6a54]"
];

export function LibraryView({
  products,
  totalCount,
  searchTerm,
  categoryFilter,
  categories,
  onSearchChange,
  onCategoryChange,
  onCreate,
  onEdit,
  onDelete
}: LibraryViewProps) {
  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-7 sm:px-8 lg:px-12">
      <div className="mx-auto w-full max-w-6xl">
        <div className="flex flex-col gap-5 border-b border-black/[.07] pb-6 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[.16em] text-[#b24c6b]">My beauty kit</p>
            <h1 className="mt-2 font-serif text-4xl tracking-[-.025em] text-[#282421]">已经拥有的每一件，都先用起来。</h1>
            <p className="mt-3 text-sm leading-6 text-[#817a74]">
              录入品牌、完整产品名和版本/色号，顾问才能把匹配单品准确标成 ✅。
            </p>
          </div>
          <label className="flex h-11 min-w-[260px] items-center gap-2 rounded-xl border border-black/[.08] bg-white px-3 shadow-sm">
            <Search className="size-4 text-[#9b938c]" />
            <Input
              value={searchTerm}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="搜索品牌、产品或色号"
              aria-label="搜索化妆品"
              className="h-auto border-0 p-0 shadow-none focus-visible:ring-0"
            />
          </label>
        </div>

        <div className="scrollbar-none mt-5 flex gap-2 overflow-x-auto pb-1" aria-label="按品类筛选">
          {categories.map((category) => (
            <button
              key={category}
              type="button"
              onClick={() => onCategoryChange(category)}
              className={
                categoryFilter === category
                  ? "whitespace-nowrap rounded-full bg-[#242421] px-3.5 py-2 text-sm text-white"
                  : "whitespace-nowrap rounded-full border border-black/[.07] bg-white px-3.5 py-2 text-sm text-[#746d67] hover:border-[#d8587e]/30"
              }
            >
              {category}
            </button>
          ))}
        </div>

        {products.length ? (
          <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {products.map((product, index) => (
              <article
                key={product.id}
                className="group flex h-full flex-col rounded-[20px] border border-black/[.07] bg-white p-5 shadow-[0_8px_28px_rgba(40,35,32,.05)] transition hover:-translate-y-0.5 hover:shadow-[0_14px_34px_rgba(40,35,32,.08)]"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 gap-3">
                    <div
                      className={`grid size-11 shrink-0 place-items-center rounded-[14px] text-sm font-semibold ${SWATCH_STYLES[index % SWATCH_STYLES.length]}`}
                    >
                      {product.category.slice(0, 1)}
                    </div>
                    <div className="min-w-0">
                      <p className="text-[12px] font-medium uppercase tracking-[.08em] text-[#a19891]">{product.brand}</p>
                      <h2 className="mt-1 truncate text-base font-semibold text-[#322e2b]" title={product.name}>
                        {product.name}
                      </h2>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="grid size-8 shrink-0 place-items-center rounded-full text-[#9b948e] hover:bg-[#f2efed]"
                    aria-label="编辑这件化妆品"
                    onClick={() => onEdit(product)}
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                </div>

                <div className="mt-5 rounded-[14px] bg-[#f8f6f4] px-3.5 py-3">
                  <p className="text-[11px] text-[#9d958e]">版本 / 色号</p>
                  <p className="mt-1 text-sm font-semibold text-[#4a443f]">{product.shade || "未填写"}</p>
                  {product.colorFamily ? <p className="mt-0.5 text-[11px] text-[#9d958e]">色系：{product.colorFamily}</p> : null}
                </div>

                <div className="mt-4 flex flex-wrap gap-1.5">
                  {productTags(product).map((tag) => (
                    <span key={tag} className="rounded-full border border-black/[.06] px-2.5 py-1 text-[11px] text-[#7e766f]">
                      {tag}
                    </span>
                  ))}
                </div>

                {product.notes ? (
                  <p className="mt-4 line-clamp-2 text-[13px] leading-6 text-[#817a74]">{product.notes}</p>
                ) : null}

                {/* 备注可有可无，用弹性占位把操作行压到卡片底部，同一行卡片才对得齐。 */}
                <div className="min-h-5 flex-1" />

                <div className="flex gap-2 border-t border-black/[.055] pt-4">
                  <Button variant="outline" size="sm" className="flex-1 rounded-xl" onClick={() => onEdit(product)}>
                    <PencilLine />
                    编辑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="rounded-xl text-[#a7455f] hover:bg-[#fff0f3] hover:text-[#a7455f]"
                    onClick={() => onDelete(product)}
                  >
                    <Trash2 />
                    删除
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="mt-10 grid min-h-[360px] place-items-center rounded-[24px] border border-dashed border-black/[.12] bg-white/55 text-center">
            <div className="max-w-sm px-6">
              <div className="mx-auto grid size-14 place-items-center rounded-[18px] bg-[#f8e7ec] text-[#b64d6c]">
                <PackageOpen />
              </div>
              <h2 className="mt-4 text-lg font-semibold text-[#37322f]">
                {totalCount ? "没有找到匹配的产品" : "你的化妆品库还是空的"}
              </h2>
              <p className="mt-2 text-sm leading-6 text-[#817a74]">
                {totalCount
                  ? "换个关键词或选择其他品类。"
                  : "先录入一件你愿意继续使用的化妆品，下一次推荐就能自动判断为 ✅。"}
              </p>
              {!totalCount ? (
                <Button onClick={onCreate} className="mt-5 rounded-xl bg-[#242421] text-white hover:bg-[#393834]">
                  <Plus />
                  添加第一件
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
