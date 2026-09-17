"use client";

import { Brain, Check, ChevronRight, Loader2, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RuntimeStep } from "@/frontend/lib/types";

type TurnTraceProps = {
  steps: RuntimeStep[];
  isStreaming: boolean;
};

/** 灰色过程区：先看模型怎么想、调用了什么、看到了什么，最后才是答案。 */
export function TurnTrace({ steps, isStreaming }: TurnTraceProps) {
  if (steps.length === 0) return null;

  const toolCount = steps.filter((step) => step.kind === "tool").length;

  return (
    <div className="turn-trace" aria-label="Pi 执行过程">
      <div className="trace-head">
        {isStreaming ? <Loader2 className="spin" size={12} /> : <Check size={12} />}
        <span>执行过程</span>
        {toolCount > 0 ? <span className="trace-count">{toolCount} 次工具调用</span> : null}
      </div>
      <ol className="trace-steps">
        {steps.map((step) => (
          <TraceStep key={step.id} step={step} isStreaming={isStreaming} />
        ))}
      </ol>
    </div>
  );
}

function TraceStep({ step, isStreaming }: { step: RuntimeStep; isStreaming: boolean }) {
  const [open, setOpen] = useState(step.kind === "thinking");
  const bodyRef = useRef<HTMLPreElement>(null);
  const autoCollapsed = useRef(false);
  const isLive = isStreaming && step.status === "running";

  // 思考流式输出时保持贴底，避免用户手动追着滚。
  useEffect(() => {
    if (isLive && open && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [step.text, isLive, open]);

  // 本轮结束后收起思考，把注意力让给最终答案；用户仍可手动展开。
  useEffect(() => {
    if (!isStreaming && !autoCollapsed.current) {
      autoCollapsed.current = true;
      setOpen(false);
    }
  }, [isStreaming]);

  if (step.kind === "thinking") {
    const text = step.text ?? "";
    return (
      <li className="trace-step thinking">
        <Brain size={12} className="trace-icon" aria-hidden="true" />
        <div className="trace-body">
          <button type="button" className="trace-toggle" onClick={() => setOpen((value) => !value)}>
            <ChevronRight size={11} className={open ? "trace-chevron open" : "trace-chevron"} aria-hidden="true" />
            {isLive ? "思考中" : "思考"}
            {!open && text ? <span className="trace-peek">{text.slice(-46)}</span> : null}
          </button>
          {open && text ? <pre className="trace-thinking" ref={bodyRef}>{text}</pre> : null}
        </div>
      </li>
    );
  }

  if (step.kind === "narration") {
    return (
      <li className="trace-step narration">
        <span className="trace-dot" aria-hidden="true" />
        <div className="trace-body"><p className="trace-label">{step.label}</p></div>
      </li>
    );
  }

  return (
    <li className={`trace-step tool ${step.status}`}>
      <Search size={12} className="trace-icon" aria-hidden="true" />
      <div className="trace-body">
        <p className="trace-label">
          {step.label}
          {step.status === "running" ? <Loader2 size={10} className="spin" /> : null}
          {step.status === "failed" ? <X size={11} className="trace-failed" /> : null}
        </p>
        {step.detail && step.detail !== step.label ? <p className="trace-detail">{step.detail}</p> : null}
      </div>
    </li>
  );
}
