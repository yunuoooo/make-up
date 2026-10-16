"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/frontend/components/ui/button";
import { Input } from "@/frontend/components/ui/input";
import { Textarea } from "@/frontend/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/frontend/components/ui/dialog";
import { CATEGORY_OPTIONS } from "@/frontend/lib/constants";

/**
 * 粘贴淘宝购买记录导入。
 *
 * 三条硬规则落在界面上（规格 `docs/specs/10-16-makeup-kit.md` 第 6.4 节）：
 * 1. **不确认不落库**——解析只出预览，零写入；
 * 2. **没认出来的条目要显示出来**，否则用户以为解析全了；
 * 3. **缺失的字段不补全**——色号空了就是空了，不猜。
 *
 * 「买到 ≠ 还在用」，所以每条都能标「已用完」，落库时写 `retired`（不参与复用判断）。
 */

type PreviewItem = {
  key: string;
  category: string;
  brand: string;
  name: string;
  shade: string;
  attributes: Record<string, string>;
  editedAttributes: string[];
  unknowns: string[];
  rawExcerpt: string;
  use: boolean;
  retired: boolean;
};

type ParseResponse = {
  items: Array<{
    category: string;
    categoryRaw: string;
    brand: string;
    name?: string;
    shade?: string;
    attributes: Record<string, string>;
    confidence: string;
    unknowns: string[];
    rawExcerpt: string;
  }>;
  skipped: Array<{ rawExcerpt: string; reason: string }>;
  error?: string;
};

const FIELD_LABEL = "grid gap-1.5 text-sm font-medium text-[#4d4742]";
const ATTRIBUTE_LABEL: Record<string, string> = {
  colorFamily: "色系",
  finish: "妆效",
  texture: "质地",
  coverage: "遮盖力",
  longevity: "持妆",
  oilControl: "控油",
  form: "形态",
  pigmentation: "显色度",
  structure: "结构",
  waterproof: "防水",
  colorTemperature: "色温"
};

const SKIP_REASON: Record<string, string> = {
  "not-cosmetics": "看起来不是化妆品",
  unknown: "没认出来"
};

export function ImportDialog({
  open,
  onOpenChange,
  userId,
  onImported
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  onImported: () => Promise<void> | void;
}) {
  const [text, setText] = useState("");
  const [isParsing, setIsParsing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [items, setItems] = useState<PreviewItem[] | null>(null);
  const [skipped, setSkipped] = useState<Array<{ rawExcerpt: string; reason: string }>>([]);

  function reset() {
    setText("");
    setItems(null);
    setSkipped([]);
  }

  async function parse() {
    if (!text.trim()) return;
    setIsParsing(true);
    try {
      const response = await fetch("/api/user-products/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });
      const data = (await response.json().catch(() => null)) as ParseResponse | null;
      if (!response.ok) {
        toast.error(data?.error ?? "解析失败。");
        return;
      }

      const parsed: PreviewItem[] = (data?.items ?? []).map((item, index) => ({
        key: `${index}-${item.brand}-${item.shade ?? ""}`,
        category: item.category || item.categoryRaw,
        brand: item.brand,
        name: item.name ?? "",
        shade: item.shade ?? "",
        attributes: { ...item.attributes },
        editedAttributes: [],
        unknowns: item.unknowns ?? [],
        rawExcerpt: item.rawExcerpt,
        // 默认勾上：用户粘的就是他买的。但每条都能取消或标成已用完。
        use: Boolean(item.brand),
        retired: false
      }));
      setItems(parsed);
      setSkipped(data?.skipped ?? []);
      if (parsed.length === 0) {
        toast.warning("没有认出任何化妆品，可以检查一下粘贴的内容。");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "解析失败。");
    } finally {
      setIsParsing(false);
    }
  }

  function patchItem(key: string, patch: Partial<PreviewItem>) {
    setItems((current) => current?.map((item) => (item.key === key ? { ...item, ...patch } : item)) ?? null);
  }

  function patchAttribute(key: string, attribute: string, value: string) {
    setItems((current) =>
      current?.map((item) => {
        if (item.key !== key) return item;
        // 记下用户改过哪些属性：落库时这几个的来源才算 `user`，其余仍是模型推断的线索。
        const edited = item.editedAttributes.includes(attribute)
          ? item.editedAttributes
          : [...item.editedAttributes, attribute];
        return { ...item, attributes: { ...item.attributes, [attribute]: value }, editedAttributes: edited };
      }) ?? null
    );
  }

  async function save() {
    const chosen = (items ?? []).filter((item) => item.use);
    if (chosen.length === 0) {
      toast.warning("还没有勾选任何条目。");
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch("/api/user-products/import/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          items: chosen.map((item) => ({
            category: item.category,
            brand: item.brand,
            name: item.name,
            shade: item.shade,
            attributes: item.attributes,
            editedAttributes: item.editedAttributes,
            retired: item.retired
          }))
        })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(data?.error ?? "导入失败。");
        return;
      }

      toast.success(`已导入 ${data?.imported ?? chosen.length} 件`);
      await onImported();
      reset();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导入失败。");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && (isParsing || isSaving)) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto rounded-[22px] border-black/[.08] bg-[#fbfaf8] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl tracking-[-.02em] text-[#2d2926]">
            粘贴购买记录导入
          </DialogTitle>
          <DialogDescription className="leading-6">
            复制淘宝订单或购买记录里的文字粘进来，系统会解析出品牌、色号和特点。
            <span className="text-[#8a827b]">只支持文字，不支持截图。</span>
            解析结果先给你核对，确认后才存进妆匣。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <label className={FIELD_LABEL}>
            购买记录文字
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={6}
              placeholder={"例如：\nMAC 魅可 子弹头唇膏 Chili 小辣椒 1.8g\nNARS 腮红 Orgasm 高潮色 4.8g"}
              disabled={isParsing}
            />
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              className="rounded-xl"
              onClick={parse}
              disabled={isParsing || !text.trim()}
            >
              {isParsing ? "正在解析…" : items ? "重新解析" : "解析"}
            </Button>
            {items ? <span className="text-xs text-[#8a827b]">解析不会写进妆匣，确认后才保存。</span> : null}
          </div>
        </div>

        {items && items.length > 0 ? (
          <div className="mt-2 grid gap-3">
            <p className="text-sm font-medium text-[#4d4742]">
              认出 {items.length} 件，勾选要加进妆匣的：
            </p>
            {items.map((item) => (
              <div key={item.key} className="rounded-[16px] border border-black/[.07] bg-white px-4 py-3">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1.5 size-4 accent-[#d8587e]"
                    checked={item.use}
                    onChange={(event) => patchItem(item.key, { use: event.target.checked })}
                    aria-label={`导入 ${item.brand}`}
                  />
                  <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
                    <label className="grid gap-1 text-xs text-[#8a827b]">
                      品类
                      <select
                        className="h-9 rounded-lg border border-black/[.08] bg-white px-2 text-sm text-[#322e2b]"
                        value={CATEGORY_OPTIONS.includes(item.category) ? item.category : ""}
                        onChange={(event) => patchItem(item.key, { category: event.target.value })}
                      >
                        <option value="">待归类（{item.category || "未认出"}）</option>
                        {CATEGORY_OPTIONS.map((category) => (
                          <option key={category} value={category}>
                            {category}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1 text-xs text-[#8a827b]">
                      品牌
                      <Input
                        value={item.brand}
                        onChange={(event) => patchItem(item.key, { brand: event.target.value })}
                      />
                    </label>
                    <label className="grid gap-1 text-xs text-[#8a827b]">
                      产品名
                      <Input
                        value={item.name}
                        onChange={(event) => patchItem(item.key, { name: event.target.value })}
                      />
                    </label>
                    <label className="grid gap-1 text-xs text-[#8a827b]">
                      色号
                      <Input
                        value={item.shade}
                        placeholder="没解析出来就留空"
                        onChange={(event) => patchItem(item.key, { shade: event.target.value })}
                      />
                    </label>

                    {Object.keys(item.attributes).length > 0 ? (
                      <div className="grid gap-2 sm:col-span-2 sm:grid-cols-3">
                        {Object.entries(item.attributes).map(([attribute, value]) => (
                          <label key={attribute} className="grid gap-1 text-xs text-[#8a827b]">
                            {ATTRIBUTE_LABEL[attribute] ?? attribute}
                            <Input
                              value={value}
                              onChange={(event) => patchAttribute(item.key, attribute, event.target.value)}
                            />
                          </label>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-[#8a827b] sm:col-span-2">
                        还没解析出特点——保存后可以在这件化妆品的卡片上点「判断特点」。
                      </p>
                    )}
                  </div>
                </div>

                {item.rawExcerpt ? (
                  <p className="mt-2 pl-7 text-xs text-[#a49b93]">原文：{item.rawExcerpt}</p>
                ) : null}
                {item.unknowns.length > 0 ? (
                  <p className="mt-1 pl-7 text-xs text-[#a49b93]">
                    这些没解析出来，需要你自己确认：{item.unknowns.join("、")}
                  </p>
                ) : null}

                <label className="mt-2 flex items-center gap-2 pl-7 text-xs text-[#8a827b]">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-[#d8587e]"
                    checked={item.retired}
                    onChange={(event) => patchItem(item.key, { retired: event.target.checked })}
                  />
                  已经用完 / 不再使用（记录会留着，但不参与复用判断）
                </label>
              </div>
            ))}

            {skipped.length > 0 ? (
              <div className="rounded-[16px] border border-[#eadfcf] bg-[#fdf9f2] px-4 py-3 text-xs text-[#8a7758]">
                <p className="font-medium">有 {skipped.length} 条没有认出来，不会导入：</p>
                <ul className="mt-1.5 grid gap-1">
                  {skipped.map((entry, index) => (
                    <li key={`${index}-${entry.rawExcerpt}`}>
                      {SKIP_REASON[entry.reason] ?? entry.reason}
                      {entry.rawExcerpt ? `：${entry.rawExcerpt}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {items && items.length === 0 ? (
          <div className="rounded-[16px] border border-[#eadfcf] bg-[#fdf9f2] px-4 py-3 text-sm text-[#8a7758]">
            没有认出化妆品。确认一下粘贴的是商品标题或订单文字。
            {skipped.length > 0 ? (
              <ul className="mt-1.5 grid gap-1 text-xs">
                {skipped.map((entry, index) => (
                  <li key={`${index}-${entry.rawExcerpt}`}>
                    {SKIP_REASON[entry.reason] ?? entry.reason}
                    {entry.rawExcerpt ? `：${entry.rawExcerpt}` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <DialogFooter className="mt-2">
          <Button
            type="button"
            variant="outline"
            className="rounded-xl"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            disabled={isParsing || isSaving}
          >
            取消
          </Button>
          <Button
            type="button"
            className="rounded-xl bg-[#242421] text-white hover:bg-[#393834]"
            onClick={save}
            disabled={isSaving || !items || items.length === 0}
          >
            {isSaving ? "正在保存…" : `确认导入${items ? `（${items.filter((item) => item.use).length} 件）` : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
