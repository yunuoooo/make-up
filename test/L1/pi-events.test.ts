import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSecretPattern,
  createPiEventMapper,
  parsePiJsonLine,
  redactSensitive,
  summarizeToolCall,
  summarizeToolResult,
  type PiRunContext
} from "../../lib/pi/events.ts";

// redactSensitive 在首次调用时缓存进程环境里的密钥，注入必须发生在任何脱敏调用之前。
process.env.LOOKTRACE_TEST_API_KEY = "sk-test-secret-abc12345";

const context: PiRunContext = {
  traceId: "trace_1",
  agentRunId: "run_1",
  conversationId: "conv_1",
  messageId: "msg_1",
  provider: "deepseek",
  model: "deepseek-chat",
  systemPrompt: "只做只读小红书研究。",
  userPrompt: "我想画韩系氧气妆"
};

test("parses only JSONL events and redacts sensitive MCP tokens", () => {
  assert.equal(parsePiJsonLine("Warning: startup"), null);
  assert.deepEqual(
    parsePiJsonLine('{"type":"tool_execution_end","result":{"text":"xsec_token=secret"}}'),
    { type: "tool_execution_end", result: { text: "xsec_token=[redacted]" } }
  );
  const escapedToolResult = JSON.stringify({
    type: "tool_execution_end",
    result: { content: [{ type: "text", text: '{"xsecToken": "secret", "id": "feed_1"}' }] }
  });
  const parsed = parsePiJsonLine(escapedToolResult);
  assert.equal(JSON.stringify(parsed).includes("secret"), false);
  assert.equal(JSON.stringify(parsed).includes("[redacted]"), true);
});

test("redacts sensitive values when the model repeats them in text", () => {
  const mapper = createPiEventMapper(context);
  assert.deepEqual(
    mapper.consume({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "xsec_token=secret" }
    }),
    [{ event: "text_delta", data: { text: "xsec_token=[redacted]" } }]
  );
});

test("redacts environment secrets the read tool could surface", () => {
  // read 没有路径限制，模型若读到 .env，密钥值不能在事件或答案里原样透出。
  const pattern = buildSecretPattern({
    DEEPSEEK_API_KEY: "sk-deepseek-secret-value",
    LANGFUSE_SECRET_KEY: "lf-secret-value-123"
  });
  assert.ok(pattern);
  const redactedText = "DEEPSEEK_API_KEY=sk-deepseek-secret-value 和 lf-secret-value-123"
    .replace(pattern, "[redacted]");
  assert.equal(redactedText.includes("sk-deepseek-secret-value"), false);
  assert.equal(redactedText.includes("lf-secret-value-123"), false);

  // 模型把 .env 内容读进回答时，密钥值同样不能原样透出。
  const leaked = String(redactSensitive("读到 LOOKTRACE_TEST_API_KEY=sk-test-secret-abc12345"));
  assert.equal(leaked.includes("sk-test-secret-abc12345"), false);
  assert.match(leaked, /\[redacted\]/);

  // 非密钥配置不参与脱敏，避免把正常内容也抹掉。
  assert.equal(buildSecretPattern({ PI_MODEL: "deepseek-chat", PI_PROVIDER: "deepseek" }), null);
  assert.equal(buildSecretPattern({ SHORT_SECRET: "abc" }), null);
});

test("maps Pi model and tool events to frontend-safe SSE events", () => {
  const mapper = createPiEventMapper(context);
  assert.deepEqual(
    mapper.consume({
      type: "message_start",
      message: {
        role: "assistant",
        provider: "deepseek",
        model: "deepseek-chat"
      }
    }),
    [{
      event: "model_call_started",
      data: {
        traceId: "trace_1",
        agentRunId: "run_1",
        provider: "deepseek",
        model: "deepseek-chat",
        callIndex: 1,
        systemPrompt: "只做只读小红书研究。",
        userPrompt: "我想画韩系氧气妆"
      }
    }]
  );

  assert.deepEqual(
    mapper.consume({
      type: "message_update",
      usage: { input: 8, output: 2, totalTokens: 10 },
      assistantMessageEvent: { type: "text_delta", delta: "你好" }
    }),
    [{ event: "text_delta", data: { text: "你好" } }, {
      event: "model_usage",
      data: { input: 8, output: 2, totalTokens: 10 }
    }]
  );

  assert.deepEqual(
    mapper.consume({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "xhs_search_notes",
      args: { keyword: "韩系氧气妆" }
    }),
    [{
      event: "tool_started",
      data: {
        toolCallId: "call_1",
        toolName: "xhs_search_notes",
        summary: "搜索「韩系氧气妆」",
        args: { keyword: "韩系氧气妆" }
      }
    }]
  );
});

test("streams the chain of thought and readable tool progress", () => {
  const mapper = createPiEventMapper(context);

  assert.deepEqual(
    mapper.consume({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "先读技能" } }),
    [{ event: "thinking_delta", data: { text: "先读技能" } }]
  );
  assert.deepEqual(
    mapper.consume({ type: "message_update", assistantMessageEvent: { type: "thinking_end", content: "先读技能" } }),
    [{ event: "thinking_end", data: {} }]
  );
  // toolcall_end 在工具执行前到达，先告诉用户准备做什么。
  assert.deepEqual(
    mapper.consume({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        toolCall: { id: "call_9", name: "read", arguments: { path: "/repo/skill/SKILL.md" } }
      }
    }),
    [{ event: "tool_planned", data: { toolCallId: "call_9", toolName: "read", summary: "读取 SKILL.md" } }]
  );
});

test("summarizes what the agent saw", () => {
  assert.equal(summarizeToolCall("xhs_get_note_detail", { noteId: "6a55ec72000000002103ddd5" }), "打开笔记 6a55ec72…");
  assert.equal(summarizeToolCall("xhs_source_status", {}), "检查数据源状态");
  // api 模式的受控形状。
  assert.equal(summarizeToolResult("xhs_search_notes", textResult(JSON.stringify({ notes: [{}, {}] }))), "返回 2 条笔记");
  assert.equal(
    summarizeToolResult("xhs_get_note_detail", textResult(JSON.stringify({ note: { title: "韩系氧气妆教程" } }))),
    "韩系氧气妆教程"
  );
  // mcp 回退链路仍是上游形状，两种都要认，否则切模式时过程区会退化成「2.0 KB」。
  assert.equal(summarizeToolResult("xhs_search_notes", textResult(JSON.stringify({ feeds: [{}, {}, {}] }))), "返回 3 条笔记");
  assert.equal(
    summarizeToolResult("xhs_get_note_detail", textResult(JSON.stringify({ data: { note: { title: "韩系氧气妆教程" } } }))),
    "韩系氧气妆教程"
  );
  // 工具层的拒绝不是故障：要显示成人话，不是「调用失败」。
  assert.equal(
    summarizeToolResult("xhs_search_notes", textResult(JSON.stringify({ reason: "quota-exhausted", message: "配额或余额不足" }))),
    "上游配额用尽"
  );
  assert.equal(
    summarizeToolResult("xhs_search_notes", textResult(JSON.stringify({ reason: "budget-exhausted", message: "已到上限" }))),
    "已到本轮取数上限"
  );
  assert.equal(
    summarizeToolResult("read", textResult("x".repeat(2048))),
    "2.0 KB"
  );
  assert.equal(
    summarizeToolResult("xhs_get_note_detail", textResult("The operation was aborted due to timeout"), true),
    "请求超时"
  );
  assert.equal(
    summarizeToolResult("xhs_get_note_detail", textResult("小红书取数配额或余额不足（上游 code=303）"), true),
    "上游配额用尽"
  );
  assert.equal(
    summarizeToolResult("xhs_get_note_detail", textResult("工具 get_feed_detail 执行时发生内部错误: context deadline exceeded"), true),
    "服务端超时"
  );
});

function textResult(text: string) {
  return { content: [{ type: "text", text }] };
}
