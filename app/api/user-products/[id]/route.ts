import { sourcesAfterEdit } from "@/lib/kit/attributes";
import { deleteUserProduct, getUserProduct, mergeAttributes, updateUserProduct } from "@/lib/storage/user-products";

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

  // 只有**真的被改过**的属性才转 `user`。表单保存会把所有字段一起提交（用户看到的是
  // 填好的旧值），照单全收地标成「用户确认」会让一处小改抹掉整条记录的来源区别
  // （规格第 6.6 节）。显式传了 attributeSources 的调用方（判断接口）以它为准。
  const attributes = input.attributes as Record<string, string> | undefined;
  if (attributes && !input.attributeSources) {
    input.attributeSources = sourcesAfterEdit(mergeAttributes(current), attributes, current.attributeSources ?? {});
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
