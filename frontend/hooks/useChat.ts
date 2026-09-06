import { useCallback, useMemo, useState, type FormEvent } from "react";
import { makeClientId } from "@/frontend/lib/formatters";
import { readSse } from "@/frontend/lib/sse";
import { WELCOME_TURN } from "@/frontend/lib/constants";
import { isRuntimeAnswer, type RuntimeAnswer, type Turn } from "@/frontend/lib/types";

type UseChatOptions = {
  userId: string;
  onError: (message: string) => void;
};

export function useChat({ userId, onError }: UseChatOptions) {
  const [message, setMessage] = useState("");
  const [turns, setTurns] = useState<Turn[]>([WELCOME_TURN]);
  const [conversationId, setConversationId] = useState<string>();
  const [isSending, setIsSending] = useState(false);
  const [latestAnswer, setLatestAnswer] = useState<RuntimeAnswer | null>(null);
  const [runtimePhase, setRuntimePhase] = useState<string | null>(null);

  const submitMessage = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || isSending) return;

    const assistantTurnId = makeClientId("assistant");
    setLatestAnswer(null);
    setRuntimePhase(null);
    setIsSending(true);
    setTurns((current) => [
      ...current,
      { id: makeClientId("user"), role: "user", text: trimmed },
      { id: assistantTurnId, role: "assistant", text: "" }
    ]);
    setMessage("");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, conversationId, userId })
      });

      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error ?? "对话接口没有返回流式结果。");
      }

      for await (const parsed of readSse(response)) {
        if (parsed.event === "status") {
          setRuntimePhase((parsed.data as { message?: string }).message ?? null);
        }

        if (parsed.event === "tool_started" || parsed.event === "tool_finished") {
          const tool = parsed.data as { outputSummary?: string; status?: string };
          setRuntimePhase(tool.outputSummary ?? (tool.status === "succeeded" ? "资料查询完成" : "资料查询不可用"));
        }

        if (parsed.event === "text_delta") {
          const text = (parsed.data as { text?: string }).text ?? "";
          setTurns((current) =>
            current.map((turn) =>
              turn.id === assistantTurnId ? { ...turn, text: `${turn.text}${text}` } : turn
            )
          );
        }

        if (parsed.event === "result") {
          const nextAnswer = parsed.data as RuntimeAnswer;
          if (!isRuntimeAnswer(nextAnswer)) throw new Error("Agent Runtime 返回了无法识别的结果。");
          setLatestAnswer(nextAnswer);
          setConversationId(nextAnswer.run.conversationId);
          setTurns((current) =>
            current.map((turn) =>
              turn.id === assistantTurnId
                ? { ...turn, text: nextAnswer.answerText, answer: nextAnswer }
                : turn
            )
          );
        }

        if (parsed.event === "error") {
          throw new Error((parsed.data as { message?: string }).message ?? "生成推荐失败。");
        }
      }
    } catch (caught) {
      const messageText = caught instanceof Error ? caught.message : "生成推荐失败。";
      onError(messageText);
      setTurns((current) =>
        current.map((turn) =>
          turn.id === assistantTurnId ? { ...turn, text: `这轮没有跑通：${messageText}` } : turn
        )
      );
    } finally {
      setIsSending(false);
    }
  }, [conversationId, isSending, message, onError, userId]);

  const statusCopy = useMemo(() => {
    if (isSending) return runtimePhase ?? "正在理解你的需求";
    if (latestAnswer) return "已生成本轮建议";
    return "等待文字目标";
  }, [isSending, latestAnswer, runtimePhase]);

  return {
    message,
    setMessage,
    turns,
    isSending,
    latestAnswer,
    runtimePhase,
    statusCopy,
    submitMessage
  };
}
