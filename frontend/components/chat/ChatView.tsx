"use client";

import { useEffect, useRef, type FormEvent } from "react";
import { ArrowUp, LoaderCircle, Sparkles } from "lucide-react";
import { Button } from "@/frontend/components/ui/button";
import { Textarea } from "@/frontend/components/ui/textarea";
import { AdvisorMessage } from "@/frontend/components/chat/AdvisorMessage";
import { ProductCardStrip } from "@/frontend/components/chat/ProductCardStrip";
import { TurnTrace } from "@/frontend/components/chat/TurnTrace";
import {
  DISCLAIMER,
  INSPIRATION_IMAGE,
  INSPIRATION_PROMPT,
  STATELESS_NOTICE,
  SUGGESTED_PROMPTS
} from "@/frontend/lib/constants";
import type { Turn } from "@/frontend/lib/types";

type ChatViewProps = {
  turns: Turn[];
  draft: string;
  isSending: boolean;
  runtimePhase: string | null;
  isHistorical: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
};

export function ChatView({
  turns,
  draft,
  isSending,
  runtimePhase,
  isHistorical,
  onDraftChange,
  onSubmit
}: ChatViewProps) {
  const threadEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: isSending ? "auto" : "smooth", block: "end" });
  }, [isSending, turns]);

  const isEmpty = turns.length === 0;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="scrollbar-thin flex-1 overflow-y-auto px-4 pb-36 pt-7 sm:px-8 lg:px-12">
        <div className="mx-auto min-h-full w-full max-w-5xl">
          {isEmpty ? (
            <EmptyChat onPick={onDraftChange} />
          ) : (
            <div className="space-y-10 py-2">
              {turns.map((turn, index) =>
                turn.role === "user" ? (
                  <div
                    key={turn.id}
                    className="ml-auto max-w-xl whitespace-pre-wrap rounded-[22px] bg-[#242421] px-5 py-4 text-[15px] leading-7 text-white shadow-lg"
                  >
                    {turn.text}
                  </div>
                ) : (
                  <div key={turn.id} className="flex min-w-0 gap-3 border-t border-black/[.06] pt-8 first:border-0 first:pt-0">
                    <div className="grid size-9 shrink-0 place-items-center rounded-full bg-[#ef7196] text-sm font-semibold text-white">妆</div>
                    <div className="min-w-0 flex-1">
                      <TurnTrace
                        steps={turn.steps ?? []}
                        observation={turn.observation}
                        // 商品卡片在 result 之后才回来，这期间答案已经完整了：
                        // 按 answer 判定，过程面板才会在答案落地时收起，而不是等淘宝。
                        isStreaming={isSending && index === turns.length - 1 && !turn.answer}
                      />
                      {turn.text ? (
                        <div className="mt-3">
                          <AdvisorMessage text={turn.text} />
                          <ProductCardStrip state={turn.cards} />
                        </div>
                      ) : isSending && index === turns.length - 1 ? (
                        <div className="flex items-center gap-2 pt-3 text-sm text-[#77706a]">
                          <LoaderCircle className="size-4 animate-spin" />
                          {runtimePhase ?? "正在拆解妆效并核对你的化妆品库…"}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )
              )}
              <div ref={threadEndRef} />
            </div>
          )}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#f6f4f2] via-[#f6f4f2] to-transparent px-4 pb-5 pt-12 sm:px-8">
        <form
          onSubmit={onSubmit}
          className="pointer-events-auto mx-auto flex w-full max-w-3xl items-end gap-3 rounded-[24px] border border-black/[.08] bg-white p-2.5 pl-4 shadow-[0_18px_50px_rgba(40,35,32,.12)]"
        >
          <Textarea
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="告诉我妆容名字，比如：韩系氧气妆"
            aria-label="输入妆容名字"
            rows={1}
            className="max-h-32 min-h-11 resize-none border-0 bg-transparent px-0 py-3 text-[15px] shadow-none focus-visible:ring-0"
          />
          <Button
            type="submit"
            size="icon"
            disabled={isSending || !draft.trim()}
            className="size-11 shrink-0 rounded-[15px] bg-[#242421] text-white hover:bg-[#3a3935]"
            aria-label="发送"
          >
            {isSending ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}
          </Button>
        </form>
        <p className="pointer-events-auto mx-auto mt-2 max-w-3xl text-center text-[11px] text-[#a29c96]">
          {isHistorical ? STATELESS_NOTICE : DISCLAIMER}
        </p>
      </div>
    </div>
  );
}

function EmptyChat({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <section className="grid min-h-full items-center gap-10 py-8 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="max-w-2xl">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#d8587e]/15 bg-[#fae8ee] px-3 py-1.5 text-xs font-medium text-[#a23d5d]">
          <Sparkles className="size-3.5" />
          你的私人妆容顾问
        </div>
        <h1 className="text-balance font-serif text-[clamp(2rem,5vw,4.25rem)] leading-[1.08] tracking-[-.035em] text-[#24211f]">
          我是你的妆容拆解小助手，今天想化个什么样的妆呢？
        </h1>
        <p className="mt-5 max-w-xl text-[15px] leading-7 text-[#817a74]">
          告诉我一个妆容名字。我会先去小红书拆出关键妆效，再与你的化妆品库逐件匹配，清楚标出哪些已有、哪些需要买。
        </p>
        <div className="mt-7 flex flex-wrap gap-2.5" aria-label="妆容示例">
          {SUGGESTED_PROMPTS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => onPick(suggestion)}
              className="rounded-full border border-black/[.08] bg-white px-4 py-2.5 text-sm text-[#4e4945] shadow-[0_3px_12px_rgba(35,31,28,.04)] transition hover:-translate-y-0.5 hover:border-[#d8587e]/30 hover:text-[#a23d5d]"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={() => onPick(INSPIRATION_PROMPT)}
        className="group relative mx-auto aspect-[4/5] w-full max-w-[280px] overflow-hidden rounded-[28px] bg-[#eadedc] text-left shadow-[0_28px_70px_rgba(55,45,42,.16)]"
      >
        <img
          src={INSPIRATION_IMAGE}
          alt="韩系氧气妆参考妆效"
          className="absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-[1.025]"
        />
        <span className="absolute inset-x-3 bottom-3 rounded-2xl bg-white/88 p-3.5 backdrop-blur-md">
          <span className="block text-[11px] font-medium tracking-[.12em] text-[#a45b71]">今日灵感</span>
          <span className="mt-1 flex items-center justify-between text-sm font-semibold text-[#2a2624]">
            韩系氧气妆
            <ArrowUp className="size-4 rotate-45" />
          </span>
        </span>
      </button>
    </section>
  );
}
