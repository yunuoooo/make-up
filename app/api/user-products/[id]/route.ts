import { deleteUserProduct, updateUserProduct } from "@/lib/storage/user-products";

export const runtime = "nodejs";

function userIdFrom(request: Request): string {
  return new URL(request.url).searchParams.get("userId") || "local-user";
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await context.params;
  const input = await request.json();
  const product = await updateUserProduct(input.userId || userIdFrom(request), id, input);

  if (!product) {
    return Response.json({ error: "没有找到这个妆匣产品。" }, { status: 404 });
  }

  return Response.json({ product });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await context.params;
  const deleted = await deleteUserProduct(userIdFrom(request), id);

  if (!deleted) {
    return Response.json({ error: "没有找到这个妆匣产品。" }, { status: 404 });
  }

  return Response.json({ ok: true });
}
