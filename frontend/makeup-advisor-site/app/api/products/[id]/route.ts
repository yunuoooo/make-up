import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { products } from "@/db/schema";

type ProductPayload = {
  brand?: string;
  name?: string;
  category?: string;
  shade?: string;
  finish?: string;
  tags?: string;
  notes?: string;
};

function clean(value?: string) {
  return value?.trim() ?? "";
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const productId = Number(id);
    const payload = (await request.json()) as ProductPayload;
    const brand = clean(payload.brand);
    const name = clean(payload.name);
    const category = clean(payload.category);
    const shade = clean(payload.shade);

    if (!Number.isInteger(productId) || !brand || !name || !category || !shade) {
      return Response.json({ error: "产品信息不完整。" }, { status: 400 });
    }

    const [product] = await getDb()
      .update(products)
      .set({
        brand,
        name,
        category,
        shade,
        finish: clean(payload.finish),
        tags: clean(payload.tags),
        notes: clean(payload.notes),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(products.id, productId))
      .returning();

    if (!product) {
      return Response.json({ error: "没有找到这件化妆品。" }, { status: 404 });
    }
    return Response.json({ product });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "更新化妆品失败。" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const productId = Number(id);
    if (!Number.isInteger(productId)) {
      return Response.json({ error: "产品编号无效。" }, { status: 400 });
    }

    const [deleted] = await getDb()
      .delete(products)
      .where(eq(products.id, productId))
      .returning({ id: products.id });

    if (!deleted) {
      return Response.json({ error: "没有找到这件化妆品。" }, { status: 404 });
    }
    return Response.json({ deleted: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "删除化妆品失败。" },
      { status: 500 },
    );
  }
}
