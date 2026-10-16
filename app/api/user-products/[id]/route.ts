import { deleteUserProduct, getUserProduct, updateUserProduct } from "@/lib/storage/user-products";
import type { AttributeSourceRecord } from "@/lib/types/domain";

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
  const userId = input.userId || userIdFrom(request);

  const current = await getUserProduct(userId, id);
  if (!current) {
    return Response.json({ error: "没有找到这个妆匣产品。" }, { status: 404 });
  }

  // 用户改了某个属性就说明这条特点是他自己的声明了，来源转 `user`——与「模型推断」
  // 必须分得开，否则模型会把猜的当查到的讲（规格第 6.6 节）。
  // 显式传了 attributeSources 的调用方（判断接口）以它为准。
  const attributes = input.attributes as Record<string, string> | undefined;
  if (attributes && !input.attributeSources) {
    const sources: Record<string, AttributeSourceRecord> = { ...(current.attributeSources ?? {}) };
    for (const [key, value] of Object.entries(attributes)) {
      if (typeof value === "string" && value.trim()) {
        sources[key] = { source: "user", at: new Date().toISOString() };
      }
    }
    input.attributeSources = sources;
  }

  const product = await updateUserProduct(userId, id, input);

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
