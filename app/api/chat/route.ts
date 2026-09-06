export const runtime = "nodejs";

function resolveAgentServiceUrl(): string {
  const baseUrl = (process.env.AGENT_SERVICE_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  return `${baseUrl}/api/chat`;
}

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

  try {
    const userId = process.env.LOOKTRACE_USER_ID ?? "local-user";
    const upstream = await fetch(resolveAgentServiceUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", "x-user-id": userId },
      body: JSON.stringify(body),
      signal: request.signal
    });

    if (!upstream.ok) {
      const contentType = upstream.headers.get("content-type") ?? "application/json";
      return new Response(await upstream.text(), { status: upstream.status, headers: { "Content-Type": contentType } });
    }
    if (!upstream.body) return Response.json({ error: "Agent 服务没有返回流式结果。" }, { status: 502 });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no"
      }
    });
  } catch {
    return Response.json({ error: "Agent 服务暂时不可用，请先启动 Python runtime。" }, { status: 503 });
  }
}
