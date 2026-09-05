import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SkuCandidate, UserProduct } from "@/lib/types/domain";
import { EMPTY_PRODUCT_FORM } from "@/frontend/lib/constants";
import { candidateToForm, parseTags, productToForm } from "@/frontend/lib/formatters";
import type { ProductFormState } from "@/frontend/lib/types";

type UseBeautyKitOptions = {
  userId: string;
  onError: (message: string) => void;
};

export function useBeautyKit({ userId, onError }: UseBeautyKitOptions) {
  const [products, setProducts] = useState<UserProduct[]>([]);
  const [productForm, setProductForm] = useState<ProductFormState>(EMPTY_PRODUCT_FORM);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);

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

  const fillFromCandidate = useCallback((candidate: SkuCandidate) => {
    setProductForm(candidateToForm(candidate));
    setEditingProductId(null);
  }, []);

  const saveProduct = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!productForm.brand.trim() || !productForm.name.trim() || !productForm.category.trim()) return false;

    const payload = {
      userId,
      brand: productForm.brand,
      name: productForm.name,
      category: productForm.category,
      shade: productForm.shade,
      colorFamily: productForm.colorFamily,
      finish: productForm.finish,
      texture: productForm.texture,
      effectTags: parseTags(productForm.effectTags),
      notes: productForm.notes
    };

    const url = editingProductId ? `/api/user-products/${editingProductId}` : "/api/user-products";
    const method = editingProductId ? "PATCH" : "POST";
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      onError(data?.error ?? "保存妆匣产品失败。");
      return false;
    }

    resetProductForm();
    await loadProducts();
    return true;
  }, [editingProductId, loadProducts, onError, productForm, resetProductForm, userId]);

  const deleteProduct = useCallback(async (productId: string) => {
    const response = await fetch(`/api/user-products/${productId}?userId=${userId}`, { method: "DELETE" });
    if (!response.ok) {
      onError("删除妆匣产品失败。");
      return;
    }
    if (editingProductId === productId) resetProductForm();
    await loadProducts();
  }, [editingProductId, loadProducts, onError, resetProductForm, userId]);

  return {
    products,
    productForm,
    editingProductId,
    updateProductField,
    resetProductForm,
    editProduct,
    fillFromCandidate,
    saveProduct,
    deleteProduct
  };
}
