import { hydrateTaobaoOffers } from "@/lib/adapters/taobao";
import type { SkuCandidate } from "@/lib/types/domain";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const body = await request.json();
  const candidates = Array.isArray(body.candidates) ? body.candidates as SkuCandidate[] : [];

  if (candidates.length === 0) {
    return Response.json({ error: "请提供候选 SKU。" }, { status: 400 });
  }

  const hydratedCandidates = await hydrateTaobaoOffers(candidates);
  return Response.json({ candidates: hydratedCandidates });
}
