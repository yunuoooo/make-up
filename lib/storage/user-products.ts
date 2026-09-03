import { makeId, readJson, writeJson } from "@/lib/storage/json-store";
import type { ProductStatus, UserProduct } from "@/lib/types/domain";

const fileName = "user-products.json";

export type ProductInput = {
  brand: string;
  name: string;
  skuId?: string;
  category: string;
  shade?: string;
  colorFamily?: string;
  finish?: string;
  texture?: string;
  effectTags?: string[];
  status?: ProductStatus;
  rating?: number;
  notes?: string;
};

export async function listUserProducts(userId = "local-user"): Promise<UserProduct[]> {
  const products = await readJson<UserProduct[]>(fileName, []);
  return products.filter((product) => product.userId === userId && product.status !== "retired");
}

export async function createUserProduct(userId: string, input: ProductInput): Promise<UserProduct> {
  const now = new Date().toISOString();
  const products = await readJson<UserProduct[]>(fileName, []);
  const product: UserProduct = {
    id: makeId("prod"),
    userId,
    brand: input.brand.trim(),
    name: input.name.trim(),
    skuId: input.skuId?.trim() || undefined,
    category: input.category.trim(),
    shade: input.shade?.trim() || undefined,
    colorFamily: input.colorFamily?.trim() || undefined,
    finish: input.finish?.trim() || undefined,
    texture: input.texture?.trim() || undefined,
    effectTags: input.effectTags?.map((tag) => tag.trim()).filter(Boolean) ?? [],
    status: input.status ?? "owned",
    rating: input.rating,
    notes: input.notes?.trim() || undefined,
    createdAt: now,
    updatedAt: now
  };
  await writeJson(fileName, [product, ...products]);
  return product;
}

export async function updateUserProduct(userId: string, id: string, input: Partial<ProductInput>): Promise<UserProduct | null> {
  const products = await readJson<UserProduct[]>(fileName, []);
  const index = products.findIndex((product) => product.id === id && product.userId === userId);
  if (index === -1) return null;

  const current = products[index];
  const next: UserProduct = {
    ...current,
    ...input,
    brand: input.brand?.trim() ?? current.brand,
    name: input.name?.trim() ?? current.name,
    category: input.category?.trim() ?? current.category,
    effectTags: input.effectTags?.map((tag) => tag.trim()).filter(Boolean) ?? current.effectTags,
    updatedAt: new Date().toISOString()
  };

  products[index] = next;
  await writeJson(fileName, products);
  return next;
}

export async function deleteUserProduct(userId: string, id: string): Promise<boolean> {
  const products = await readJson<UserProduct[]>(fileName, []);
  const next = products.filter((product) => !(product.id === id && product.userId === userId));
  if (next.length === products.length) return false;
  await writeJson(fileName, next);
  return true;
}
