"use client";

import { useState } from "react";
import { AlertTriangle, ChevronRight, Search, Video } from "lucide-react";
import { NoteCard } from "./NoteCard";
import { asList, asRecord, asText, timeLabel } from "@/frontend/lib/reads";
import type { XhsReadEntry } from "@/lib/pi/session-reads";

/**
 * 一次取数调用 = 一张卡片。
 *
 * 三条分支都要照顾到，**尤其是失败那条**：可观测性页面最有价值的时刻就是「模型到底看到了什么」
 * ——拒答、空结果、字幕没取到，恰恰是答案看起来奇怪时最需要核对的东西。所以失败不折叠、不淡化，
 * 和成功一样占一张卡。
 */

/** 工具主动拒绝时返回的就是这几个字段（`source` / `mode` / `reason` / `message`）。 */
function Refusal({ payload }: { payload: Record<string, unknown> }) {
  const reason = asText(payload.reason);
  const message = asText(payload.message);
  return (
    <div className="flex gap-3 rounded-xl border border-[#e8d3c8] bg-[#fdf6f1] p-3">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[#a2622f]" />
      <div className="min-w-0">
        <p className="text-xs font-medium text-[#8a4f22]">
          {reason ? <code className="rounded bg-[#f5e5d8] px-1.5 py-0.5 font-mono text-[11px]">{reason}</code> : "没有取到内容"}
        </p>
        {message ? <p className="mt-1 text-[13px] leading-6 text-foreground/85">{message}</p> : null}
      </div>
    </div>
  );
}

/**
 * 搜索返回的是**摘要**（截断预览），只做紧凑列表——正文要走详情。
 *
 * **默认折起来**：一页 20 条，摊开就是四屏，会把真正要核对的「详情」挤到下面去。
 * 搜索结果是「它为什么挑这几篇」的旁证，想看再点开。
 */
function SearchResults({ payload }: { payload: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const notes = asList(payload.notes).map(asRecord).filter((note): note is Record<string, unknown> => note !== null);
  if (!notes.length) return <p className="text-xs text-muted-foreground">这一页没有结果。</p>;
  const videos = notes.filter((note) => asText(note.noteType) === "video").length;
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] text-muted-foreground hover:bg-[#f7f4f2]"
      >
        <ChevronRight className={`size-3 transition ${open ? "rotate-90" : ""}`} />
        {open ? "收起" : "展开"}这 {notes.length} 条（{videos} 条视频、{notes.length - videos} 条图文）
      </button>
      {open ? (
        <ul className="divide-y divide-border border-t border-border">
          {notes.map((note, index) => (
            <li key={`${asText(note.noteId)}-${index}`}>
              <NoteCard note={note} compact />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Summary({ payload }: { payload: Record<string, unknown> }) {
  return (
    <p className="flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
      <span>第 {asText(String(payload.page ?? "")) || "1"} 页</span>
      <span>{payload.hasMore === true ? "还有下一页" : "没有下一页了"}</span>
      <span>{asList(payload.notes).length} 条</span>
    </p>
  );
}

export function ReadEntryCard({ entry }: { entry: XhsReadEntry }) {
  const payload = entry.payload;
  const note = asRecord(payload?.note);
  const isRefusal = !payload || typeof payload.reason === "string";
  // 视频详情的两个标志：明明成功了却没给字幕，或干脆没有人声。
  const transcriptMissing = typeof payload?.reason === "string" && entry.kind === "detail";
  const arg = entry.kind === "search" ? asText(entry.arg.keyword) : asText(entry.arg.noteId);

  return (
    <article className="rounded-2xl border border-border bg-[#fbfaf8] p-3">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
            entry.kind === "search" ? "bg-[#eef1ea] text-[#4d6249]" : "bg-[#fae8ee] text-[#a23d5d]"
          }`}
        >
          {entry.kind === "search" ? <Search className="size-3" /> : <Video className="size-3" />}
          {entry.kind === "search" ? "搜索" : "详情"}
        </span>
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground" title={arg}>
          {arg || "（没有参数）"}
        </span>
        {transcriptMissing ? (
          <span className="rounded-full bg-[#f5e5d8] px-2 py-0.5 font-mono text-[10px] text-[#8a4f22]">
            {asText(payload?.reason)}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{timeLabel(entry.at)}</span>
      </header>

      {entry.raw ? (
        <pre className="max-h-64 overflow-auto rounded-xl border border-border bg-card p-3 text-[11px] leading-5 text-muted-foreground">
          {entry.raw}
        </pre>
      ) : isRefusal ? (
        <Refusal payload={payload ?? {}} />
      ) : entry.kind === "search" ? (
        <div className="space-y-3">
          <Summary payload={payload!} />
          <SearchResults payload={payload!} />
        </div>
      ) : note ? (
        <div className="space-y-2">
          {transcriptMissing ? <Refusal payload={payload!} /> : null}
          <NoteCard note={note} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">这次调用没有返回笔记内容。</p>
      )}
    </article>
  );
}
