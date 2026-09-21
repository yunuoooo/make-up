import type { UserProduct } from "@/lib/types/domain";
import type { ProductFormState } from "./types";

export function makeClientId(prefix: string) {
  const uuid = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${uuid}`;
}

export function parseTags(value: string): string[] {
  return value
    .split(/[,，、\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function productToForm(product: UserProduct): ProductFormState {
  return {
    brand: product.brand,
    name: product.name,
    category: product.category,
    shade: product.shade ?? "",
    colorFamily: product.colorFamily ?? "",
    finish: product.finish ?? "",
    texture: product.texture ?? "",
    effectTags: product.effectTags.join("、"),
    notes: product.notes ?? ""
  };
}

/** 成品的标签行：品类、妆效、质地加上自由标签，去重后取前若干个。 */
export function productTags(product: UserProduct, limit = 4): string[] {
  return Array.from(
    new Set([product.category, product.finish, product.texture, ...product.effectTags].filter(Boolean))
  ).slice(0, limit) as string[];
}

export function timeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}
