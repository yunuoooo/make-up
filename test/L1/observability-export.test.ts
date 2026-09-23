import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  flushObservability,
  initObservability,
  shutdownObservability,
  startTurnTrace
} from "../../lib/observability/langfuse.ts";
import { createTurnCollector } from "../../lib/observability/collector.ts";

/**
 * 用真实的 Langfuse SDK 打一遍本机的假 OTLP 端点：只走 loopback，不联网、不需要真 key。
 *
 * 这一层专门盯 adapter 与 SDK 的接缝——记录型 sink 只能证明「交给 sink 的字段」，
 * 证明不了「SDK 最后收到的字段」：`turn_start.timestamp` 被 SDK 的子节点方法丢掉过，
 * 就是靠这个测试发现的。
 *
 * 注意：观测是**进程级单例**（NodeSDK 只能注册一次全局 tracer provider），
 * 所以整个文件共用一次初始化，`shutdownObservability()` 只放在文件末尾。
 */

type CapturedSpan = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  start: number;
  end: number;
  attributes: Record<string, unknown>;
};

const bodies: unknown[] = [];
let server: Server;
let baseUrl = "";

before(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      try {
        bodies.push(JSON.parse(body));
      } catch {
        bodies.push(null);
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal(
    await initObservability({ publicKey: "pk-lf-l1", secretKey: "sk-lf-l1", baseUrl, environment: "test", includeContent: true }),
    true
  );
});

after(async () => {
  await shutdownObservability();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** 推一次尾批，把假端点收到的 span 摊平。断言要拿到数据，必须在这之后。 */
async function capture(): Promise<{ spans: CapturedSpan[]; posts: number }> {
  const seen = bodies.length;
  await flushObservability(5000);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const spans: CapturedSpan[] = [];
  for (const body of bodies.slice(seen)) {
    for (const resource of (body as any)?.resourceSpans ?? []) {
      for (const scope of resource.scopeSpans ?? []) {
        for (const span of scope.spans ?? []) {
          spans.push({
            name: span.name,
            traceId: span.traceId,
            spanId: span.spanId,
            ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
            start: Number(span.startTimeUnixNano) / 1e6,
            end: Number(span.endTimeUnixNano) / 1e6,
            attributes: Object.fromEntries(
              (span.attributes ?? []).map((attribute: any) => [
                attribute.key,
                attribute.value?.stringValue ?? attribute.value?.intValue ?? attribute.value?.boolValue
              ])
            )
          });
        }
      }
    }
  }
  return { spans, posts: bodies.length - seen };
}

test("exports one trace whose shape matches 5.1", async () => {
  const seed = "trace_1f0a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8";
  const trace = await startTurnTrace({ traceId: seed, userMessage: "我想画韩系氧气妆", conversationId: "conv_l1" });
  assert.ok(trace, "配了 key 就该拿到根 trace");

  // pi.run 在 spawn 之前开出，到进程 close 才结束。
  const run = trace.startObservation("pi.run", { metadata: { provider: "deepseek", model: "deepseek-chat" } }, "agent");
  let clock = 1_000_000;
  const collector = createTurnCollector(trace, { run, provider: "deepseek", model: "deepseek-chat", now: () => clock });

  // turn_start 的 pi 侧时间戳比 bridge 侧的现在早 30 秒：导出里必须照原样体现。
  const piTimestamp = Date.now() - 30_000;
  collector.consume({ type: "agent_start" });
  collector.consume({ type: "turn_start", turnIndex: 0, timestamp: piTimestamp });
  collector.consume({ type: "message_start", message: { role: "assistant", provider: "deepseek", model: "deepseek-chat" } });
  clock += 1_200;
  collector.consume({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "先读技能" } });
  clock += 800;
  collector.consume({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "deepseek",
      model: "deepseek-chat",
      stopReason: "toolUse",
      content: [{ type: "text", text: "我先读技能。" }, { type: "toolCall", id: "call_1", name: "read", arguments: { path: "SKILL.md" } }],
      usage: { input: 1200, output: 40, totalTokens: 1240, cacheRead: 900, cacheWrite: 0, reasoning: 12, cost: 0.00123 }
    }
  });
  collector.consume({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: { path: "SKILL.md" } });
  clock += 120;
  collector.consume({ type: "tool_execution_end", toolCallId: "call_1", toolName: "read", result: { content: [{ type: "text", text: "技能正文" }] }, isError: false });
  collector.consume({ type: "tool_execution_start", toolCallId: "call_2", toolName: "xhs_get_feed_detail", args: { feed_id: "feed_1" } });
  clock += 45_000;
  collector.consume({
    type: "tool_execution_end",
    toolCallId: "call_2",
    toolName: "xhs_get_feed_detail",
    result: { content: [{ type: "text", text: "The operation was aborted due to timeout" }] },
    isError: true
  });
  collector.consume({ type: "turn_end", turnIndex: 0 });
  collector.consume({ type: "agent_settled" });
  await collector.finish("succeeded");

  // 卡片补全发生在 pi 进程退出之后，是 pi.run 的**兄弟**而不是子节点（5.1）。
  await new Promise((resolve) => setTimeout(resolve, 20));
  const cards = trace.startObservation("taobao.cards", { input: { expected: 8 } }, "chain");
  const card = cards.startObservation("taobao.card 兰蔻|菁纯臻颜精华粉底液", {}, "span");
  // 上游调用挂在**发起它的那张卡片**之下：并发是 2，只有 owner 才分得清是谁发的。
  card.startObservation("taobao.search", { input: { keyword: "兰蔻 菁纯臻颜精华粉底液" } }, "tool").end();
  card.startObservation("taobao.detail", { input: { itemId: "1004620982324" } }, "tool").end();
  card.update({ metadata: { cacheHit: false, detailLevel: "search" } });
  card.end();
  cards.update({ output: { status: "partial", cardCount: 1, failed: [] } });
  cards.end();

  // 让「根比卡片阶段活得久」这件事有真实的间隔可测：OTel 的 end 时间在亚毫秒量级带抖动
  // （每个 span 各自对齐一次 performance 偏移），几毫秒的差距不足以稳定断言。
  await new Promise((resolve) => setTimeout(resolve, 20));
  trace.update({ output: { answer: "妆面建议……", cards: { status: "partial", cardCount: 1 } } });
  trace.end();

  const { spans } = await capture();
  const found = new Map(spans.map((span) => [span.name, span]));

  // §5.1 的树：根下面挂 pi.run 与 taobao.cards 两棵子树。
  assert.deepEqual(
    [...found.keys()].sort(),
    [
      "looktrace.chat.turn",
      "model_call.0",
      "pi.run",
      "pi.turn.0",
      "read",
      "taobao.card 兰蔻|菁纯臻颜精华粉底液",
      "taobao.cards",
      "taobao.detail",
      "taobao.search",
      "xhs_get_feed_detail"
    ].sort()
  );

  // 一棵 trace：所有 span 共用同一个 traceId。
  const root = found.get("looktrace.chat.turn")!;
  assert.equal(new Set(spans.map((span) => span.traceId)).size, 1);
  assert.match(root.traceId, /^[0-9a-f]{32}$/);
  // 这个 id 是从 SSE 那个 trace_<uuid> 派生出来的：前端拿到的 id 与 Langfuse 对得上。
  const { createTraceId } = await import("@langfuse/tracing");
  assert.equal(root.traceId, await createTraceId(seed));

  // 根被认成 app root，trace 的名字与 input/output 才是对的。
  assert.equal(root.attributes["langfuse.internal.is_app_root"], true);
  assert.equal(root.attributes["langfuse.observation.type"], "agent");
  assert.equal(root.attributes["langfuse.observation.input"], "我想画韩系氧气妆");
  assert.equal(root.attributes["langfuse.observation.metadata.traceId"], seed);
  assert.equal(root.attributes["langfuse.observation.metadata.conversationId"], "conv_l1");
  assert.match(String(root.attributes["langfuse.observation.output"]), /妆面建议/);
  // trace 级的 name/input/output 必须**显式**写在根 span 上：只靠 is_app_root 的话
  // 后端拿得到名字却拿不到 input/output，trace 列表里就是一条空记录（真实上报核过）。
  assert.equal(root.attributes["langfuse.trace.name"], "looktrace.chat.turn");
  assert.equal(root.attributes["langfuse.trace.input"], "我想画韩系氧气妆");
  assert.match(String(root.attributes["langfuse.trace.output"]), /妆面建议/);

  // 树形：turn 挂在 pi.run 下，模型调用与工具挂在 turn 下，卡片挂在 taobao.cards 下。
  const piRun = found.get("pi.run")!;
  const turn = found.get("pi.turn.0")!;
  const cardSpan = found.get("taobao.card 兰蔻|菁纯臻颜精华粉底液")!;
  assert.equal(piRun.parentSpanId, root.spanId);
  assert.equal(turn.parentSpanId, piRun.spanId);
  assert.equal(found.get("read")!.parentSpanId, turn.spanId);
  assert.equal(found.get("model_call.0")!.parentSpanId, turn.spanId);
  assert.equal(found.get("taobao.cards")!.parentSpanId, root.spanId, "taobao.cards 是 pi.run 的兄弟");
  assert.equal(cardSpan.parentSpanId, found.get("taobao.cards")!.spanId);
  assert.equal(found.get("taobao.search")!.parentSpanId, cardSpan.spanId);
  assert.equal(found.get("taobao.detail")!.parentSpanId, cardSpan.spanId);

  // 「答案什么时候可用看 pi.run，用户什么时候拿到全部内容看根」：根必须最后结束。
  assert.ok(found.get("taobao.cards")!.start >= piRun.end, "卡片阶段在 pi 进程退出之后");
  assert.ok(root.end >= found.get("taobao.cards")!.end, "根覆盖到卡片阶段结束");
  // 同一轮内的先后由事件顺序决定，但 OTel 的 end 时间在亚毫秒量级带抖动（整轮只有几毫秒），
  // 所以这里只留 2ms 容差——真正要钉住的是上面的父子结构。
  assert.ok(turn.end <= piRun.end + 2, "turn 在 pi.run 内结束");
  assert.ok(found.get("read")!.end <= turn.end + 2);
  assert.ok(found.get("model_call.0")!.end <= turn.end + 2);

  // §6.3：turn_start.timestamp 是 pi 侧起点，不能被 bridge 侧的到达时刻顶掉。
  assert.equal(Math.round(turn.start), piTimestamp);
  // 时长来自 bridge 边界：45s 那一次与 120ms 那一次一眼可分。
  // 注意 SDK 只让字符串原样通过，数字/布尔会被 JSON 序列化——metadata 里的数字到 Langfuse 就是字符串，
  // 按它聚合时要按字符串处理（span 自己的 duration 是数字，waterfall 用的是那个）。
  assert.equal(turn.attributes["langfuse.observation.metadata.durationMs"], "47120");
  assert.equal(found.get("read")!.attributes["langfuse.observation.metadata.durationMs"], "120");
  assert.equal(found.get("xhs_get_feed_detail")!.attributes["langfuse.observation.metadata.durationMs"], "45000");
  assert.equal(typeof turn.attributes["langfuse.observation.metadata.durationMs"], "string");

  // 失败工具带 ERROR 与失败原因；正文（input/output）是全文，不放 metadata。
  const failed = found.get("xhs_get_feed_detail")!;
  assert.equal(failed.attributes["langfuse.observation.level"], "ERROR");
  assert.equal(failed.attributes["langfuse.observation.status_message"], "请求超时");
  assert.match(String(failed.attributes["langfuse.observation.output"]), /aborted due to timeout/);
  assert.equal(failed.attributes["langfuse.observation.metadata.toolCallId"], "call_2");
  assert.equal(found.get("read")!.attributes["langfuse.observation.input"], '{"path":"SKILL.md"}');

  // 回退率可以从 card 的 metadata 直接统计（同样按字符串读）。
  assert.equal(cardSpan.attributes["langfuse.observation.metadata.detailLevel"], "search");
  assert.equal(cardSpan.attributes["langfuse.observation.metadata.cacheHit"], "false");

  // usage / cost 的两组 key：币种与 cache 列以真实上报核对（6.4）。
  const generation = found.get("model_call.0")!;
  assert.deepEqual(JSON.parse(String(generation.attributes["langfuse.observation.usage_details"])), {
    input: 1200,
    output: 40,
    total: 1240,
    cache_read: 900,
    cache_write: 0,
    reasoning: 12
  });
  assert.deepEqual(JSON.parse(String(generation.attributes["langfuse.observation.cost_details"])), { totalCost: 0.00123 });
  assert.equal(generation.attributes["langfuse.observation.model.name"], "deepseek-chat");
  assert.ok(String(generation.attributes["langfuse.observation.completion_start_time"]).length > 0);

  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:/);
});

test("masks the exit and never uploads base64 media", async () => {
  const trace = await startTurnTrace({ traceId: "trace_mask_check", userMessage: "我想画韩系氧气妆" });
  assert.ok(trace);
  const run = trace.startObservation("pi.run", {}, "agent");
  const collector = createTurnCollector(trace, { run });

  // 走真实入口脱敏，再喂给真 SDK：出口的 mask 是第二层。
  const { parsePiJsonLine } = await import("../../lib/pi/events.ts");
  for (const line of [
    JSON.stringify({ type: "turn_start", turnIndex: 0, timestamp: Date.now() }),
    JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "xhs_check_login_status",
      args: { qrcode: "data:image/png;base64,QRCODE-BASE64-PAYLOAD-SHOULD-NOT-BE-UPLOADED" }
    }),
    JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "xhs_check_login_status",
      result: { content: [{ type: "text", text: "Authorization: Bearer sk-live-secret-value-xyz" }] },
      isError: false
    }),
    JSON.stringify({ type: "turn_end", turnIndex: 0 })
  ]) {
    const parsed = parsePiJsonLine(line);
    assert.ok(parsed);
    collector.consume(parsed);
  }
  await collector.finish("succeeded");
  trace.end();

  const { spans } = await capture();
  const dumped = JSON.stringify(spans);
  assert.equal(dumped.includes("sk-live-secret-value-xyz"), false, "Bearer 值不能进任何上报字段");
  assert.equal(dumped.includes("[redacted]"), true, "入口脱敏必须留下可辨认的替换标记");
  assert.equal(spans.some((span) => span.name === "xhs_check_login_status"), true);
});
