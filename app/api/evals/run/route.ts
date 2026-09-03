import cases from "@/data/evals/cases.json";
import { runLooktraceAgent } from "@/lib/agent/pipeline";
import { createUserProduct, type ProductInput } from "@/lib/storage/user-products";

export const runtime = "nodejs";

type EvalCase = {
  id: string;
  name: string;
  input: string;
  seedProducts?: ProductInput[];
  mustContain: string[];
};

export async function POST(): Promise<Response> {
  const results = [];

  for (const item of cases as EvalCase[]) {
    const userId = `eval-${item.id}-${Date.now()}`;
    for (const product of item.seedProducts ?? []) {
      await createUserProduct(userId, product);
    }

    const answer = await runLooktraceAgent({
      message: item.input,
      userId,
      conversationId: `eval-${item.id}`
    });
    const missing = item.mustContain.filter((needle) => !answer.answerText.includes(needle));
    results.push({
      id: item.id,
      name: item.name,
      passed: missing.length === 0,
      missing,
      candidateCount: answer.skuCandidates.length,
      sourceCount: answer.sources.length
    });
  }

  return Response.json({
    passed: results.every((item) => item.passed),
    results
  });
}
