import cases from "@/data/evals/cases.json";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json({ cases });
}
