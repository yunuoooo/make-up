import type { SkuCandidate } from "@/lib/types/domain";
import type { Turn } from "@/frontend/lib/types";
import { StructuredAnswer } from "./StructuredAnswer";

type ChatTurnProps = {
  turn: Turn;
  onCandidateToLibrary: (candidate: SkuCandidate) => void;
};

export function ChatTurn({ turn, onCandidateToLibrary }: ChatTurnProps) {
  const label = turn.role === "user" ? "你" : "妆迹";

  return (
    <article className={`chat-turn ${turn.role}`}>
      <div className="avatar" aria-hidden="true">{turn.role === "user" ? "你" : "妆"}</div>
      <div className="turn-content">
        <span className="turn-label">{label}</span>
        {turn.answer ? (
          <StructuredAnswer answer={turn.answer} onCandidateToLibrary={onCandidateToLibrary} />
        ) : (
          <p className="message-text">{turn.text || "正在整理..."}</p>
        )}
      </div>
    </article>
  );
}
