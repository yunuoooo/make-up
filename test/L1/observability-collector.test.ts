import test from "node:test";
import assert from "node:assert/strict";
import { createTurnCollector } from "../../lib/observability/collector.ts";
import { parsePiJsonLine, redactSensitive } from "../../lib/pi/events.ts";
import type { Observation, ObservationType, TraceFields, TurnTrace } from "../../lib/observability/types.ts";

// redactSensitive 在首次调用时缓存进程环境里的密钥，注入必须发生在任何脱敏调用之前。
process.env.LOOKTRACE_OBSERVABILITY_TEST_API_KEY = "sk-observability-secret-1234";

/**
 * 记录型 sink：把观测调用原样记下来，测试不联网、不装 Langfuse。
 * 断言的是「交给 sink 的字段」，也就是真实实现会推给 Langfuse 的那一份。
 */
type Record_ = {
  name: string;
  type: ObservationType;
  created: TraceFields;
  updates: TraceFields[];
  endTime?: Date;
  ended: boolean;
  parent: Record_ | null;
  children: Record_[];
};

function recordingTrace() {
  const records: Record_[] = [];
  const flat: Record_[] = [];

  const make = (name: string, type: ObservationType, created: TraceFields, parent: Record_ | null): Record_ => {
    const record: Record_ = { name, type, created, updates: [], ended: false, parent, children: [] };
    records.push(record);
    flat.push(record);
    parent?.children.push(record);
    return record;
  };

  /** 真实现里 observation 的 id 是 OTel span id，这里只需要唯一。 */
  let idSeed = 0;
  const wrap = (record: Record_): Observation => ({
    id: `obs_${idSeed++}`,
    update(fields) {
      record.updates.push(fields);
    },
    end(endTime) {
      record.ended = true;
      record.endTime = endTime;
    },
    startObservation(name, fields, type) {
      return wrap(make(name, type ?? "span", fields, record));
    }
  });

  const root: TurnTrace = {
    ...wrap(make("looktrace.chat.turn", "agent", {}, null)),
    runContext: { traceId: "trace_test" }
  };

  const find = (name: string): Record_ => {
    const record = flat.find((item) => item.name === name);
    assert.ok(record, `expected an observation named ${name}, got: ${flat.map((item) => item.name).join(", ")}`);
    return record;
  };
  /** 某条 observation 上某个字段的最终值：创建时的值被后续 update 覆盖。 */
  const field = (name: string, key: keyof TraceFields): any => {
    const record = find(name);
    const merged = Object.assign({}, record.created, ...record.updates) as TraceFields;
    return merged[key];
  };
  const metadata = (name: string, key: string): any => {
    const record = find(name);
    const merged = Object.assign({}, record.created, ...record.updates) as TraceFields;
    return { ...(record.created.metadata ?? {}), ...(merged.metadata ?? {}) }[key];
  };
  /** 交给 sink 的全部内容（去掉树形指针，避免循环引用）。 */
  const texts = (): string =>
    JSON.stringify(flat.map(({ name, type, created, updates }) => ({ name, type, created, updates })));

  return { trace: root, records, flat, find, field, metadata, texts };
}

/** 可控时钟：时长断言不能靠真实墙钟。 */
function clock(start = 1_000_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    }
  };
}

const provider = "deepseek";
const model = "deepseek-chat";

function assistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    provider,
    model,
    content: [],
    usage: { input: 10, output: 2, totalTokens: 12, cacheRead: 3, cacheWrite: 0, reasoning: 1, cost: 0.000123 },
    stopReason: "toolUse",
    ...overrides
  };
}

test("maps pi events to a turn tree with real durations", () => {
  const sink = recordingTrace();
  const time = clock();
  // pi.run 由 bridge 在 spawn 之前开出，这里照样先开。
  const run = sink.trace.startObservation("pi.run", { metadata: { provider, model } }, "agent");
  const collector = createTurnCollector(sink.trace, { run, now: time.now, provider, model });

  collector.consume({ type: "agent_start" });
  collector.consume({ type: "turn_start", turnIndex: 0, timestamp: 1_758_500_000_000 });
  collector.consume({ type: "message_start", message: assistantMessage() });
  time.advance(1200);
  collector.consume({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "先读技能" } });
  time.advance(800);
  collector.consume({
    type: "message_update",
    usage: { input: 10, output: 2, totalTokens: 12, cacheRead: 3, cacheWrite: 0, reasoning: 1, cost: 0.000123 }
  });
  collector.consume({
    type: "message_end",
    message: assistantMessage({
      content: [{ type: "text", text: "先读技能" }, { type: "toolCall", id: "call_1", name: "read", arguments: { path: "SKILL.md" } }]
    })
  });
  time.advance(50);
  collector.consume({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: { path: "SKILL.md" } });
  time.advance(120);
  collector.consume({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    result: { content: [{ type: "text", text: "技能正文" }] },
    isError: false
  });
  time.advance(30);
  collector.consume({ type: "tool_execution_start", toolCallId: "call_2", toolName: "xhs_get_feed_detail", args: { feed_id: "feed_1" } });
  time.advance(45_000);
  collector.consume({
    type: "tool_execution_end",
    toolCallId: "call_2",
    toolName: "xhs_get_feed_detail",
    result: { content: [{ type: "text", text: "The operation was aborted due to timeout" }] },
    isError: true
  });
  time.advance(200);
  collector.consume({ type: "turn_end", turnIndex: 0 });
  collector.consume({ type: "agent_settled" });

  // 树形：pi.run 下面挂 pi.turn.0，turn 下面挂模型调用与工具。
  const runRecord = sink.find("pi.run");
  const turn = sink.find("pi.turn.0");
  assert.equal(turn.parent, runRecord);
  assert.deepEqual(turn.children.map((child) => child.name), ["model_call.0", "read", "xhs_get_feed_detail"]);
  assert.equal(turn.type, "agent");
  assert.equal(sink.find("model_call.0").type, "generation");
  assert.equal(sink.find("read").type, "tool");

  // turn_start 自带 pi 侧时间戳，直接当起点：这正是改造的第一个直接收益。
  assert.equal(turn.created.startTime?.getTime(), 1_758_500_000_000);
  assert.equal(sink.metadata("pi.turn.0", "piTimestamp"), 1_758_500_000_000);
  assert.equal(sink.metadata("pi.turn.0", "durationMs"), 47_400);

  // 模型调用：起点到终点 2000ms，首 token 在 1200ms。
  assert.equal(sink.metadata("model_call.0", "durationMs"), 2000);
  assert.equal(sink.metadata("model_call.0", "timeToFirstTokenMs"), 1200);
  assert.equal(sink.field("model_call.0", "completionStartTime") instanceof Date, true);
  assert.equal(sink.field("model_call.0", "model"), model);
  assert.deepEqual(sink.field("model_call.0", "usageDetails"), {
    input: 10,
    output: 2,
    total: 12,
    cache_read: 3,
    cache_write: 0,
    reasoning: 1
  });
  assert.deepEqual(sink.field("model_call.0", "costDetails"), { totalCost: 0.000123 });
  assert.equal(sink.metadata("model_call.0", "stopReason"), "toolUse");
  assert.deepEqual(sink.field("model_call.0", "output"), {
    text: "先读技能",
    toolCalls: [{ id: "call_1", name: "read", arguments: { path: "SKILL.md" } }]
  });

  // 工具：input 是脱敏后的 args，output 是全文，时长在 bridge 边界测。
  assert.deepEqual(sink.field("read", "input"), { path: "SKILL.md" });
  assert.deepEqual(sink.field("read", "output"), { content: [{ type: "text", text: "技能正文" }] });
  assert.equal(sink.metadata("read", "durationMs"), 120);
  assert.equal(sink.field("read", "level"), "DEFAULT");
  assert.equal(sink.field("read", "statusMessage"), undefined);

  // 45s 超时的那次一眼可见：时长 + ERROR + 失败原因摘要。
  assert.equal(sink.metadata("xhs_get_feed_detail", "durationMs"), 45_000);
  assert.equal(sink.field("xhs_get_feed_detail", "level"), "ERROR");
  assert.equal(sink.field("xhs_get_feed_detail", "statusMessage"), "请求超时");

  // turn 的 output 只放工具清单，正文不重复（正文已经全文记在各自的 tool 上）。
  assert.deepEqual(sink.field("pi.turn.0", "output"), {
    tools: [
      { name: "read", status: "succeeded", durationMs: 120, reason: undefined },
      { name: "xhs_get_feed_detail", status: "failed", durationMs: 45_000, reason: "请求超时" }
    ]
  });
  assert.equal(sink.field("read", "output") instanceof Object, true);
  assert.equal(turn.ended, true);
  assert.equal(sink.find("model_call.0").ended, true);
  assert.equal(sink.find("read").ended, true);
  assert.equal(runRecord.ended, false, "pi.run 到进程 close 才结束，agent_settled 不能提前截断");
});

test("counts unpaired ends instead of inventing observations", async () => {
  const sink = recordingTrace();
  const run = sink.trace.startObservation("pi.run", {}, "agent");
  const collector = createTurnCollector(sink.trace, { run, provider, model });

  // 没有对应 start 的 end：忽略、计数、不抛错。
  collector.consume({ type: "tool_execution_end", toolCallId: "ghost", toolName: "read", result: {}, isError: false });
  // 没有对应 start 的 turn_end 同理。
  collector.consume({ type: "turn_end", turnIndex: 7 });
  await collector.finish("succeeded");

  // 除了 pi.run 与根节点，没有凭空造出任何 observation。
  assert.deepEqual(sink.flat.map((item) => item.name), ["looktrace.chat.turn", "pi.run"]);
  assert.equal(sink.metadata("pi.run", "anomalies"), 2);
  assert.equal(sink.find("pi.run").ended, true);
  assert.deepEqual(sink.field("pi.run", "output"), { status: "succeeded", turns: 0, anomalies: 2 });});

test("closes dangling calls as warnings when the run is cut short", async () => {
  const sink = recordingTrace();
  const time = clock();
  const run = sink.trace.startObservation("pi.run", {}, "agent");
  const collector = createTurnCollector(sink.trace, { run, now: time.now });

  collector.consume({ type: "turn_start", turnIndex: 0, timestamp: 1_758_500_000_000 });
  collector.consume({ type: "message_start", message: assistantMessage() });
  collector.consume({ type: "tool_execution_start", toolCallId: "call_1", toolName: "xhs_search_feeds", args: { keyword: "韩系氧气妆" } });
  time.advance(30_000);
  // 用户取消：没有 turn_end / tool_execution_end。
  await collector.finish("cancelled");

  assert.equal(sink.field("xhs_search_feeds", "level"), "WARNING");
  assert.equal(sink.field("xhs_search_feeds", "statusMessage"), "未收到结束事件（cancelled）");
  assert.equal(sink.find("xhs_search_feeds").ended, true);
  assert.equal(sink.field("model_call.0", "level"), "WARNING");
  assert.equal(sink.field("pi.turn.0", "level"), "WARNING");
  assert.equal(sink.metadata("pi.turn.0", "durationMs"), 30_000);
  // 部分完成的 trace 保持部分完成，但 pi.run 仍按 WARNING 语义收尾。
  assert.deepEqual(sink.field("pi.run", "output"), { status: "cancelled", turns: 0, anomalies: 0 });
});

test("keeps full text: no truncation of tool results or assistant output", async () => {
  const sink = recordingTrace();
  const run = sink.trace.startObservation("pi.run", {}, "agent");
  const collector = createTurnCollector(sink.trace, { run });

  // 超过 SSE preview() 的 2400 字上限：trace 要的是全文。
  const noteBody = "笔".repeat(3000);
  const answerBody = "妆".repeat(2400);
  collector.consume({ type: "turn_start", turnIndex: 0, timestamp: 1_758_500_000_000 });
  collector.consume({ type: "message_start", message: assistantMessage() });
  collector.consume({
    type: "message_end",
    message: assistantMessage({ content: [{ type: "text", text: answerBody }] })
  });
  collector.consume({ type: "tool_execution_start", toolCallId: "call_1", toolName: "xhs_get_feed_detail", args: {} });
  collector.consume({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "xhs_get_feed_detail",
    result: { content: [{ type: "text", text: noteBody }] },
    isError: false
  });
  await collector.finish("succeeded");

  const toolOutput = sink.field("xhs_get_feed_detail", "output") as { content: Array<{ text: string }> };
  assert.equal(toolOutput.content[0].text.length, 3000, "工具结果必须是原文全长");
  assert.ok(!toolOutput.content[0].text.endsWith("…"), "不能被 preview() 截断");
  assert.equal((sink.field("model_call.0", "output") as { text: string }).text.length, 2400, "助手正文必须是原文全长");
});

test("only records shape and byte counts when content recording is off", async () => {
  const sink = recordingTrace();
  const run = sink.trace.startObservation("pi.run", {}, "agent");
  const collector = createTurnCollector(sink.trace, { run, includeContent: false });

  const noteBody = "笔".repeat(100);
  const result = { content: [{ type: "text", text: noteBody }] };
  collector.consume({ type: "turn_start", turnIndex: 0, timestamp: 1_758_500_000_000 });
  collector.consume({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: { path: "SKILL.md" } });
  collector.consume({ type: "tool_execution_end", toolCallId: "call_1", toolName: "read", result, isError: false });
  await collector.finish("succeeded");

  // 形状与字节数：够回答「看到了多少」，正文一个字都不落。
  const output = sink.field("read", "output") as { chars: number; bytes: number };
  assert.equal(output.chars, JSON.stringify(result).length);
  assert.equal(output.bytes, Buffer.byteLength(JSON.stringify(result), "utf8"));
  assert.equal(sink.texts().includes(noteBody), false);
  // 工具入参同样只留形状。
  assert.deepEqual(sink.field("read", "input"), { chars: JSON.stringify({ path: "SKILL.md" }).length, bytes: 19 });
});

test("hands no raw secret to the sink", async () => {
  const sink = recordingTrace();
  const run = sink.trace.startObservation("pi.run", {}, "agent");
  const collector = createTurnCollector(sink.trace, { run });

  // 走真实入口 parsePiJsonLine：观测消费的就是这一份脱敏后的事件，不另开未脱敏通路。
  const lines = [
    JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "xhs_search_feeds",
      args: { feed_url: "https://www.xiaohongshu.com/explore/abc?xsec_token=SECRET-xsec-value&xsec_source=pc_search" }
    }),
    JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "xhs_search_feeds",
      result: { content: [{ type: "text", text: 'Cookie: a1=SECRET-cookie-value; Authorization: Bearer SECRET-bearer-value' }] },
      isError: false
    }),
    JSON.stringify({
      type: "message_end",
      message: assistantMessage({
        content: [{ type: "text", text: "读取到 LOOKTRACE_OBSERVABILITY_TEST_API_KEY=sk-observability-secret-1234" }]
      })
    }),
    // 二维码 Base64 也不能进 trace。
    JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_2",
      toolName: "xhs_check_login_status",
      args: { qrcode: "data:image/png;base64,QRCODE-BASE64-PAYLOAD" }
    })
  ];
  collector.consume({ type: "turn_start", turnIndex: 0, timestamp: 1_758_500_000_000 });
  collector.consume({ type: "message_start", message: assistantMessage() });
  for (const line of lines) {
    const parsed = parsePiJsonLine(line);
    assert.ok(parsed);
    collector.consume(parsed);
  }
  await collector.finish("succeeded");

  const handed = sink.texts();
  for (const secret of [
    "SECRET-xsec-value",
    "SECRET-cookie-value",
    "SECRET-bearer-value",
    "sk-observability-secret-1234"
  ]) {
    assert.equal(handed.includes(secret), false, `观测字段里不该出现 ${secret}`);
  }
  assert.match(handed, /\[redacted\]/);

  // 出口兜底：真实现给 LangfuseSpanProcessor 传的 mask 就是它，再过一遍。
  assert.equal(String(redactSensitive("xsec_token=SECRET-xsec-value")).includes("SECRET-xsec-value"), false);
});

test("is inert and unthrowable when observability is off", async () => {
  // key 未配置：collector 是空实现，一次 observation 调用都不会发生。
  const collector = createTurnCollector(null);
  collector.consume({ type: "turn_start", turnIndex: 0, timestamp: 1 });
  collector.consume({ type: "tool_execution_end", toolCallId: "x", toolName: "read", result: {} });
  await collector.finish("succeeded");

  // 观测实现抛错也不能冒泡进请求路径，无论是 consume 还是 finish。
  const throwing: TurnTrace = {
    id: "boom",
    runContext: { traceId: "trace_boom" },
    update() {
      throw new Error("sink exploded");
    },
    end() {
      throw new Error("sink exploded");
    },
    startObservation() {
      throw new Error("sink exploded");
    }
  };
  const broken = createTurnCollector(throwing);
  assert.doesNotThrow(() => {
    broken.consume({ type: "turn_start", turnIndex: 0, timestamp: 1_758_500_000_000 });
    broken.consume({ type: "message_start", message: assistantMessage() });
    broken.consume({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: {} });
  });
  await assert.doesNotReject(() => broken.finish("succeeded"));

  // 注入会抛错的假 sink，collector 仍然把整轮跑完（runPiAgent 的收尾不会因此中断）。
  let flushed = 0;
  const flaky = createTurnCollector(throwing, {
    flush: async () => {
      flushed += 1;
      throw new Error("forceFlush exploded");
    }
  });
  flaky.consume({ type: "agent_start" });
  await assert.doesNotReject(() => flaky.finish("failed"));
  assert.equal(flushed, 1, "flush 仍被调用，但它的失败被吞掉");
});
