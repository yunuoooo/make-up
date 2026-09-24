"use client";

import type { FormEvent } from "react";
import type { UserProduct } from "@/lib/types/domain";
import { CATEGORY_OPTIONS } from "@/frontend/lib/constants";
import type { ProductFormState } from "@/frontend/lib/types";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/frontend/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/frontend/components/ui/select";

type ProductDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingProduct: UserProduct | null;
  form: ProductFormState;
  onFieldChange: (field: keyof ProductFormState, value: string) => void;
  onSubmit: (event: FormEvent) => void;
  productToDelete: UserProduct | null;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
};

const FIELD_LABEL = "grid gap-1.5 text-sm font-medium text-[#4d4742]";

export function ProductDialog({
  open,
  onOpenChange,
  editingProduct,
  form,
  onFieldChange,
  onSubmit,
  productToDelete,
  onCancelDelete,
  onConfirmDelete
}: ProductDialogProps) {
  // 历史数据可能带着不在预设列表里的品类，编辑时不能让它消失。
  const categories = CATEGORY_OPTIONS.includes(form.category)
    ? CATEGORY_OPTIONS
    : [form.category, ...CATEGORY_OPTIONS];

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto rounded-[22px] border-black/[.08] bg-[#fbfaf8] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl tracking-[-.02em] text-[#2d2926]">
              {editingProduct ? "编辑这件化妆品" : "添加到我的化妆品库"}
            </DialogTitle>
            <DialogDescription className="leading-6">
              品牌、完整产品名和版本/色号会直接用于推荐里的 ✅ 结论。
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={onSubmit} className="mt-2 grid gap-4 sm:grid-cols-2">
            <label className={FIELD_LABEL}>
              品牌
              <Input
                required
                value={form.brand}
                onChange={(event) => onFieldChange("brand", event.target.value)}
                placeholder="例如：rom&nd"
                className="h-11 rounded-xl bg-white"
              />
            </label>

            <label className={FIELD_LABEL}>
              品类
              <Select value={form.category} onValueChange={(category) => onFieldChange("category", category)}>
                <SelectTrigger className="h-11 w-full rounded-xl bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((category) => (
                    <SelectItem key={category} value={category}>
                      {category}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <label className={`${FIELD_LABEL} sm:col-span-2`}>
              完整产品名
              <Input
                required
                value={form.name}
                onChange={(event) => onFieldChange("name", event.target.value)}
                placeholder="例如：Better Than Cheek"
                className="h-11 rounded-xl bg-white"
              />
            </label>

            <label className={FIELD_LABEL}>
              版本 / 色号
              <Input
                value={form.shade}
                onChange={(event) => onFieldChange("shade", event.target.value)}
                placeholder="例如：#N02 Vine Nude"
                className="h-11 rounded-xl bg-white"
              />
            </label>

            <label className={FIELD_LABEL}>
              色系
              <Input
                value={form.colorFamily}
                onChange={(event) => onFieldChange("colorFamily", event.target.value)}
                placeholder="例如：冷粉、低饱和"
                className="h-11 rounded-xl bg-white"
              />
            </label>

            <label className={FIELD_LABEL}>
              妆效
              <Input
                value={form.finish}
                onChange={(event) => onFieldChange("finish", event.target.value)}
                placeholder="例如：柔雾、自然光泽"
                className="h-11 rounded-xl bg-white"
              />
            </label>

            <label className={FIELD_LABEL}>
              质地
              <Input
                value={form.texture}
                onChange={(event) => onFieldChange("texture", event.target.value)}
                placeholder="例如：膏状、低显色"
                className="h-11 rounded-xl bg-white"
              />
            </label>

            <label className={`${FIELD_LABEL} sm:col-span-2`}>
              标签
              <Input
                value={form.effectTags}
                onChange={(event) => onFieldChange("effectTags", event.target.value)}
                placeholder="用顿号分隔，例如：冷粉、低饱和、自然气色"
                className="h-11 rounded-xl bg-white"
              />
            </label>

            <label className={`${FIELD_LABEL} sm:col-span-2`}>
              备注
              <Textarea
                value={form.notes}
                onChange={(event) => onFieldChange("notes", event.target.value)}
                placeholder="可以记录适合的场景、上脸感受或避雷点"
                className="min-h-24 rounded-xl bg-white"
              />
            </label>

            <DialogFooter className="mt-2 sm:col-span-2">
              <Button type="button" variant="outline" className="rounded-xl" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button type="submit" className="rounded-xl bg-[#242421] text-white hover:bg-[#393834]">
                {editingProduct ? "保存修改" : "加入化妆品库"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(productToDelete)} onOpenChange={(next) => !next && onCancelDelete()}>
        <AlertDialogContent className="rounded-[20px] bg-[#fbfaf8]">
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除这件化妆品？</AlertDialogTitle>
            <AlertDialogDescription>
              {productToDelete
                ? `${productToDelete.brand}｜${productToDelete.name}${productToDelete.shade ? `｜${productToDelete.shade}` : ""} 将不再参与之后的 ✅ 匹配。`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl">取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" className="rounded-xl" onClick={onConfirmDelete}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
