import type { TaobaoCallInfo } from "../commerce/taobao.ts";
import type { Observation, TurnTrace } from "./types.ts";

/**
 * 淘宝卡片阶段的观测：`taobao.cards`（整批）→ `taobao.card`（单件）→ `taobao.search` / `taobao.detail`。
 *
 * 单件观测挂在批次之下，`taobao.card` 的 metadata 记 cacheHit 与 detailLevel——
 * 「详情没取到但卡片还是出了」这条隐性失败由此变成一条可统计的记录。
 * 单次上游调用按 `TaobaoCallInfo.tag` 挂回**发起它的那张卡片**之下：并发是 2，
 * 只有发起方自己认得出归属，所以 tag 由 `buildProductCards` 贴、这里只做查表。
 *
 * 从 route 里拆出来是为了能直接测：tag → 归属这一段一旦错位，观测就静默挂到错误的父节点上。
 */

export type CardRun = {
  ok: boolean;
  cacheHit: boolean;
  detailLevel?: string;
  reason?: string;
};

export type CardsObserver = {
  batchStart(): void;
  onCall(info: TaobaoCallInfo): void;
  onCardStart(key: string, label: string): void;
  onCardFinish(key: string, run: CardRun): void;
  batchEnd(status: string, cardCount: number, failed: Array<{ brand: string; name: string; reason: string }>): void;
};

export function createCardsObserver(trace: TurnTrace | null, expected: number): CardsObserver {
  let batch: Observation | null = null;
  let batchStartedAt = 0;
  // 并发是 2，两张卡片同时在跑：用 key 记住各自的 observation，不能只留一个「当前」。
  const open = new Map<string, Observation>();

  return {
    batchStart(): void {
      if (!trace) return;
      batchStartedAt = Date.now();
      batch = trace.startObservation("taobao.cards", {
        input: { expected },
        metadata: { expected }
      }, "chain");
    },
    onCall(info: TaobaoCallInfo): void {
      if (!batch) return;
      // 按 tag 挂到发起这次调用的那张卡片之下（5.1 的树）；认不出归属才落到整批之下，
      // 不丢观测，也不编一个错的父节点。
      const owner = info.tag ? open.get(info.tag) : undefined;
      // onCall 是**调用结束后**才回调的，直接开一个再立刻 end 会让 waterfall 里这根永远是 0ms。
      // 用适配器实测的 durationMs 把起点回填，宽度就对得上真实耗时（6.3 要的就是这个）。
      (owner ?? batch).startObservation(`taobao.${info.endpoint}`, {
        startTime: new Date(Date.now() - info.durationMs),
        input: info.endpoint === "search" ? { keyword: info.keyword } : { itemId: info.itemId },
        output: { ok: info.ok, code: info.code, requestId: info.requestId },
        level: info.ok ? "DEFAULT" : "ERROR",
        metadata: { durationMs: info.durationMs }
      }, "tool").end();
    },
    onCardStart(key: string, label: string): void {
      if (!batch) return;
      open.set(key, batch.startObservation(`taobao.card ${label}`, { metadata: { key } }, "span"));
    },
    onCardFinish(key: string, run: CardRun): void {
      const observation = open.get(key);
      if (!observation) return;
      open.delete(key);
      observation.update({
        output: { ok: run.ok, cacheHit: run.cacheHit, detailLevel: run.detailLevel, reason: run.reason },
        level: run.ok ? "DEFAULT" : "ERROR",
        statusMessage: run.reason,
        // 回退率从这里统计：detailLevel = "search" 就是「详情没取到但卡片还是出了」。
        metadata: { cacheHit: run.cacheHit, detailLevel: run.detailLevel }
      });
      observation.end();
    },
    batchEnd(status: string, cardCount: number, failed: Array<{ brand: string; name: string; reason: string }>): void {
      if (!batch) return;
      batch.update({
        output: { status, cardCount, failed },
        metadata: { durationMs: Date.now() - batchStartedAt, cardCount, failedCount: failed.length }
      });
      batch.end();
      batch = null;
    }
  };
}
