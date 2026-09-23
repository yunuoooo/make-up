"use client";

import { useEffect, useRef } from "react";
import { Brain, Check, FileText, LoaderCircle, Search, ShieldCheck, X } from "lucide-react";
import type { RuntimeObservation, RuntimeStep } from "@/frontend/lib/types";

type TurnTraceProps = {
  steps: RuntimeStep[];
  observation?: RuntimeObservation;
  isStreaming: boolean;
};

const TOOL_ICONS: Record<string, typeof Search> = {
  read: FileText,
  xhs_search_notes: Search,
  xhs_get_note_detail: Search,
  xhs_source_status: ShieldCheck
};

/**
 * 本轮过程：模型怎么想、调了哪个工具、看到了什么。流式时自动展开，
 * 结束后自动收起，把注意力让给最终答案——用户随时可以再点开。
 */
export function TurnTrace({ steps, observation, isStreaming }: TurnTraceProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const wasStreaming = useRef(isStreaming);

  useEffect(() => {
    const element = detailsRef.current;
    if (!element) return;
    // 只在状态切换时接管展开状态，流式过程中的手动开合不会被覆盖。
    if (isStreaming) element.open = true;
    else if (wasStreaming.current) element.open = false;
    wasStreaming.current = isStreaming;
  }, [isStreaming]);

  if (steps.length === 0 && !observation) return null;

  const toolSteps = steps.filter((step) => step.kind === "tool");

  return (
    <details
      ref={detailsRef}
      className="mt-3 rounded-[16px] border border-black/[.06] bg-white px-4 py-3 text-sm text-[#716a64]"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-[#4e4843] marker:content-none">
        {isStreaming ? (
          <LoaderCircle className="size-3.5 animate-spin text-[#b24c6b]" />
        ) : (
          <Check className="size-3.5 text-[#5f7463]" />
        )}
        <span>本轮过程</span>
        {toolSteps.length ? <span className="text-xs font-normal text-[#9b938c]">{toolSteps.length} 次资料查询</span> : null}
      </summary>

      <ol className="mt-3 space-y-2.5 border-t border-black/[.055] pt-3">
        {steps.map((step) => (
          <TraceStep key={step.id} step={step} />
        ))}
      </ol>

      {observation ? <ObservationFooter observation={observation} /> : null}
    </details>
  );
}

function TraceStep({ step }: { step: RuntimeStep }) {
  if (step.kind === "thinking") {
    const live = step.status === "running";
    return (
      <li className="flex gap-2.5">
        <Brain className="mt-1 size-3.5 shrink-0 text-[#b0a8a1]" />
        <details className="min-w-0 flex-1">
          <summary className="cursor-pointer list-none text-[13px] text-[#8d857f] marker:content-none">
            {live ? "思考中…" : "思考"}
          </summary>
          <pre className="mt-1.5 max-h-52 overflow-y-auto whitespace-pre-wrap break-words rounded-[10px] bg-[#f8f6f4] p-3 font-sans text-[12px] leading-6 text-[#7d756f]">
            {step.text}
          </pre>
        </details>
      </li>
    );
  }

  if (step.kind === "narration") {
    return (
      <li className="flex gap-2.5">
        <span className="mt-2 size-1.5 shrink-0 rounded-full bg-[#d3ccc6]" />
        <p className="min-w-0 flex-1 text-[13px] leading-6 text-[#8d857f]">{step.label}</p>
      </li>
    );
  }

  const Icon = TOOL_ICONS[step.label] ?? Search;
  return (
    <li className="flex gap-2.5">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-[#b0a8a1]" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-[13px] leading-6 text-[#5e5751]">
          <span className="truncate">{step.label}</span>
          {step.status === "running" ? <LoaderCircle className="size-3 shrink-0 animate-spin text-[#b24c6b]" /> : null}
          {step.status === "failed" ? <X className="size-3 shrink-0 text-[#ba3751]" /> : null}
        </p>
        {step.detail && step.detail !== step.label ? (
          <p className="text-[12px] leading-5 text-[#9b938c]">{step.detail}</p>
        ) : null}
      </div>
    </li>
  );
}

function ObservationFooter({ observation }: { observation: RuntimeObservation }) {
  const usage = observation.usage;
  const skill = observation.skillPath?.split("/").filter(Boolean).pop() ?? "-";

  return (
    <div className="mt-3 border-t border-black/[.055] pt-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#9b938c]">
        <span title={observation.skillPath}>技能 {skill}</span>
        <span>{observation.provider} / {observation.model}</span>
        <span>{observation.modelCallCount} 次模型调用</span>
        <span>
          tokens {usage.input ?? 0} 入 / {usage.output ?? 0} 出
        </span>
        <span title={observation.agentRunId}>trace {observation.traceId.slice(0, 18)}…</span>
      </div>
      {observation.systemPrompt || observation.userPrompt ? (
        <details className="mt-2">
          <summary className="cursor-pointer list-none text-[11px] text-[#9b938c] marker:content-none">查看实际提示词</summary>
          <div className="mt-2 space-y-2">
            <PromptBlock label="system" text={observation.systemPrompt} />
            <PromptBlock label="user" text={observation.userPrompt} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function PromptBlock({ label, text }: { label: string; text?: string }) {
  if (!text) return null;
  return (
    <div>
      <span className="text-[10px] uppercase tracking-[.14em] text-[#b0a8a1]">{label}</span>
      <pre className="mt-1 max-h-52 overflow-y-auto whitespace-pre-wrap break-words rounded-[10px] bg-[#f8f6f4] p-3 font-sans text-[12px] leading-6 text-[#7d756f]">
        {text}
      </pre>
    </div>
  );
}
