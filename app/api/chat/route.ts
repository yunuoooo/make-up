export const runtime = "nodejs";

import { formatSseEvent, runPiAgent } from "@/lib/pi/bridge";
import type { AppSseEvent } from "@/lib/pi/events";
import { buildProductCards } from "@/lib/commerce/cards";
import { extractProductBlock } from "@/lib/commerce/product-block";
import { createTaobaoClient } from "@/lib/commerce/taobao";
import { loadProductCardsCache } from "@/lib/storage/taobao-cache";

const DEFAULT_CARD_LIMIT = 8;
const DEFAULT_BUDGET_SECONDS = 60;

function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

type Sink = (event: AppSseEvent) => void;

/**
 * 答案落地之后补全淘宝商品卡片。
 *
 * 顺序是有意的：先发 result（正文已剥掉机器可读块），答案立刻可用；
 * 再发 pending/items/done 让卡片渐进出现。淘宝是采集类接口，一轮可能要几十秒，
 * 不能让用户盯着空白等它。
 */
async function attachProductCards(resultEvent: AppSseEvent, send: Sink, signal: AbortSignal): Promise<void> {
  const answerText = typeof resultEvent.data.answerText === "string" ? resultEvent.data.answerText : "";
  const limit = Math.floor(positiveNumber("TAOBAO_CARD_LIMIT", DEFAULT_CARD_LIMIT));
  const { items, text } = extractProductBlock(answerText, { limit });

  send({ ...resultEvent, data: { ...resultEvent.data, answerText: text } });

  if (!items.length || signal.aborted) return;

  const client = createTaobaoClient();
  // 未配置 token 时不发任何请求，连 pending 都不发：不显示假价格、假链接，也不留空骨架。
  if (!client.configured) return;

  send({
    event: "product_cards",
    data: { phase: "pending", expected: items.length, categories: items.map((item) => item.category) }
  });

  let cache = null;
  try {
    cache = await loadProductCardsCache();
  } catch {
    cache = null; // 缓存只是省配额，读写失败不该影响这一轮。
  }

  const outcome = await buildProductCards(items, {
    client,
    limit,
    budgetMs: positiveNumber("TAOBAO_CARDS_BUDGET_SECONDS", DEFAULT_BUDGET_SECONDS) * 1000,
    signal,
    ...(cache ? { cache } : {}),
    onCard: (card) => send({ event: "product_cards", data: { phase: "items", items: [card] } })
  });

  try {
    await cache?.save();
  } catch {
    // 同上：缓存写不进去不影响已经拿到的卡片。
  }

  if (signal.aborted) return;
  send({ event: "product_cards", data: { phase: "done", status: outcome.status, failed: outcome.failed } });
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

  const userMessage = (body as { message: string }).message.trim();
  const requestAbort = new AbortController();
  const forwardAbort = () => requestAbort.abort();
  request.signal.addEventListener("abort", forwardAbort, { once: true });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send: Sink = (event) => {
        if (!closed) controller.enqueue(encoder.encode(formatSseEvent(event)));
      };

      try {
        // result 先压住不转发：正文里的机器可读块要剥掉，卡片要追加在它后面。
        const holder: { result: AppSseEvent | null } = { result: null };
        await runPiAgent({
          prompt: userMessage,
          conversationId: typeof (body as { conversationId?: unknown }).conversationId === "string"
            ? (body as { conversationId: string }).conversationId
            : undefined,
          signal: requestAbort.signal
        }, (event) => {
          if (event.event === "result") {
            holder.result = event;
            return;
          }
          send(event);
        });

        if (holder.result) await attachProductCards(holder.result, send, requestAbort.signal);
      } catch (error) {
        send({
          event: "error",
          data: { message: error instanceof Error ? error.message : "Pi runtime 失败。" }
        });
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
