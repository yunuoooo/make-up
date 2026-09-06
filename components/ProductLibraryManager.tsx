"use client";

import {
  ArrowLeft,
  CheckCircle2,
  CircleAlert,
  PencilLine,
  Plus,
  Search,
  ShoppingBag,
  Trash2,
  X
} from "lucide-react";
import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type { UserProduct } from "@/lib/types/domain";

const userId = "local-user";

type ProductFormState = {
  brand: string;
  name: string;
  category: string;
  shade: string;
  colorFamily: string;
  finish: string;
  texture: string;
  effectTags: string;
  notes: string;
};

const categoryOptions = ["粉底液", "腮红", "眉笔", "唇泥", "唇釉", "修容", "眼影", "卧蚕笔"];

const emptyForm: ProductFormState = {
  brand: "",
  name: "",
  category: "腮红",
  shade: "",
  colorFamily: "",
  finish: "",
  texture: "",
  effectTags: "",
  notes: ""
};

function parseTags(value: string): string[] {
  return value
    .split(/[,，、\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function productToForm(product: UserProduct): ProductFormState {
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

export function ProductLibraryManager() {
  const [products, setProducts] = useState<UserProduct[]>([]);
  const [productForm, setProductForm] = useState<ProductFormState>(emptyForm);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("全部");
  const [error, setError] = useState<string | null>(null);

  const categories = useMemo(() => {
    const values = new Set([...categoryOptions, ...products.map((product) => product.category)]);
    return ["全部", ...Array.from(values).filter(Boolean)];
  }, [products]);

  const filteredProducts = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();

    return products.filter((product) => {
      const categoryMatches = categoryFilter === "全部" || product.category === categoryFilter;
      const searchText = [
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

      return categoryMatches && (!keyword || searchText.includes(keyword));
    });
  }, [categoryFilter, products, searchTerm]);

  async function loadProducts() {
    const response = await fetch(`/api/user-products?userId=${userId}`, { cache: "no-store" });
    const data = await response.json();
    setProducts(data.products ?? []);
  }

  useEffect(() => {
    loadProducts();
  }, []);

  function resetForm() {
    setProductForm(emptyForm);
    setEditingProductId(null);
  }

  async function saveProduct(event: FormEvent) {
    event.preventDefault();
    if (!productForm.brand.trim() || !productForm.name.trim() || !productForm.category.trim()) return;

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

    if (!response.ok) {
      const data = await response.json().catch(() => null);
      setError(data?.error ?? "保存产品失败。");
      return;
    }

    resetForm();
    await loadProducts();
  }

  async function deleteProduct(productId: string) {
    const response = await fetch(`/api/user-products/${productId}?userId=${userId}`, { method: "DELETE" });
    if (!response.ok) {
      setError("删除产品失败。");
      return;
    }
    if (editingProductId === productId) resetForm();
    await loadProducts();
  }

  return (
    <main className="library-page-shell">
      <header className="library-page-header">
        <div className="library-page-title">
          <Link className="back-link" href="/">
            <ArrowLeft size={16} />
            回到聊天
          </Link>
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true">妆</div>
            <div>
              <h1>化妆品管理库</h1>
              <p>PRODUCT LIBRARY</p>
            </div>
          </div>
        </div>
        <div className="library-summary">
          <span>{products.length} 件产品</span>
          <span>{categories.length - 1} 个品类</span>
        </div>
      </header>

      {error ? (
        <div className="error-banner" role="alert">
          <CircleAlert size={18} />
          <span>{error}</span>
          <button className="icon-button" type="button" title="关闭提示" onClick={() => setError(null)}>
            <X size={16} />
          </button>
        </div>
      ) : null}

      <section className="library-page-grid" aria-label="化妆品管理库">
        <section className="library-main">
          <div className="library-toolbar">
            <div>
              <p>MY BEAUTY KIT</p>
              <h2>全部产品</h2>
            </div>
            <label className="search-field">
              <Search size={16} />
              <input
                aria-label="搜索产品"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="搜索品牌、色号、标签"
              />
            </label>
          </div>

          <div className="category-filter" aria-label="按品类筛选">
            {categories.map((category) => (
              <button
                className={categoryFilter === category ? "active" : ""}
                key={category}
                type="button"
                onClick={() => setCategoryFilter(category)}
              >
                {category}
              </button>
            ))}
          </div>

          <div className="library-table-list">
            {filteredProducts.length > 0 ? filteredProducts.map((product) => (
              <article className="library-product-card" key={product.id}>
                <div className="library-product-main">
                  <span className={`swatch ${product.colorFamily?.includes("粉") ? "rose" : ""}`} />
                  <div>
                    <strong>{product.brand} {product.name}</strong>
                    <span>{product.category} · {product.shade ?? product.colorFamily ?? "未填色号"}</span>
                  </div>
                </div>
                <p>
                  {[product.finish, product.texture, ...product.effectTags].filter(Boolean).join("、") || "暂无标签"}
                </p>
                <div className="library-product-actions">
                  <button type="button" onClick={() => {
                    setProductForm(productToForm(product));
                    setEditingProductId(product.id);
                  }}>
                    <PencilLine size={14} />
                    编辑
                  </button>
                  <button type="button" onClick={() => deleteProduct(product.id)}>
                    <Trash2 size={14} />
                    删除
                  </button>
                </div>
              </article>
            )) : (
              <div className="library-empty-state">
                <ShoppingBag size={22} />
                <p>{products.length === 0 ? "还没有产品" : "没有匹配的产品"}</p>
              </div>
            )}
          </div>
        </section>

        <aside className="library-page-card" aria-label={editingProductId ? "编辑产品" : "新增产品"}>
          <div className="section-heading">
            <Plus size={17} />
            <h3>{editingProductId ? "编辑产品" : "新增化妆品"}</h3>
          </div>
          <form className="product-form" onSubmit={saveProduct}>
            <div className="form-row">
              <label>
                品牌
                <input value={productForm.brand} onChange={(event) => setProductForm({ ...productForm, brand: event.target.value })} />
              </label>
              <label>
                品类
                <select value={productForm.category} onChange={(event) => setProductForm({ ...productForm, category: event.target.value })}>
                  {categoryOptions.map((category) => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              产品名
              <input value={productForm.name} onChange={(event) => setProductForm({ ...productForm, name: event.target.value })} />
            </label>
            <div className="form-row">
              <label>
                色号
                <input value={productForm.shade} onChange={(event) => setProductForm({ ...productForm, shade: event.target.value })} />
              </label>
              <label>
                色系
                <input value={productForm.colorFamily} onChange={(event) => setProductForm({ ...productForm, colorFamily: event.target.value })} />
              </label>
            </div>
            <div className="form-row">
              <label>
                妆效
                <input value={productForm.finish} onChange={(event) => setProductForm({ ...productForm, finish: event.target.value })} />
              </label>
              <label>
                质地
                <input value={productForm.texture} onChange={(event) => setProductForm({ ...productForm, texture: event.target.value })} />
              </label>
            </div>
            <label>
              标签
              <input
                value={productForm.effectTags}
                onChange={(event) => setProductForm({ ...productForm, effectTags: event.target.value })}
                placeholder="低饱和、雾面、灰棕"
              />
            </label>
            <label>
              备注
              <textarea
                value={productForm.notes}
                onChange={(event) => setProductForm({ ...productForm, notes: event.target.value })}
                rows={3}
              />
            </label>
            <div className="form-actions">
              <button className="primary-button" type="submit">
                <CheckCircle2 size={17} />
                {editingProductId ? "保存修改" : "保存"}
              </button>
              {editingProductId ? (
                <button className="secondary-button" type="button" onClick={resetForm}>
                  取消
                </button>
              ) : null}
            </div>
          </form>
        </aside>
      </section>
    </main>
  );
}
