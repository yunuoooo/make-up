import test from "node:test";
import assert from "node:assert/strict";
import { isRuntimeAnswer, type RuntimeAnswer } from "../../frontend/lib/types.ts";

test("runtime answers are recognized without being treated as domain AgentAnswer", () => {
  const answer: RuntimeAnswer = {
    answerText: "根据查询结果，建议轻薄底妆。",
    status: "succeeded",
    run: {
      traceId: "trace_1",
      agentRunId: "agent_1",
      conversationId: "conv_1",
      messageId: "msg_1"
    }
  };
  assert.equal(isRuntimeAnswer(answer), true);
  assert.equal(isRuntimeAnswer({ answerText: "old", conversationId: "conv_1" }), false);
});
