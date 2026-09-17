import { useCallback, useMemo, useState, type FormEvent } from "react";
import { makeClientId } from "@/frontend/lib/formatters";
import { readSse } from "@/frontend/lib/sse";
import { WELCOME_TURN } from "@/frontend/lib/constants";
import {
  isRuntimeAnswer,
  type RuntimeAnswer,
  type RuntimeObservation,
  type RuntimeStep,
  type RuntimeToolObservation,
  type RuntimeUsage,
  type Turn
} from "@/frontend/lib/types";

type UseChatOptions = {
  userId: string;
  onError: (message: string) => void;
};

function mergeUsage(current: RuntimeUsage, next: RuntimeUsage): RuntimeUsage {
  return { ...current, ...next };
}

export function useChat({ userId, onError }: UseChatOptions) {
  const [message, setMessage] = useState("");
  const [turns, setTurns] = useState<Turn[]>([WELCOME_TURN]);
  const [conversationId, setConversationId] = useState<string>();
  const [isSending, setIsSending] = useState(false);
  const [latestAnswer, setLatestAnswer] = useState<RuntimeAnswer | null>(null);
  const [runtimePhase, setRuntimePhase] = useState<string | null>(null);
  const [observation, setObservation] = useState<RuntimeObservation | null>(null);

  const submitMessage = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || isSending) return;

    const assistantTurnId = makeClientId("assistant");
    // 过程记录只在本轮闭包里累积：模型旁白进过程，最终答案留在气泡里。
    const steps: RuntimeStep[] = [];
    let buffer = "";
    setLatestAnswer(null);
    setRuntimePhase(null);
    setObservation(null);
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

      const renderSteps = () => setTurns((current) =>
        current.map((turn) => turn.id === assistantTurnId ? { ...turn, steps: [...steps] } : turn)
      );
      const renderText = (text: string) => setTurns((current) =>
        current.map((turn) => turn.id === assistantTurnId ? { ...turn, text } : turn)
      );
      const closeThinking = () => {
        const last = steps.at(-1);
        if (last?.kind === "thinking" && last.status === "running") last.status = "succeeded";
      };
      // 模型在调用工具前说的话属于过程，不该留在最终答案气泡里。
      const flushNarration = () => {
        if (buffer.trim()) {
          steps.push({ id: `narration_${steps.length}`, kind: "narration", label: buffer.trim(), status: "succeeded" });
          buffer = "";
        }
      };
      const upsertTool = (toolCallId: string, toolName: string, summary: string, status: RuntimeStep["status"]) => {
        closeThinking();
        flushNarration();
        const existing = steps.find((step) => step.id === toolCallId);
        if (existing) {
          existing.status = status;
          if (summary) existing.detail = summary;
        } else {
          steps.push({ id: toolCallId, kind: "tool", label: summary || toolName, detail: summary, status });
        }
        renderSteps();
      };

      for await (const parsed of readSse(response)) {
        if (parsed.event === "status") {
          const status = parsed.data as { message?: string; traceId?: string; agentRunId?: string; skillPath?: string };
          setRuntimePhase(status.message ?? null);
          if (status.traceId && status.agentRunId) {
            setObservation((current) => current ?? {
              traceId: status.traceId!,
              agentRunId: status.agentRunId!,
              provider: "-",
              model: "-",
              skillPath: status.skillPath,
              modelCallCount: 0,
              usage: {},
              tools: []
            });
          }
        }

        if (parsed.event === "model_call_started") {
          const call = parsed.data as {
            traceId?: string;
            agentRunId?: string;
            provider?: string;
            model?: string;
            systemPrompt?: string;
            userPrompt?: string;
            callIndex?: number;
          };
          setObservation((current) => ({
            traceId: call.traceId ?? current?.traceId ?? "-",
            agentRunId: call.agentRunId ?? current?.agentRunId ?? "-",
            provider: call.provider ?? current?.provider ?? "-",
            model: call.model ?? current?.model ?? "-",
            skillPath: current?.skillPath,
            systemPrompt: call.systemPrompt ?? current?.systemPrompt,
            userPrompt: call.userPrompt ?? current?.userPrompt,
            modelCallCount: Math.max(call.callIndex ?? 0, current?.modelCallCount ?? 0),
            usage: current?.usage ?? {},
            tools: current?.tools ?? []
          }));
          setRuntimePhase("模型调用中");
        }

        if (parsed.event === "model_usage") {
          const usage = parsed.data as RuntimeUsage;
          setObservation((current) => current ? { ...current, usage: mergeUsage(current.usage, usage) } : current);
        }

        if (parsed.event === "thinking_delta") {
          const text = (parsed.data as { text?: string }).text ?? "";
          const last = steps.at(-1);
          if (last?.kind === "thinking" && last.status === "running") {
            last.text = `${last.text ?? ""}${text}`;
          } else {
            steps.push({ id: `thinking_${steps.length}`, kind: "thinking", label: "思考", text, status: "running" });
          }
          renderSteps();
        }

        if (parsed.event === "thinking_end") {
          closeThinking();
          renderSteps();
        }

        if (parsed.event === "tool_planned") {
          const tool = parsed.data as { toolCallId?: string; toolName?: string; summary?: string };
          upsertTool(tool.toolCallId ?? `tool_${steps.length}`, tool.toolName ?? "tool", tool.summary ?? "", "running");
          renderText("");
        }

        if (parsed.event === "tool_started") {
          const tool = parsed.data as Partial<RuntimeToolObservation>;
          upsertTool(tool.toolCallId ?? `tool_${steps.length}`, tool.toolName ?? "tool", (parsed.data as { summary?: string }).summary ?? "", "running");
          renderText("");
          setObservation((current) => current ? {
            ...current,
            tools: [...current.tools.filter((item) => item.toolCallId !== tool.toolCallId), {
              toolCallId: tool.toolCallId ?? `tool_${current.tools.length + 1}`,
              toolName: tool.toolName ?? "unknown",
              status: "running",
              args: tool.args
            }]
          } : current);
          setRuntimePhase(tool.toolName === "read" ? "正在读取技能与参考文件" : `正在调用 ${tool.toolName ?? "工具"}`);
        }

        if (parsed.event === "tool_finished") {
          const tool = parsed.data as Partial<RuntimeToolObservation>;
          const step = steps.find((item) => item.id === tool.toolCallId);
          if (step) {
            step.status = tool.status === "failed" ? "failed" : "succeeded";
            step.detail = (parsed.data as { summary?: string }).summary ?? step.detail;
          }
          renderSteps();
          setObservation((current) => current ? {
            ...current,
            tools: current.tools.map((item) => item.toolCallId === tool.toolCallId
              ? { ...item, status: tool.status === "failed" ? "failed" : "succeeded", resultPreview: tool.resultPreview }
              : item)
          } : current);
          setRuntimePhase(tool.status === "succeeded" ? "资料查询完成" : "资料查询不可用");
        }

        if (parsed.event === "text_delta") {
          buffer += (parsed.data as { text?: string }).text ?? "";
          renderText(buffer);
        }

        if (parsed.event === "result") {
          const nextAnswer = parsed.data as RuntimeAnswer;
          if (!isRuntimeAnswer(nextAnswer)) throw new Error("Agent Runtime 返回了无法识别的结果。");
          setLatestAnswer(nextAnswer);
          setConversationId(nextAnswer.run.conversationId);
          closeThinking();
          setTurns((current) =>
            current.map((turn) =>
              turn.id === assistantTurnId
                ? { ...turn, text: nextAnswer.answerText, steps: [...steps], answer: nextAnswer }
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
      for (const step of steps) if (step.status === "running") step.status = "failed";
      setTurns((current) =>
        current.map((turn) =>
          turn.id === assistantTurnId ? { ...turn, text: `这轮没有跑通：${messageText}`, steps: [...steps] } : turn
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
    observation,
    runtimePhase,
    statusCopy,
    submitMessage
  };
}
