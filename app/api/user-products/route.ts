import { createUserProduct, listUserProducts } from "@/lib/storage/user-products";

export const runtime = "nodejs";

function userIdFrom(request: Request): string {
  return new URL(request.url).searchParams.get("userId") || "local-user";
}

export async function GET(request: Request): Promise<Response> {
  const products = await listUserProducts(userIdFrom(request));
  return Response.json({ products });
}

export async function POST(request: Request): Promise<Response> {
  const input = await request.json();

  if (!input.brand?.trim() || !input.name?.trim() || !input.category?.trim()) {
    return Response.json({ error: "品牌、产品名和品类是必填项。" }, { status: 400 });
  }

  const product = await createUserProduct(input.userId || "local-user", input);
  return Response.json({ product }, { status: 201 });
}
