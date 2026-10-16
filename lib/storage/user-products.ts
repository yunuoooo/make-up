import { deriveIntensity, type AttributeSourceRecord, type LookIntensity } from "../kit/attributes.ts";
import { findCategory, normalizeCategoryId, type KitCategoryId } from "../kit/categories.ts";
import { makeId, readJson, writeJson } from "./json-store.ts";
import type { ProductRecordSource, ProductStatus, UserProduct } from "@/lib/types/domain";

const fileName = "user-products.json";

/**
 * 妆匣的存储层。
 *
 * **相对路径导入是刻意的**：`.pi/extensions/kit-source.ts` 会在 pi 的子进程里
 * 直接 import 这个文件（先例：`xhs-source.ts` import `lib/xhs/tikhub.ts`），
 * 而 pi 用 jiti 加载，仓库的 `@/*` 别名在那边解析不了。`json-store.ts` 与
 * `lib/kit/*` 都只依赖 node 内置模块，所以能一路相对下去。
 * `@/lib/types/domain` 是 `import type`（会被擦除），不影响。
 *
 * 读-改-写：`readJson` 遇到解析失败是**返回 fallback** 的（见 json-store 的注释），
 * 所以一次截断 + 一次写入会把空库固化。批量写入一律走 `createUserProducts`，
 * 一次读一次写，别在循环里调 `createUserProduct`。
 */

export type ProductInput = {
  brand: string;
  /** 选填（规格决策 4：必填只有品类与品牌）。缺省时界面回落到品牌名显示。 */
  name?: string;
  skuId?: string;
  category: string;
  shade?: string;
  attributes?: Record<string, string>;
  attributeSources?: Record<string, AttributeSourceRecord>;
  colorFamily?: string;
  finish?: string;
  texture?: string;
  effectTags?: string[];
  status?: ProductStatus;
  recordSource?: ProductRecordSource;
  rating?: number;
  notes?: string;
};

/** 与 `attributes` 同名的三个 legacy 顶层列：写入时镜像，读取时 `attributes` 优先。 */
const LEGACY_ATTRIBUTE_KEYS = ["colorFamily", "finish", "texture"] as const;

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function cleanAttributes(input: Record<string, string | undefined> | undefined): Record<string, string> | undefined {
  if (!input) return undefined;
  const entries = Object.entries(input)
    .map(([key, value]) => [key, clean(value)] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/**
 * 把 legacy 顶层列并进 `attributes`。存量数据只有顶层列，新写入的镜像两边都有。
 *
 * 合并顺序：`attributes` 里的键**赢**。这样手工改过 `attributes` 的记录不会
 * 被一个陈旧的顶层列顶掉。
 */
export function mergeAttributes(product: Pick<UserProduct, "attributes" | "colorFamily" | "finish" | "texture">): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const key of LEGACY_ATTRIBUTE_KEYS) {
    const legacy = clean(product[key]);
    if (legacy) merged[key] = legacy;
  }
  for (const [key, value] of Object.entries(product.attributes ?? {})) {
    const trimmed = clean(value);
    if (trimmed) merged[key] = trimmed;
  }
  return merged;
}

/** 与 `mergeAttributes` 相反的方向：写入时把三个同名键抄回 legacy 顶层列。 */
function legacyMirror(attributes: Record<string, string> | undefined): Pick<UserProduct, "colorFamily" | "finish" | "texture"> {
  return {
    colorFamily: clean(attributes?.colorFamily),
    finish: clean(attributes?.finish),
    texture: clean(attributes?.texture)
  };
}

/** 工具返回给模型的形状。受控字段，不透传存储原文。 */
export type KitProductView = {
  id: string;
  categoryId: KitCategoryId | null;
  /** 归一化后的标准一级中文名；认不出品类时为 null。 */
  category: string | null;
  /** 用户原文，保留。 */
  categoryRaw: string;
  brand: string;
  name?: string;
  shade?: string;
  status: ProductStatus;
  recordSource: ProductRecordSource;
  attributes: Record<string, string>;
  attributeSources: Record<string, AttributeSourceRecord>;
  /** 派生值，不落库（规格第 7.2 节）。算不出来就不给。 */
  intensity?: LookIntensity;
};

export function kitProductView(product: UserProduct): KitProductView {
  const categoryId = normalizeCategoryId(product.category);
  const attributes = mergeAttributes(product);
  const intensity = categoryId ? deriveIntensity(categoryId, attributes) : null;
  return {
    id: product.id,
    categoryId,
    category: categoryId ? findCategory(categoryId).name : null,
    categoryRaw: product.category,
    brand: product.brand,
    ...(product.name ? { name: product.name } : {}),
    ...(product.shade ? { shade: product.shade } : {}),
    status: product.status,
    recordSource: product.recordSource ?? "manual",
    attributes,
    attributeSources: product.attributeSources ?? {},
    ...(intensity ? { intensity } : {})
  };
}

function toProduct(userId: string, input: ProductInput, now: string, id?: string): UserProduct {
  const attributes = cleanAttributes(input.attributes);
  // 三个 legacy 列：显式给了就用，没给就从 attributes 抄；两边都没有就留空。
  const mirror = legacyMirror(attributes);
  return {
    id: id ?? makeId("prod"),
    userId,
    brand: input.brand.trim(),
    name: clean(input.name) ?? "",
    skuId: clean(input.skuId),
    category: input.category.trim(),
    shade: clean(input.shade),
    ...(attributes ? { attributes } : {}),
    ...(input.attributeSources ? { attributeSources: input.attributeSources } : {}),
    colorFamily: clean(input.colorFamily) ?? mirror.colorFamily,
    finish: clean(input.finish) ?? mirror.finish,
    texture: clean(input.texture) ?? mirror.texture,
    effectTags: input.effectTags?.map((tag) => tag.trim()).filter(Boolean) ?? [],
    status: input.status ?? "owned",
    recordSource: input.recordSource ?? "manual",
    rating: input.rating,
    notes: clean(input.notes),
    createdAt: now,
    updatedAt: now
  };
}

export async function listUserProducts(userId = "local-user"): Promise<UserProduct[]> {
  const products = await readJson<UserProduct[]>(fileName, []);
  return products.filter((product) => product.userId === userId && product.status !== "retired");
}

/** 全量（含 retired）。预设播种要判断「库到底空不空」，不能只看未退役的那些。 */
export async function listAllUserProducts(userId = "local-user"): Promise<UserProduct[]> {
  const products = await readJson<UserProduct[]>(fileName, []);
  return products.filter((product) => product.userId === userId);
}

export async function createUserProduct(userId: string, input: ProductInput): Promise<UserProduct> {
  const [product] = await createUserProducts(userId, [input]);
  return product;
}

/** 批量写入：一次读、一次写。导入与预设播种都走这里，别在循环里单条写。 */
export async function createUserProducts(userId: string, inputs: ProductInput[]): Promise<UserProduct[]> {
  if (inputs.length === 0) return [];
  const now = new Date().toISOString();
  const products = await readJson<UserProduct[]>(fileName, []);
  const created = inputs.map((input) => toProduct(userId, input, now));
  await writeJson(fileName, [...created, ...products]);
  return created;
}

export async function updateUserProduct(userId: string, id: string, input: Partial<ProductInput>): Promise<UserProduct | null> {
  const products = await readJson<UserProduct[]>(fileName, []);
  const index = products.findIndex((product) => product.id === id && product.userId === userId);
  if (index === -1) return null;

  const current = products[index];
  const attributes = cleanAttributes(input.attributes) ?? current.attributes;
  const mirror = legacyMirror(attributes);
  const next: UserProduct = {
    ...current,
    ...input,
    brand: input.brand?.trim() ?? current.brand,
    name: input.name === undefined ? current.name : (clean(input.name) ?? ""),
    category: input.category?.trim() ?? current.category,
    attributes: attributes ?? current.attributes,
    effectTags: input.effectTags?.map((tag) => tag.trim()).filter(Boolean) ?? current.effectTags,
    // 镜像只在 attributes 里有对应键时才覆盖，否则保留原值（可能来自更早的顶层列）。
    colorFamily: mirror.colorFamily ?? current.colorFamily,
    finish: mirror.finish ?? current.finish,
    texture: mirror.texture ?? current.texture,
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

/** 一键清空预设：只删 `recordSource === "preset"` 的条目，用户自己录的一律不动。 */
export async function deleteProductsBySource(userId: string, source: ProductRecordSource): Promise<number> {
  const products = await readJson<UserProduct[]>(fileName, []);
  const next = products.filter((product) => !(product.userId === userId && (product.recordSource ?? "manual") === source));
  const removed = products.length - next.length;
  if (removed > 0) await writeJson(fileName, next);
  return removed;
}
