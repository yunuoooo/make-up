import { ensurePresetSeeded } from "@/lib/kit/preset";
import { createUserProduct, listUserProducts } from "@/lib/storage/user-products";

export const runtime = "nodejs";

function userIdFrom(request: Request): string {
  return new URL(request.url).searchParams.get("userId") || "local-user";
}

export async function GET(request: Request): Promise<Response> {
  const userId = userIdFrom(request);
  // 空妆匣时先播种（幂等，播过就不再播）。放在读取路径上是有意的：新用户第一次
  // 打开页面就有东西可看，不需要额外的初始化步骤或部署钩子。
  await ensurePresetSeeded(userId);
  const products = await listUserProducts(userId);
  return Response.json({ products });
}

export async function POST(request: Request): Promise<Response> {
  const input = await request.json();

  // 必填收敛为「品类 + 品牌」：色号对工具类产品本来就不适用。
  // 产品名与特点都不阻断保存——特点由判断调用回来后再填（规格第 6.3 节）。
  if (!input.brand?.trim() || !input.category?.trim()) {
    return Response.json({ error: "品牌和品类是必填项。" }, { status: 400 });
  }

  const product = await createUserProduct(input.userId || "local-user", input);
  return Response.json({ product }, { status: 201 });
}
