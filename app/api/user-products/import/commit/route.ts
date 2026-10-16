import { buildImportInputs, type CommitItem } from "@/lib/kit/judge";
import { createUserProducts } from "@/lib/storage/user-products";

export const runtime = "nodejs";

/**
 * 用户确认后的落库。
 *
 * 逐属性来源、品类归一化和「已用完」的处理都在 `lib/kit/judge.ts` 的
 * `buildImportInputs` 里（那样才测得到），这里只做请求解析与一次批量写入。
 *
 * **一次读一次写**：导入是批量路径，不能在循环里单条写——那会把读-改-写的窗口
 * 放大 N 倍（见 `lib/storage/user-products.ts` 的注释）。
 */
export async function POST(request: Request): Promise<Response> {
  let payload: { userId?: unknown; items?: unknown };
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const userId = typeof payload.userId === "string" && payload.userId.trim() ? payload.userId.trim() : "local-user";
  const items = Array.isArray(payload.items) ? (payload.items as CommitItem[]) : [];

  const built = buildImportInputs(items);
  if (!built.ok) {
    return Response.json({ error: built.error }, { status: 400 });
  }

  const created = await createUserProducts(userId, built.inputs);
  return Response.json({ products: created, imported: created.length }, { status: 201 });
}
