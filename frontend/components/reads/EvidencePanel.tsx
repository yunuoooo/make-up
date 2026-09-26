"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { ReadEntryCard } from "./ReadEntryCard";
import { asRecord, asText } from "@/frontend/lib/reads";
import type { XhsReadEntry } from "@/lib/pi/session-reads";

/**
 * 对话右侧的**证据面板**：这一轮 agent 从小红书读到的原始内容。
 *
 * 为什么跟着对话走而不是单开一页：核对答案时问的永远是「**这条**结论是从哪读来的」，
 * 所以默认就是当前对话、跟着它的每一轮自动刷新。收起时只留一条窄边和一个条数角标，
 * 展开时对话照样在旁边（版面挤一点，但不遮住）——要一边看答案一边对来源。
 *
 * 数据来自 `/api/xhs-reads`（读 pi 的会话文件，见 `lib/pi/session-reads.ts`）。
 */

type State = { status: "loading" } | { status: "ready" } | { status: "error"; message: string };

export function EvidencePanel({
  conversationId,
  isSending,
  open,
  onToggle
}: {
  conversationId: string | null;
  isSending: boolean;
  /** 展开状态由调用方持有：手机上展开入口在标题栏（贴着底部的悬浮按钮会压住输入框）。 */
  open: boolean;
  onToggle: () => void;
}) {
  const [entries, setEntries] = useState<XhsReadEntry[]>([]);
  const [state, setState] = useState<State>({ status: "ready" });
  const previousSending = useRef(isSending);

  const load = useCallback(async () => {
    if (!conversationId) {
      setEntries([]);
      setState({ status: "ready" });
      return;
    }
    setState({ status: "loading" });
    try {
      const response = await fetch(`/api/xhs-reads?conversationId=${encodeURIComponent(conversationId)}`);
      // 404 = 这份会话里还没有取数记录（新对话的第一轮还没跑完就是这种）。
      if (response.status === 404) {
        setEntries([]);
        setState({ status: "ready" });
        return;
      }
      const body = await response.json();
      if (!response.ok) throw new Error(asText(body?.error) || `HTTP ${response.status}`);
      const rows = asRecord(body?.session)?.entries;
      const list = Array.isArray(rows) ? (rows as XhsReadEntry[]) : [];
      // 最新一次调用排最上面：核对的是刚拿到的那个答案。
      setEntries([...list].reverse());
      setState({ status: "ready" });
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : "读取失败" });
    }
  }, [conversationId]);

  // 换对话就重新拉。
  useEffect(() => {
    void load();
  }, [load]);

  // 一轮跑完自动刷新——否则展开看到的还是上一轮的证据，而取数恰恰发生在这一轮里。
  useEffect(() => {
    if (previousSending.current && !isSending) void load();
    previousSending.current = isSending;
  }, [isSending, load]);

  const count = entries.length;
  const badge = count > 0 ? String(count) : "";

  if (!open) {
    // 收起的样子只在桌面端存在：一条贴着右边的窄边，点箭头展开。
    // 手机上没有它的位置（窄边太细、悬浮按钮又会压住输入框），入口在标题栏。
    return (
      <button
        type="button"
        onClick={onToggle}
        title="展开取数证据"
        className="hidden w-11 shrink-0 flex-col items-center gap-3 border-l border-border bg-[#fbfaf8] py-4 text-muted-foreground transition hover:bg-[#f4f1ee] hover:text-foreground lg:flex"
      >
        <ChevronLeft className="size-4" />
        <span className="text-[11px] tracking-[.2em] [writing-mode:vertical-rl]">取数证据</span>
        {badge ? (
          <span className="rounded-full bg-[#fae8ee] px-1.5 py-0.5 text-[10px] text-[#a23d5d]">{badge}</span>
        ) : null}
      </button>
    );
  }

  return (
    <>
      {/* 手机上盖住对话（否则没地方放），桌面端不遮——要一边看答案一边对来源。 */}
      <div className="fixed inset-0 z-30 bg-black/20 lg:hidden" onClick={onToggle} aria-hidden />
      <aside className="fixed inset-y-0 right-0 z-40 flex w-[min(26rem,100vw)] flex-col border-l border-border bg-[#fbfaf8] lg:static lg:z-auto lg:w-[26rem] lg:shrink-0">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
          <button
            type="button"
            onClick={onToggle}
            title="收起"
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-[#f1ece9] hover:text-foreground"
          >
            <ChevronRight className="size-4" />
          </button>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-foreground">取数证据</p>
            <p className="truncate text-[11px] text-muted-foreground">
              agent 从小红书读到的原始内容·含视频口播字幕
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            title="重新读取"
            className="ml-auto rounded-lg p-1.5 text-muted-foreground hover:bg-[#f1ece9] hover:text-foreground"
          >
            <RefreshCw className="size-3.5" />
          </button>
        </header>

        <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {state.status === "loading" ? (
            <p className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              读取中
            </p>
          ) : state.status === "error" ? (
            <p className="px-1 py-3 text-xs text-[#8a4f22]">{state.message}</p>
          ) : !conversationId ? (
            <p className="rounded-xl border border-border bg-card px-3 py-4 text-xs leading-6 text-muted-foreground">
              先问一轮妆容研究。它读过的每一条笔记都会出现在这里——包括视频的口播字幕。
            </p>
          ) : count === 0 ? (
            <p className="rounded-xl border border-border bg-card px-3 py-4 text-xs leading-6 text-muted-foreground">
              {isSending ? "这一轮还在跑…" : "这一轮没有从小红书取数。"}
              {isSending ? null : <><br />可能是还没搜、或者数据源没配好。</>}
            </p>
          ) : (
            <>
              {isSending ? (
                <p className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  这一轮还在取数，跑完会自动刷新
                </p>
              ) : null}
              {entries.map((entry) => (
                <ReadEntryCard key={entry.toolCallId || `${entry.at}-${entry.kind}`} entry={entry} />
              ))}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
