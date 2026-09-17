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

export type RuntimeUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: unknown;
};

export type RuntimeToolObservation = {
  toolCallId: string;
  toolName: string;
  status: "running" | "succeeded" | "failed";
  args?: unknown;
  resultPreview?: string;
};

export type RuntimeObservation = {
  traceId: string;
  agentRunId: string;
  provider: string;
  model: string;
  /** pi 通过 --skill 加载的技能目录；agent 的行为来自该技能而非系统提示词。 */
  skillPath?: string;
  systemPrompt?: string;
  userPrompt?: string;
  modelCallCount: number;
  usage: RuntimeUsage;
  tools: RuntimeToolObservation[];
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

export type RuntimeStepKind = "thinking" | "narration" | "tool";

/** 一条过程记录：Pi 的思考、模型的旁白，或一次工具调用。 */
export type RuntimeStep = {
  id: string;
  kind: RuntimeStepKind;
  label: string;
  detail?: string;
  status: "running" | "succeeded" | "failed";
  text?: string;
};

export type Turn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  steps?: RuntimeStep[];
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
