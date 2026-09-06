import test from "node:test";
import assert from "node:assert/strict";

const enabled = process.env.RUN_L3_E2E === "1";
const baseUrl = process.env.RUNTIME_BASE_URL ?? "http://localhost:3000";

test("L3 calls the running Python Agents runtime API", { skip: !enabled }, async () => {
  assert.ok(process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY, "a model API key is required for L3");
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "请调用 mock_lookup 查询通勤妆参考，然后根据工具结果回答。" })
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  const text = await response.text();
  const events = text.split("\n\n").map(parseBlock).filter(Boolean) as Array<{ event: string; data: any }>;
  assert.ok(events.some((event) => event.event === "run_started"));
  assert.ok(events.some((event) => event.event === "status"));
  const result = events.find((event) => event.event === "result");
  assert.ok(result, "runtime API must emit a result event");
  assert.equal(typeof result.data.answerText, "string");
  assert.equal(result.data.answer.schema_version, "looktrace.answer.v1");
  assert.equal(typeof result.data.run.traceId, "string");
  assert.equal(typeof result.data.run.agentRunId, "string");
  assert.equal(text.includes("OPENAI_API_KEY"), false);
});

function parseBlock(block: string): { event: string; data: any } | null {
  const event = block.match(/^event: (.+)$/m)?.[1];
  const data = block.match(/^data: (.+)$/m)?.[1];
  if (!event || !data) return null;
  return { event, data: JSON.parse(data) };
}
