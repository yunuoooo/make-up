import type { SkuCandidate } from "@/lib/types/domain";
import { isRuntimeAnswer, type RuntimeAnswer, type Turn } from "@/frontend/lib/types";
import { MarkdownMessage } from "./MarkdownMessage";
import { StructuredAnswer } from "./StructuredAnswer";
import { TurnTrace } from "./TurnTrace";

type ChatTurnProps = {
  turn: Turn;
  onCandidateToLibrary: (candidate: SkuCandidate) => void;
  isStreaming?: boolean;
};

export function ChatTurn({ turn, onCandidateToLibrary, isStreaming = false }: ChatTurnProps) {
  const label = turn.role === "user" ? "你" : "妆迹";

  return (
    <article className={`chat-turn ${turn.role}`}>
      <div className="avatar" aria-hidden="true">{turn.role === "user" ? "你" : "妆"}</div>
      <div className="turn-content">
        <span className="turn-label">{label}</span>
        {turn.steps?.length ? <TurnTrace steps={turn.steps} isStreaming={isStreaming} /> : null}
        {turn.answer && isRuntimeAnswer(turn.answer) ? (
          <RuntimeAnswerView answer={turn.answer} />
        ) : turn.answer ? (
          <StructuredAnswer answer={turn.answer} onCandidateToLibrary={onCandidateToLibrary} />
        ) : turn.role === "assistant" ? (
          // 过程区已经在展示进展时，不要再挂一个"正在整理"的空气泡。
          turn.text || !turn.steps?.length ? <MarkdownMessage text={turn.text || "正在整理..."} /> : null
        ) : (
          <p className="message-text user">{turn.text}</p>
        )}
      </div>
    </article>
  );
}

function RuntimeAnswerView({ answer }: { answer: RuntimeAnswer }) {
  const status = {
    succeeded: "已完成",
    degraded: "已降级完成",
    clarification: "需要补充信息",
    failed: "运行失败",
    cancelled: "已取消",
    limit_exceeded: "达到运行限制"
  }[answer.status];

  return (
    <div className="runtime-answer">
      <MarkdownMessage text={answer.answerText} />
      <p className="runtime-meta" title={`traceId: ${answer.run.traceId}`}>
        {status} · run {answer.run.agentRunId}
      </p>
    </div>
  );
}
