export const runtime = "nodejs";

import { randomUUID } from "node:crypto";
import { formatSseEvent, resolvePiStateDir, runPiAgent } from "@/lib/pi/bridge";
import { redactSensitive, type AppSseEvent } from "@/lib/pi/events";
import { buildProductCards } from "@/lib/commerce/cards";
import { extractProductBlock, productKey } from "@/lib/commerce/product-block";
import { createTaobaoClient } from "@/lib/commerce/taobao";
import { loadProductCardsCache } from "@/lib/storage/taobao-cache";
import { flushObservability, startTurnTrace } from "@/lib/observability/langfuse";
import { createCardsObserver } from "@/lib/observability/cards";
import { isValidSessionId, pruneSessionsThrottled } from "@/lib/pi/session";
import { releaseConversation, tryAcquireConversation } from "@/lib/pi/conversation-lock";
import type { TurnTrace } from "@/lib/observability/types";

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
async function attachProductCards(
  resultEvent: AppSseEvent,
  send: Sink,
  signal: AbortSignal,
  trace: TurnTrace | null
): Promise<{ status: string; cardCount: number } | null> {
  const answerText = typeof resultEvent.data.answerText === "string" ? resultEvent.data.answerText : "";
  const limit = Math.floor(positiveNumber("TAOBAO_CARD_LIMIT", DEFAULT_CARD_LIMIT));
  const { items, text } = extractProductBlock(answerText, { limit });

  send({ ...resultEvent, data: { ...resultEvent.data, answerText: text } });

  if (!items.length || signal.aborted) return null;

  const observer = createCardsObserver(trace, items.length);
  const client = createTaobaoClient({ onCall: (info) => observer.onCall(info) });
  // 总开关（TAOBAO_CARDS_ENABLED，默认关）没开、或没配 token 时都不发任何请求，
  // 连 pending 都不发：不显示假价格、假链接，也不留空骨架。
  if (!client.configured) return null;

  send({
    event: "product_cards",
    data: { phase: "pending", expected: items.length, categories: items.map((item) => item.category) }
  });
  observer.batchStart();

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
    onCard: (card) => send({ event: "product_cards", data: { phase: "items", items: [card] } }),
    onCardStart: (ref) => observer.onCardStart(productKey(ref), `${ref.brand}|${ref.name}`),
    onCardFinish: (run) => observer.onCardFinish(productKey(run.ref), {
      ok: run.ok,
      cacheHit: run.cacheHit,
      ...(run.detailLevel ? { detailLevel: run.detailLevel } : {}),
      ...(run.reason ? { reason: run.reason } : {})
    })
  });
  observer.batchEnd(outcome.status, outcome.cards.length, outcome.failed);

  try {
    await cache?.save();
  } catch {
    // 同上：缓存写不进去不影响已经拿到的卡片。
  }

  if (signal.aborted) return { status: outcome.status, cardCount: outcome.cards.length };
  send({ event: "product_cards", data: { phase: "done", status: outcome.status, failed: outcome.failed } });
  return { status: outcome.status, cardCount: outcome.cards.length };
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
  // 会话 id 来自客户端，并且会成为服务端会话文件名的一部分：不合法就挡在这里，
  // 不能像以前那样"没有就算了"——那会让每一轮都退化成互不相干的单轮。
  const conversationId = typeof (body as { conversationId?: unknown }).conversationId === "string"
    ? (body as { conversationId: string }).conversationId.trim()
    : "";
  if (!isValidSessionId(conversationId)) {
    return Response.json({ error: "会话标识无效，请重新开始一个对话。" }, { status: 400 });
  }
  // 同一会话并发跑两个 pi 进程会互相覆盖会话文件，见 lib/pi/conversation-lock.ts。
  if (!tryAcquireConversation(conversationId)) {
    return Response.json({ error: "这个对话还在生成上一条回复，请稍候再问。" }, { status: 409 });
  }

  // traceId 由这里生成再交给 bridge：观测层才能在 spawn 之前建好根 trace，
  // 而 SSE 发给前端的仍是同一个 id。
  const traceId = `trace_${randomUUID()}`;
  // 会话 id 来自客户端，进 trace 之前照例过一遍脱敏。
  let trace: TurnTrace | null = null;
  try {
    trace = await startTurnTrace({
      traceId,
      userMessage,
      conversationId: String(redactSensitive(conversationId))
    });
  } catch {
    // 观测建不起来不该让这一轮卡死，但必须先放锁，否则这个对话会一直 409。
    releaseConversation(conversationId);
    return Response.json({ error: "观测初始化失败，请重试。" }, { status: 500 });
  }
  // 顺手清理旧会话（十分钟最多一次），失败不影响本轮对话。
  void pruneSessionsThrottled(process.cwd(), resolvePiStateDir());

  const requestAbort = new AbortController();
  const forwardAbort = () => requestAbort.abort();
  request.signal.addEventListener("abort", forwardAbort, { once: true });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let answer = "";
      let cards: { status: string; cardCount: number } | null = null;
      const send: Sink = (event) => {
        if (!closed) controller.enqueue(encoder.encode(formatSseEvent(event)));
      };

      try {
        // result 先压住不转发：正文里的机器可读块要剥掉，卡片要追加在它后面。
        const holder: { result: AppSseEvent | null } = { result: null };
        const bridge = await runPiAgent({
          prompt: userMessage,
          conversationId,
          traceId,
          trace,
          signal: requestAbort.signal
        }, (event) => {
          if (event.event === "result") {
            holder.result = event;
            return;
          }
          send(event);
        });
        answer = bridge.answerText;

        if (holder.result) {
          cards = await attachProductCards(holder.result, send, requestAbort.signal, trace);
          answer = typeof holder.result.data.answerText === "string" ? holder.result.data.answerText : answer;
        }
      } catch (error) {
        send({
          event: "error",
          data: { message: error instanceof Error ? error.message : "Pi runtime 失败。" }
        });
      } finally {
        // 观测的收尾只发生在这里：一轮真正的结束点是卡片也补完之后。
        try {
          trace?.update({ output: { answer, cards } });
          trace?.end();
        } catch {
          // 观测失败不能影响已经发出去的答案。
        }
        await flushObservability();
        closed = true;
        request.signal.removeEventListener("abort", forwardAbort);
        // 这一轮的终点：放开会话锁，下一个追问才能进来。
        releaseConversation(conversationId);
        try {
          controller.close();
        } catch {
          // 客户端已经断开时流可能已被取消，这里关不掉不算错误。
        }
      }
    },
    cancel() {
      requestAbort.abort();
      // 客户端断开也要放锁：start() 的 finally 不一定还会被调度到。
      releaseConversation(conversationId);
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
