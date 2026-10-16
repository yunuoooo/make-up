import { importMaxChars, JudgeError, parsePurchaseText } from "@/lib/kit/judge";

export const runtime = "nodejs";
/** 单次模型调用，给足时间；上游超时另有 KIT_IMPORT_TIMEOUT_SECONDS 管。 */
export const maxDuration = 120;

/**
 * 粘贴的淘宝购买记录 → 候选项。
 *
 * **这个接口不写库。** 预览阶段零写入，用户逐条确认后才走 `import/commit`
 * （规格 `docs/specs/10-16-makeup-kit.md` 第 6.4 节）。
 *
 * 输入是**不受信任内容**：它只被当成要解析的数据，原文不回显进任何对话上下文，
 * 只交给预览界面给用户自己核对。
 */
export async function POST(request: Request): Promise<Response> {
  let text = "";
  try {
    const body = await request.json();
    text = typeof body?.text === "string" ? body.text : "";
  } catch {
    return Response.json({ error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  if (!text.trim()) {
    return Response.json({ error: "没有可解析的内容。" }, { status: 400 });
  }

  try {
    const result = await parsePurchaseText(text);
    return Response.json({
      ...result,
      // 让界面能如实告诉用户「有 N 条没认出来」。
      skippedCount: result.skipped.length,
      maxChars: importMaxChars()
    });
  } catch (error) {
    if (error instanceof JudgeError) {
      const status = error.reason === "bad-output" ? 422 : 502;
      return Response.json({ error: error.message, reason: error.reason }, { status });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "解析失败。", reason: "failed" },
      { status: 502 }
    );
  }
}
