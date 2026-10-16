"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { UserProduct } from "@/lib/types/domain";
import { CATEGORY_OPTIONS, EMPTY_PRODUCT_FORM } from "@/frontend/lib/constants";
import { parseTags, productToForm } from "@/frontend/lib/formatters";
import type { ProductFormState } from "@/frontend/lib/types";

type UseBeautyKitOptions = {
  userId: string;
  onError: (message: string) => void;
};

const ALL_CATEGORIES = "全部";

export function useBeautyKit({ userId, onError }: UseBeautyKitOptions) {
  const [products, setProducts] = useState<UserProduct[]>([]);
  const [productForm, setProductForm] = useState<ProductFormState>(EMPTY_PRODUCT_FORM);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState(ALL_CATEGORIES);
  const [isClearingPreset, setIsClearingPreset] = useState(false);

  const loadProducts = useCallback(async () => {
    const response = await fetch(`/api/user-products?userId=${userId}`, { cache: "no-store" });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.error ?? "读取妆匣失败。");
    }

    setProducts(data.products ?? []);
  }, [userId]);

  useEffect(() => {
    loadProducts().catch((error) => {
      onError(error instanceof Error ? error.message : "读取妆匣失败。");
    });
  }, [loadProducts, onError]);

  const updateProductField = useCallback((field: keyof ProductFormState, value: string) => {
    setProductForm((current) => ({ ...current, [field]: value }));
  }, []);

  const resetProductForm = useCallback(() => {
    setProductForm(EMPTY_PRODUCT_FORM);
    setEditingProductId(null);
  }, []);

  const editProduct = useCallback((product: UserProduct) => {
    setProductForm(productToForm(product));
    setEditingProductId(product.id);
  }, []);

  /** 重新判断某一件的特点（手动录入后自动跑过一次，也能手动再跑）。 */
  const judgeProduct = useCallback(async (productId: string, options: { silent?: boolean } = {}) => {
    try {
      const response = await fetch(`/api/user-products/${productId}/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        // 判断失败不影响记录：条目还在，特点留空，用户能再点一次。
        if (!options.silent) toast.error(data?.error ?? "判断特点失败。");
        return false;
      }
      await loadProducts();
      if (data?.judged === 0 && !options.silent) {
        toast.info(data?.message ?? "没能从现有信息判断出新特点。");
      }
      return true;
    } catch (error) {
      if (!options.silent) {
        toast.error(error instanceof Error ? error.message : "判断特点失败。");
      }
      return false;
    }
  }, [loadProducts, userId]);

  const saveProduct = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    // 必填只有品类与品牌（决策 4）：产品名与色号对部分品类本来就不适用，
    // 特点由判断调用回来后再填。
    if (!productForm.brand.trim() || !productForm.category.trim()) return false;

    // 三个 legacy 字段也走 attributes：写入时存储会镜像回顶层列，两边不会漂。
    const attributes = Object.fromEntries(
      Object.entries({
        colorFamily: productForm.colorFamily,
        finish: productForm.finish,
        texture: productForm.texture
      })
        .map(([key, value]) => [key, value.trim()] as const)
        .filter((entry) => Boolean(entry[1]))
    );

    const payload = {
      userId,
      brand: productForm.brand,
      name: productForm.name,
      category: productForm.category,
      shade: productForm.shade,
      attributes,
      effectTags: parseTags(productForm.effectTags),
      notes: productForm.notes
    };

    const url = editingProductId ? `/api/user-products/${editingProductId}` : "/api/user-products";
    const method = editingProductId ? "PATCH" : "POST";

    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        toast.error(data?.error ?? "保存妆匣产品失败。");
        return false;
      }

      const wasEditing = Boolean(editingProductId);
      const savedId = data?.product?.id as string | undefined;
      resetProductForm();
      await loadProducts();
      toast.success(wasEditing ? "化妆品信息已更新" : "已经加入你的化妆品库");

      // 新增的条目保存后**异步**判断一次特点，不阻断保存：判断是一次模型调用，
      // 把它做成保存的前置会把「加一件化妆品」变成一件要等的事（规格第 6.3 节）。
      // 失败就留空，卡片上还有「判断特点」可以再点。
      if (!wasEditing && savedId) void judgeProduct(savedId, { silent: true });
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存妆匣产品失败。");
      return false;
    }
  }, [editingProductId, judgeProduct, loadProducts, productForm, resetProductForm, userId]);

  const deleteProduct = useCallback(async (productId: string) => {
    try {
      const response = await fetch(`/api/user-products/${productId}?userId=${userId}`, { method: "DELETE" });
      if (!response.ok) {
        toast.error("删除妆匣产品失败。");
        return false;
      }

      if (editingProductId === productId) resetProductForm();
      await loadProducts();
      toast.success("这件化妆品已删除");
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除妆匣产品失败。");
      return false;
    }
  }, [editingProductId, loadProducts, resetProductForm, userId]);

  /** 品类筛选保留用户已录入的品类，历史数据里的旧品类不会消失。 */
  const categories = useMemo(
    () => [ALL_CATEGORIES, ...Array.from(new Set([...CATEGORY_OPTIONS, ...products.map((product) => product.category)]))],
    [products]
  );

  /** 还是示例（`recordSource: "preset"`）的条目。存量为空时按「不是示例」处理。 */
  const presetProducts = useMemo(
    () => products.filter((product) => product.recordSource === "preset"),
    [products]
  );

  /** 清空示例妆匣。只删预设条目，自己录的和导入的一条都不动（服务端按来源过滤）。 */
  const clearPreset = useCallback(async () => {
    setIsClearingPreset(true);
    try {
      const response = await fetch(`/api/user-products/preset?userId=${userId}`, { method: "DELETE" });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(data?.error ?? "清空示例妆匣失败。");
        return false;
      }
      await loadProducts();
      // 清空之后不会再播种（播种标记在第一次播种时就落下了），所以这句是真的。
      toast.success("示例妆匣已清空，不会再自动出现");
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "清空示例妆匣失败。");
      return false;
    } finally {
      setIsClearingPreset(false);
    }
  }, [loadProducts, userId]);

  const filteredProducts = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    return products.filter((product) => {
      if (categoryFilter !== ALL_CATEGORIES && product.category !== categoryFilter) return false;
      if (!keyword) return true;
      const haystack = [
        product.brand,
        product.name,
        product.category,
        product.shade,
        product.colorFamily,
        product.finish,
        product.texture,
        product.notes,
        ...product.effectTags
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(keyword);
    });
  }, [categoryFilter, products, searchTerm]);

  return {
    products,
    filteredProducts,
    categories,
    categoryFilter,
    setCategoryFilter,
    searchTerm,
    setSearchTerm,
    productForm,
    editingProductId,
    updateProductField,
    resetProductForm,
    editProduct,
    saveProduct,
    deleteProduct,
    presetProducts,
    clearPreset,
    isClearingPreset,
    judgeProduct,
    /** 导入确认后重新拉一次列表。 */
    reload: loadProducts
  };
}
