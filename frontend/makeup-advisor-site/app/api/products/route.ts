import { desc } from "drizzle-orm";
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

export async function GET() {
  try {
    const rows = await getDb()
      .select()
      .from(products)
      .orderBy(desc(products.updatedAt), desc(products.id));
    return Response.json({ products: rows });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "读取化妆品库失败。" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as ProductPayload;
    const brand = clean(payload.brand);
    const name = clean(payload.name);
    const category = clean(payload.category);
    const shade = clean(payload.shade);

    if (!brand || !name || !category || !shade) {
      return Response.json(
        { error: "品牌、完整产品名、品类和版本/色号都需要填写。" },
        { status: 400 },
      );
    }

    const [product] = await getDb()
      .insert(products)
      .values({
        brand,
        name,
        category,
        shade,
        finish: clean(payload.finish),
        tags: clean(payload.tags),
        notes: clean(payload.notes),
      })
      .returning();
    return Response.json({ product }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "新增化妆品失败。" },
      { status: 500 },
    );
  }
}
