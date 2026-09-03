import { searchXhsEvidence } from "@/lib/adapters/xhs";
import { makeId } from "@/lib/storage/json-store";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const body = await request.json();

  if (!body.query?.trim()) {
    return Response.json({ error: "请输入小红书搜索词或妆容目标。" }, { status: 400 });
  }

  const result = await searchXhsEvidence(body.query.trim(), body.conversationId || makeId("conv"));
  return Response.json(result);
}
