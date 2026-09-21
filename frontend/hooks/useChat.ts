"use client";

import { useCallback, useRef, useState, type FormEvent } from "react";
import { makeClientId } from "@/frontend/lib/formatters";
import { readSse } from "@/frontend/lib/sse";
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
  /** 一轮结束后交出完整对话，由调用方决定存到哪里。 */
  onPersist: (conversationId: string, turns: Turn[], title: string) => void;
};

function mergeUsage(current: RuntimeUsage, next: RuntimeUsage): RuntimeUsage {
  return { ...current, ...next };
}

export function useChat({ userId, onError, onPersist }: UseChatOptions) {
  const [message, setMessage] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [runtimePhase, setRuntimePhase] = useState<string | null>(null);
  /** 打开的是历史对话时为真：Agent 不记得这些内容，界面要如实说明。 */
  const [isHistorical, setIsHistorical] = useState(false);
  const isSendingRef = useRef(false);
  const onErrorRef = useRef(onError);
  const onPersistRef = useRef(onPersist);
  onErrorRef.current = onError;
  onPersistRef.current = onPersist;

  const startNewChat = useCallback(() => {
    setTurns([]);
    setConversationId(null);
    setMessage("");
    setRuntimePhase(null);
    setIsHistorical(false);
  }, []);

  const loadConversation = useCallback((id: string, storedTurns: Turn[]) => {
    setTurns(storedTurns);
    setConversationId(id);
    setMessage("");
    setRuntimePhase(null);
    setIsHistorical(true);
  }, []);

  const submitMessage = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || isSendingRef.current) return;

    const activeConversationId = conversationId ?? makeClientId("conversation");
    const base = turns;
    const userTurn: Turn = { id: makeClientId("user"), role: "user", text: trimmed };
    // 助手轮次先建一个对象，随后原地更新字段；每次 setTurns 换数组引用触发重渲染。
    const assistantTurn: Turn = { id: makeClientId("assistant"), role: "assistant", text: "" };
    const steps: RuntimeStep[] = [];
    const render = () => setTurns([...base, userTurn, assistantTurn]);

    let buffer = "";
    let observation: RuntimeObservation | null = null;
    // 过程记录只在本轮闭包里累积：模型旁白进过程，最终答案留在气泡里。
    const closeThinking = () => {
      const last = steps.at(-1);
      if (last?.kind === "thinking" && last.status === "running") last.status = "succeeded";
    };
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
      assistantTurn.steps = [...steps];
      render();
    };

    isSendingRef.current = true;
    setIsSending(true);
    setIsHistorical(false);
    setRuntimePhase(null);
    setConversationId(activeConversationId);
    setMessage("");
    render();

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, conversationId: activeConversationId, userId })
      });

      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error ?? "对话接口没有返回流式结果。");
      }

      for await (const parsed of readSse(response)) {
        if (parsed.event === "status") {
          const status = parsed.data as { message?: string; traceId?: string; agentRunId?: string; skillPath?: string };
          setRuntimePhase(status.message ?? null);
          if (status.traceId && status.agentRunId) {
            observation = observation ?? {
              traceId: status.traceId,
              agentRunId: status.agentRunId,
              provider: "-",
              model: "-",
              skillPath: status.skillPath,
              modelCallCount: 0,
              usage: {},
              tools: []
            };
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
          observation = {
            traceId: call.traceId ?? observation?.traceId ?? "-",
            agentRunId: call.agentRunId ?? observation?.agentRunId ?? "-",
            provider: call.provider ?? observation?.provider ?? "-",
            model: call.model ?? observation?.model ?? "-",
            skillPath: observation?.skillPath,
            systemPrompt: call.systemPrompt ?? observation?.systemPrompt,
            userPrompt: call.userPrompt ?? observation?.userPrompt,
            modelCallCount: Math.max(call.callIndex ?? 0, observation?.modelCallCount ?? 0),
            usage: observation?.usage ?? {},
            tools: observation?.tools ?? []
          };
          assistantTurn.observation = observation;
          setRuntimePhase("模型调用中");
        }

        if (parsed.event === "model_usage" && observation) {
          observation = { ...observation, usage: mergeUsage(observation.usage, parsed.data as RuntimeUsage) };
          assistantTurn.observation = observation;
        }

        if (parsed.event === "thinking_delta") {
          const text = (parsed.data as { text?: string }).text ?? "";
          const last = steps.at(-1);
          if (last?.kind === "thinking" && last.status === "running") {
            last.text = `${last.text ?? ""}${text}`;
          } else {
            steps.push({ id: `thinking_${steps.length}`, kind: "thinking", label: "思考", text, status: "running" });
          }
          assistantTurn.steps = [...steps];
          render();
        }

        if (parsed.event === "thinking_end") {
          closeThinking();
          assistantTurn.steps = [...steps];
          render();
        }

        if (parsed.event === "tool_planned") {
          const tool = parsed.data as { toolCallId?: string; toolName?: string; summary?: string };
          upsertTool(tool.toolCallId ?? `tool_${steps.length}`, tool.toolName ?? "tool", tool.summary ?? "", "running");
          assistantTurn.text = "";
          render();
        }

        if (parsed.event === "tool_started") {
          const tool = parsed.data as Partial<RuntimeToolObservation>;
          const summary = (parsed.data as { summary?: string }).summary ?? "";
          upsertTool(tool.toolCallId ?? `tool_${steps.length}`, tool.toolName ?? "tool", summary, "running");
          assistantTurn.text = "";
          render();
          if (observation) {
            observation = {
              ...observation,
              tools: [...observation.tools.filter((item) => item.toolCallId !== tool.toolCallId), {
                toolCallId: tool.toolCallId ?? `tool_${observation.tools.length + 1}`,
                toolName: tool.toolName ?? "unknown",
                status: "running",
                args: tool.args
              }]
            };
            assistantTurn.observation = observation;
          }
          setRuntimePhase(tool.toolName === "read" ? "正在读取技能与参考文件" : `正在调用 ${tool.toolName ?? "工具"}`);
        }

        if (parsed.event === "tool_finished") {
          const tool = parsed.data as Partial<RuntimeToolObservation>;
          const step = steps.find((item) => item.id === tool.toolCallId);
          if (step) {
            step.status = tool.status === "failed" ? "failed" : "succeeded";
            step.detail = (parsed.data as { summary?: string }).summary ?? step.detail;
          }
          assistantTurn.steps = [...steps];
          render();
          if (observation) {
            observation = {
              ...observation,
              tools: observation.tools.map((item) => item.toolCallId === tool.toolCallId
                ? { ...item, status: tool.status === "failed" ? "failed" : "succeeded", resultPreview: tool.resultPreview }
                : item)
            };
            assistantTurn.observation = observation;
          }
          setRuntimePhase(tool.status === "succeeded" ? "资料查询完成" : "资料查询不可用");
        }

        if (parsed.event === "text_delta") {
          buffer += (parsed.data as { text?: string }).text ?? "";
          assistantTurn.text = buffer;
          render();
        }

        if (parsed.event === "result") {
          const nextAnswer = parsed.data as RuntimeAnswer;
          if (!isRuntimeAnswer(nextAnswer)) throw new Error("Agent Runtime 返回了无法识别的结果。");
          closeThinking();
          assistantTurn.text = nextAnswer.answerText;
          assistantTurn.steps = [...steps];
          assistantTurn.answer = nextAnswer;
          assistantTurn.observation = observation ?? undefined;
          render();
        }

        if (parsed.event === "error") {
          throw new Error((parsed.data as { message?: string }).message ?? "生成推荐失败。");
        }
      }
    } catch (caught) {
      const failure = caught instanceof Error ? caught.message : "生成推荐失败。";
      onErrorRef.current(failure);
      for (const step of steps) if (step.status === "running") step.status = "failed";
      assistantTurn.text = `这轮没有跑通：${failure}`;
      assistantTurn.steps = [...steps];
      assistantTurn.observation = observation ?? undefined;
      render();
    } finally {
      isSendingRef.current = false;
      setIsSending(false);
    }

    const finalTurns = [...base, userTurn, assistantTurn];
    const title = base.find((turn) => turn.role === "user")?.text.slice(0, 28) || trimmed.slice(0, 28);
    onPersistRef.current(activeConversationId, finalTurns, title);
  }, [conversationId, message, turns, userId]);

  return {
    message,
    setMessage,
    turns,
    conversationId,
    isSending,
    isHistorical,
    runtimePhase,
    startNewChat,
    loadConversation,
    submitMessage
  };
}
