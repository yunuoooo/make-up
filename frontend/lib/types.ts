import type { AgentAnswer, UserProduct } from "@/lib/types/domain";

export type RuntimeAnswerStatus = "succeeded" | "degraded" | "clarification" | "failed" | "cancelled" | "limit_exceeded";

export type RuntimeAnswer = {
  answerText: string;
  status: RuntimeAnswerStatus;
  answer?: {
    schema_version: "looktrace.answer.v1";
    status: RuntimeAnswerStatus;
    answer_text: string;
    [key: string]: unknown;
  };
  run: {
    traceId: string;
    agentRunId: string;
    conversationId: string;
    messageId: string;
  };
};

export function isRuntimeAnswer(value: unknown): value is RuntimeAnswer {
  if (!value || typeof value !== "object") return false;
  const answer = value as Partial<RuntimeAnswer>;
  const run = answer.run;
  return typeof answer.answerText === "string"
    && typeof answer.status === "string"
    && !!run
    && typeof run === "object"
    && typeof run.traceId === "string"
    && typeof run.agentRunId === "string"
    && typeof run.conversationId === "string"
    && typeof run.messageId === "string";
}

export type Turn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  answer?: AgentAnswer | RuntimeAnswer;
};

export type ProductFormState = {
  brand: string;
  name: string;
  category: string;
  shade: string;
  colorFamily: string;
  finish: string;
  texture: string;
  effectTags: string;
  notes: string;
};

export type ProductFormChange = (field: keyof ProductFormState, value: string) => void;

export type ProductSelection = UserProduct | null;
