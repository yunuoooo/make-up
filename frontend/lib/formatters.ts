import type { SkuCandidate, UserProduct } from "@/lib/types/domain";
import type { ProductFormState } from "./types";

export function makeClientId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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

export function candidateToForm(candidate: SkuCandidate): ProductFormState {
  return {
    brand: candidate.brand,
    name: candidate.name,
    category: candidate.category,
    shade: candidate.shade ?? "",
    colorFamily: candidate.colorFamily ?? "",
    finish: candidate.finish ?? "",
    texture: candidate.texture ?? "",
    effectTags: candidate.effectTags.join("、"),
    notes: candidate.reason
  };
}
