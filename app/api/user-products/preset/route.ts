import { deleteProductsBySource } from "@/lib/storage/user-products";

export const runtime = "nodejs";

function userIdFrom(request: Request): string {
  return new URL(request.url).searchParams.get("userId") || "local-user";
}

/**
 * 一键清空示例妆匣。
 *
 * 只删 `recordSource === "preset"` 的条目——用户自己录的和导入的一条都不能动
 * （存量记录没有 `recordSource`，按 `"manual"` 处理，同样不会被删）。
 *
 * 删完不需要额外记账：播种标记在第一次播种时就落下了，所以清空之后**不会**再播
 * （规格第 5.1 节）。
 */
export async function DELETE(request: Request): Promise<Response> {
  const removed = await deleteProductsBySource(userIdFrom(request), "preset");
  return Response.json({ ok: true, removed });
}
