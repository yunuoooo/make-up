import { CheckCircle2, Plus, ShoppingBag, Trash2, X } from "lucide-react";
import type { FormEvent } from "react";
import type { UserProduct } from "@/lib/types/domain";
import { CATEGORY_OPTIONS } from "@/frontend/lib/constants";
import type { ProductFormChange, ProductFormState } from "@/frontend/lib/types";

type BeautyKitDrawerProps = {
  isOpen: boolean;
  products: UserProduct[];
  form: ProductFormState;
  editingProductId: string | null;
  onClose: () => void;
  onEdit: (product: UserProduct) => void;
  onDelete: (productId: string) => void;
  onFieldChange: ProductFormChange;
  onSave: (event: FormEvent) => void;
  onCancelEdit: () => void;
};

export function BeautyKitDrawer({
  isOpen,
  products,
  form,
  editingProductId,
  onClose,
  onEdit,
  onDelete,
  onFieldChange,
  onSave,
  onCancelEdit
}: BeautyKitDrawerProps) {
  return (
    <>
      <div
        className={`drawer-backdrop ${isOpen ? "show" : ""}`}
        aria-hidden="true"
        onClick={onClose}
      />
      <aside className={`library-drawer ${isOpen ? "open" : ""}`} aria-label="我的妆匣">
        <div className="drawer-header">
          <div>
            <p>MY BEAUTY KIT</p>
            <h2>我的妆匣</h2>
            <span>一期只做手动录入，下一轮聊天会优先核对这些化妆品。</span>
          </div>
          <button className="icon-button" type="button" title="关闭妆匣" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="drawer-body">
          <ProductList products={products} onEdit={onEdit} onDelete={onDelete} />
          <ProductForm
            form={form}
            editingProductId={editingProductId}
            onFieldChange={onFieldChange}
            onSave={onSave}
            onCancelEdit={onCancelEdit}
          />
        </div>
      </aside>
    </>
  );
}

function ProductList({
  products,
  onEdit,
  onDelete
}: {
  products: UserProduct[];
  onEdit: (product: UserProduct) => void;
  onDelete: (productId: string) => void;
}) {
  return (
    <section className="drawer-section">
      <div className="section-heading">
        <ShoppingBag size={17} />
        <h3>已有产品</h3>
      </div>
      <div className="product-list">
        {products.length > 0 ? products.map((product) => (
          <article className="product-card" key={product.id}>
            <button type="button" onClick={() => onEdit(product)}>
              <strong>{product.brand} {product.name}</strong>
              <span>{product.category} · {product.shade ?? product.colorFamily ?? "未填色号"}</span>
            </button>
            <button className="icon-button" type="button" title="删除产品" onClick={() => onDelete(product.id)}>
              <Trash2 size={16} />
            </button>
          </article>
        )) : (
          <div className="empty-library">
            <ShoppingBag size={20} />
            <p>先不录也可以问；录入后，我会先看你的妆匣再推荐新的 SKU。</p>
          </div>
        )}
      </div>
    </section>
  );
}

function ProductForm({
  form,
  editingProductId,
  onFieldChange,
  onSave,
  onCancelEdit
}: {
  form: ProductFormState;
  editingProductId: string | null;
  onFieldChange: ProductFormChange;
  onSave: (event: FormEvent) => void;
  onCancelEdit: () => void;
}) {
  return (
    <section className="drawer-section">
      <div className="section-heading">
        <Plus size={17} />
        <h3>{editingProductId ? "编辑产品" : "新增化妆品"}</h3>
      </div>
      <form className="product-form" onSubmit={onSave}>
        <div className="form-row">
          <Field label="品牌" value={form.brand} onChange={(value) => onFieldChange("brand", value)} />
          <label>
            品类
            <select value={form.category} onChange={(event) => onFieldChange("category", event.target.value)}>
              {CATEGORY_OPTIONS.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
          </label>
        </div>
        <Field label="产品名" value={form.name} onChange={(value) => onFieldChange("name", value)} />
        <div className="form-row">
          <Field label="色号" value={form.shade} onChange={(value) => onFieldChange("shade", value)} />
          <Field label="色系" value={form.colorFamily} onChange={(value) => onFieldChange("colorFamily", value)} />
        </div>
        <div className="form-row">
          <Field label="妆效" value={form.finish} onChange={(value) => onFieldChange("finish", value)} />
          <Field label="质地" value={form.texture} onChange={(value) => onFieldChange("texture", value)} />
        </div>
        <Field
          label="标签"
          value={form.effectTags}
          placeholder="低饱和、雾面、灰棕"
          onChange={(value) => onFieldChange("effectTags", value)}
        />
        <label>
          备注
          <textarea
            value={form.notes}
            onChange={(event) => onFieldChange("notes", event.target.value)}
            rows={2}
          />
        </label>
        <div className="form-actions">
          <button className="primary-button" type="submit">
            <CheckCircle2 size={17} />
            {editingProductId ? "保存修改" : "保存"}
          </button>
          {editingProductId ? (
            <button className="secondary-button" type="button" onClick={onCancelEdit}>
              取消
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function Field({
  label,
  value,
  placeholder,
  onChange
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}
