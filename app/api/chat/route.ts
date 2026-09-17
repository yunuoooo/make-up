export const runtime = "nodejs";

import { formatSseEvent, runPiAgent } from "@/lib/pi/bridge";

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求体不是有效 JSON。" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || typeof (body as { message?: unknown }).message !== "string" || !(body as { message: string }).message.trim()) {
    return Response.json({ error: "请输入有效的消息。" }, { status: 400 });
  }

  const userMessage = (body as { message: string }).message.trim();
  const requestAbort = new AbortController();
  const forwardAbort = () => requestAbort.abort();
  request.signal.addEventListener("abort", forwardAbort, { once: true });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      try {
        await runPiAgent({
          prompt: userMessage,
          conversationId: typeof (body as { conversationId?: unknown }).conversationId === "string"
            ? (body as { conversationId: string }).conversationId
            : undefined,
          signal: requestAbort.signal
        }, (event) => {
          if (!closed) controller.enqueue(encoder.encode(formatSseEvent(event)));
        });
      } catch (error) {
        if (!closed) {
          controller.enqueue(encoder.encode(formatSseEvent({
            event: "error",
            data: { message: error instanceof Error ? error.message : "Pi runtime 失败。" }
          })));
        }
      } finally {
        closed = true;
        request.signal.removeEventListener("abort", forwardAbort);
        controller.close();
      }
    },
    cancel() {
      requestAbort.abort();
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no"
    }
  });
}
