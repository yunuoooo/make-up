import { judgeAttributes, JudgeError } from "@/lib/kit/judge";
import { getUserProduct, mergeAttributes, updateUserProduct } from "@/lib/storage/user-products";
import type { AttributeSourceRecord } from "@/lib/types/domain";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * 判断（或重新判断）一件化妆品的妆效特点。
 *
 * 手动录入保存后自动调一次（不阻断保存），卡片上也能手动再调（规格第 6.3 节）。
 * 判断只填**未知**的维度，用户填过或改过的一律不动——用户的最新声明优先。
 *
 * 写回的来源是 `model-inferred`：这是模型按产品身份推断的线索，不是检索核实的结果。
 * 技能不允许把核实结果写回妆匣（决策 6），所以运行时不产生 `search-verified`。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await context.params;

  let userId = "local-user";
  try {
    const body = await request.json();
    if (typeof body?.userId === "string" && body.userId.trim()) userId = body.userId.trim();
  } catch {
    // 没带 body 就用缺省用户，与 GET 的口径一致。
  }

  const product = await getUserProduct(userId, id);
  if (!product) {
    return Response.json({ error: "没有找到这个妆匣产品。" }, { status: 404 });
  }

  const known = mergeAttributes(product);
  try {
    const judgement = await judgeAttributes({
      category: product.category,
      brand: product.brand,
      name: product.name || undefined,
      shade: product.shade,
      known
    });

    if (Object.keys(judgement.attributes).length === 0) {
      return Response.json({
        product,
        judged: 0,
        unknowns: judgement.unknowns,
        message: "没能从现有信息判断出新特点。可以补上产品名或色号再试。"
      });
    }

    // 逐属性合并来源：只给这次新填的键加 source，原有的来源不动。
    const sources: Record<string, AttributeSourceRecord> = { ...(product.attributeSources ?? {}) };
    for (const key of Object.keys(judgement.attributes)) {
      sources[key] = { source: "model-inferred", at: new Date().toISOString() };
    }

    const updated = await updateUserProduct(userId, id, {
      attributes: { ...known, ...judgement.attributes },
      attributeSources: sources
    });

    return Response.json({
      product: updated,
      judged: Object.keys(judgement.attributes).length,
      unknowns: judgement.unknowns,
      confidence: judgement.confidence
    });
  } catch (error) {
    if (error instanceof JudgeError) {
      const status = error.reason === "bad-output" ? 422 : 502;
      // 判断失败不影响记录本身：条目还在，特点留空，用户可以再点一次。
      return Response.json({ error: error.message, reason: error.reason, product }, { status });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "判断特点失败。", reason: "failed" },
      { status: 502 }
    );
  }
}
