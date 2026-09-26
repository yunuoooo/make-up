"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Copy, ImageOff } from "lucide-react";
import {
  asNumber,
  asRecord,
  asStrings,
  asText,
  durationLabel,
  splitTranscript,
  statItems
} from "@/frontend/lib/reads";

/**
 * 一篇笔记的原始内容：工具返回什么就画什么。
 *
 * 视频那两样是重点——`durationSeconds` 与**口播字幕**。字幕块用等宽字体、按 `[MM:SS]` 对齐，
 * 因为排查时看的就是「第几分钟说了什么」。
 */

/**
 * 小红书图床有防盗链，要去掉 referrer 才能直接显示（同 `AdvisorMessage`）。
 * 另外封面地址是**带签名的**，过期后必然 404——那时整块不渲染，别留一个破图标。
 */
function RemoteImage({ src, className, alt }: { src: string; className?: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}

function Transcript({ transcript }: { transcript: Record<string, unknown> }) {
  const lines = splitTranscript(transcript.text);
  const lang = asText(transcript.lang);
  const truncated = transcript.truncated === true;

  async function copy() {
    try {
      await navigator.clipboard.writeText(asText(transcript.text));
      toast.success(`已复制 ${lines.length} 条字幕`);
    } catch {
      toast.error("复制失败，请手动选择文本。");
    }
  }

  return (
    <section className="mt-4">
      <div className="flex items-center gap-2">
        <h4 className="text-xs font-semibold tracking-wide text-foreground">口播字幕</h4>
        <span className="rounded-full bg-[#fae8ee] px-2 py-0.5 text-[11px] text-[#a23d5d]">
          {lang || "未知语言轨"} · {lines.length} 条
        </span>
        {truncated ? (
          <span className="rounded-full bg-[#f1ece9] px-2 py-0.5 text-[11px] text-muted-foreground">已截断</span>
        ) : null}
        <button
          type="button"
          onClick={copy}
          className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-muted-foreground hover:bg-[#f1ece9] hover:text-foreground"
        >
          <Copy className="size-3" />
          复制
        </button>
      </div>
      <div className="mt-2 max-h-96 overflow-y-auto rounded-xl border border-border bg-[#fbfaf8] p-3">
        {lines.length ? (
          <ol className="space-y-1">
            {lines.map((line, index) => (
              <li key={index} className="flex gap-3 text-[13px] leading-6">
                <span className="shrink-0 font-mono text-[11px] leading-6 text-[#a23d5d]">{line.stamp || "—"}</span>
                <span className="text-foreground/90">{line.body}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-xs text-muted-foreground">字幕是空的。</p>
        )}
      </div>
    </section>
  );
}

export function NoteCard({ note, compact = false }: { note: Record<string, unknown>; compact?: boolean }) {
  const title = asText(note.title);
  const author = asText(note.authorName);
  const postedAt = asText(note.postedAt);
  const ipLocation = asText(note.ipLocation);
  const noteType = asText(note.noteType);
  const body = asText(note.text);
  const tags = asStrings(note.tags);
  const images = asStrings(note.images);
  const stats = statItems(note.stats);
  const duration = durationLabel(asNumber(note.durationSeconds));
  const transcript = asRecord(note.transcript);
  const truncated = note.truncated === true;

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex gap-4 p-4">
        {images[0] ? (
          <RemoteImage
            src={images[0]}
            alt={title || "笔记封面"}
            className="size-20 shrink-0 rounded-lg bg-[#f1ece9] object-cover"
          />
        ) : (
          <div className="grid size-20 shrink-0 place-items-center rounded-lg bg-[#f1ece9] text-muted-foreground">
            <ImageOff className="size-4" />
          </div>
        )}

        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground" title={title}>
            {title || <span className="text-muted-foreground">（没有标题）</span>}
          </h3>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {author ? <span>{author}</span> : null}
            {postedAt ? <span>{postedAt}</span> : null}
            {ipLocation ? <span>{ipLocation}</span> : null}
            {noteType ? (
              <span className="rounded-full bg-[#f1ece9] px-2 py-0.5 text-[10px] uppercase text-foreground/70">
                {noteType}
              </span>
            ) : null}
            {duration ? <span className="font-mono">{duration}</span> : null}
            {stats.map((item) => (
              <span key={item.label}>
                {item.label} {item.value}
              </span>
            ))}
          </p>
          {tags.length ? (
            <p className="mt-2 flex flex-wrap gap-1">
              {tags.map((tag) => (
                <span key={tag} className="rounded-full bg-[#f1ece9] px-2 py-0.5 text-[11px] text-foreground/70">
                  #{tag}
                </span>
              ))}
            </p>
          ) : null}
        </div>
      </div>

      {!compact && body ? (
        <div className="border-t border-border px-4 py-3">
          <h4 className="text-xs font-semibold tracking-wide text-foreground">
            正文{truncated ? <span className="ml-2 font-normal text-muted-foreground">（已截断）</span> : null}
          </h4>
          <p className="mt-1 whitespace-pre-wrap text-[13px] leading-6 text-foreground/85">{body}</p>
        </div>
      ) : null}

      {!compact && transcript ? (
        <div className="border-t border-border px-4 pb-4">
          <Transcript transcript={transcript} />
        </div>
      ) : null}

      {!compact && images.length > 1 ? (
        <div className="border-t border-border px-4 py-3">
          <h4 className="text-xs font-semibold tracking-wide text-foreground">图组 {images.length} 张</h4>
          <div className="mt-2 flex flex-wrap gap-2">
            {images.map((src, index) => (
              <RemoteImage
                key={src}
                src={src}
                alt={`第 ${index + 1} 张`}
                className="size-24 rounded-lg bg-[#f1ece9] object-cover"
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
