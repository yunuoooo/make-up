import { runLooktraceAgent } from "@/lib/agent/pipeline";
import type { ChatRequest } from "@/lib/types/domain";

export const runtime = "nodejs";

const encoder = new TextEncoder();

function sse(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function chunkText(text: string, size = 48): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

export async function POST(request: Request): Promise<Response> {
  let body: ChatRequest;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求体不是有效 JSON。" }, { status: 400 });
  }

  if (!body.message?.trim()) {
    return Response.json({ error: "请输入一个文字妆容目标。" }, { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(sse("status", { message: "开始检索互联网参考" }));
        const answer = await runLooktraceAgent({ ...body, message: body.message.trim() });

        for (const run of answer.toolRuns) {
          controller.enqueue(sse("tool", run));
        }

        for (const chunk of chunkText(answer.answerText)) {
          controller.enqueue(sse("chunk", { text: chunk }));
          await new Promise((resolve) => setTimeout(resolve, 18));
        }

        controller.enqueue(sse("result", answer));
        controller.close();
      } catch (error) {
        controller.enqueue(sse("error", {
          message: error instanceof Error ? error.message : "生成推荐时发生未知错误。"
        }));
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no"
    }
  });
}
