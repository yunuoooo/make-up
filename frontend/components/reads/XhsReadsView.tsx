"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Database, Loader2 } from "lucide-react";
import { Toaster } from "@/frontend/components/ui/sonner";
import { ReadEntryCard } from "./ReadEntryCard";
import { asRecord, asText, timeLabel } from "@/frontend/lib/reads";
import type { XhsReadSession, XhsReadSummary } from "@/lib/pi/session-reads";

/**
 * 取数记录：agent 从小红书读到的**原始内容**。
 *
 * 排查时最常问的三个问题是「它到底读到了什么」「这次为什么没有内容」「字幕拿到了吗」，
 * 页面按这个顺序组织：左边选会话，右边按时间列出每一次调用，失败的和成功的一样占一张卡。
 *
 * 数据直接来自 pi 的会话文件（`/api/xhs-reads`），所以**历史的会话也能看**，不是只有本轮。
 */

type State = { status: "loading" } | { status: "ready" } | { status: "error"; message: string };

function SummaryRow({
  summary,
  active,
  onSelect
}: {
  summary: XhsReadSummary;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
        active ? "border-[#e5b7c6] bg-[#fdf2f5]" : "border-border bg-card hover:bg-[#f7f4f2]"
      }`}
    >
      <p className="truncate text-[13px] font-medium text-foreground" title={summary.conversationId}>
        {summary.conversationId}
      </p>
      <p className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
        <span>{timeLabel(summary.updatedAt)}</span>
        <span>搜索 {summary.searches}</span>
        <span>详情 {summary.details}</span>
        {summary.transcripts > 0 ? <span className="text-[#4d6249]">字幕 {summary.transcripts}</span> : null}
        {summary.withoutTranscript > 0 ? <span className="text-[#8a4f22]">无字幕 {summary.withoutTranscript}</span> : null}
      </p>
    </button>
  );
}

export function XhsReadsView() {
  const [summaries, setSummaries] = useState<XhsReadSummary[]>([]);
  const [selected, setSelected] = useState("");
  const [session, setSession] = useState<XhsReadSession | null>(null);
  const [listState, setListState] = useState<State>({ status: "loading" });
  const [sessionState, setSessionState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/xhs-reads");
        const body = await response.json();
        if (!response.ok) throw new Error(asText(body?.error) || `HTTP ${response.status}`);
        const rows: XhsReadSummary[] = Array.isArray(body?.sessions) ? body.sessions : [];
        if (cancelled) return;
        setSummaries(rows);
        setListState({ status: "ready" });
        if (rows.length) setSelected(rows[0].conversationId);
      } catch (error) {
        if (!cancelled) setListState({ status: "error", message: error instanceof Error ? error.message : "读取失败" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setSessionState({ status: "loading" });
    (async () => {
      try {
        const response = await fetch(`/api/xhs-reads?conversationId=${encodeURIComponent(selected)}`);
        const body = await response.json();
        if (!response.ok) throw new Error(asText(body?.error) || `HTTP ${response.status}`);
        if (cancelled) return;
        // 服务端给的是 `{ session: {...} }`；用窄化读取而不是断言，形状不对时显示空态而不是崩。
        const row = asRecord(body?.session);
        setSession(
          row
            ? {
                conversationId: asText(row.conversationId),
                startedAt: typeof row.startedAt === "number" ? row.startedAt : null,
                updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
                entries: Array.isArray(row.entries) ? (row.entries as XhsReadSession["entries"]) : []
              }
            : null
        );
        setSessionState({ status: "ready" });
      } catch (error) {
        if (!cancelled) setSessionState({ status: "error", message: error instanceof Error ? error.message : "读取失败" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const entries = session?.entries ?? [];
  const videoCount = entries.filter((entry) => {
    const note = asRecord(entry.payload?.note);
    return entry.kind === "detail" && note?.transcript !== undefined;
  }).length;

  return (
    <div className="flex h-svh flex-col bg-background">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border bg-[#fbfaf8]/90 px-4 backdrop-blur-xl sm:px-7">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          回到对话
        </Link>
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Database className="size-4 text-muted-foreground" />
            取数记录
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            agent 从小红书读到的原始内容（含视频口播字幕）· 直接取自 pi 会话文件，与模型看到的一字不差
          </p>
        </div>
        {sessionState.status === "ready" && entries.length ? (
          <p className="ml-auto shrink-0 text-[11px] text-muted-foreground">
            {entries.length} 次调用
            {videoCount ? <span className="ml-2 text-[#4d6249]">{videoCount} 篇带字幕</span> : null}
          </p>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-72 shrink-0 overflow-y-auto border-r border-border bg-[#fbfaf8] p-3 lg:block">
          <p className="px-1 pb-2 text-[11px] font-medium uppercase tracking-[.14em] text-muted-foreground">
            会话（新的在前）
          </p>
          {listState.status === "loading" ? (
            <p className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              读取中
            </p>
          ) : listState.status === "error" ? (
            <p className="px-1 py-3 text-xs text-[#8a4f22]">{listState.message}</p>
          ) : summaries.length === 0 ? (
            <p className="rounded-xl border border-border bg-card px-3 py-4 text-xs leading-6 text-muted-foreground">
              还没有任何取数记录。
              <br />
              去聊一轮妆容研究，这里就会出现 agent 读过的笔记。
            </p>
          ) : (
            <div className="space-y-2">
              {summaries.map((summary) => (
                <SummaryRow
                  key={summary.conversationId}
                  summary={summary}
                  active={summary.conversationId === selected}
                  onSelect={() => setSelected(summary.conversationId)}
                />
              ))}
            </div>
          )}
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {sessionState.status === "loading" && selected ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              读取中
            </p>
          ) : sessionState.status === "error" ? (
            <p className="text-xs text-[#8a4f22]">{sessionState.message}</p>
          ) : entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">这份会话里没有小红书取数记录。</p>
          ) : (
            <div className="mx-auto max-w-4xl space-y-4">
              {/* 移动端没有左侧栏，用下拉补齐会话切换。 */}
              {summaries.length > 1 ? (
                <select
                  value={selected}
                  onChange={(event) => setSelected(event.target.value)}
                  className="w-full rounded-xl border border-border bg-card px-3 py-2 text-xs text-foreground lg:hidden"
                >
                  {summaries.map((summary) => (
                    <option key={summary.conversationId} value={summary.conversationId}>
                      {summary.conversationId}（{timeLabel(summary.updatedAt)}）
                    </option>
                  ))}
                </select>
              ) : null}
              {entries.map((entry) => (
                <ReadEntryCard key={entry.toolCallId || `${entry.at}-${entry.kind}`} entry={entry} />
              ))}
            </div>
          )}
        </main>
      </div>

      <Toaster position="top-center" richColors />
    </div>
  );
}
