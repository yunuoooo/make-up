import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  includeContentEnabled,
  initObservability,
  isObservabilityEnabled,
  readObservabilityConfig,
  createLangfuseTurnTrace,
  startTurnTrace
} from "../../lib/observability/langfuse.ts";

/**
 * 降级约定与 TAOBAO_API_TOKEN 一致：没配 key 就完全不上报。
 * 这里断言的是「零调用」——不发请求、不抛错、不打印假数据。
 */

/** 任何一次网络调用都会让这个 stub 抛错，于是「零调用」是被强制的。 */
function forbidNetwork(): () => number {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error("观测层不该发任何请求");
  }) as typeof fetch;
  process.on("exit", () => {
    globalThis.fetch = original;
  });
  return () => calls;
}

test("reads the Langfuse config from the environment", () => {
  // 两个 key 缺一个就整条观测链关闭，不是「只记一半」。
  assert.equal(readObservabilityConfig({}), null);
  assert.equal(readObservabilityConfig({ LANGFUSE_PUBLIC_KEY: "pk_test" }), null);
  assert.equal(readObservabilityConfig({ LANGFUSE_SECRET_KEY: "sk_test" }), null);
  assert.equal(readObservabilityConfig({ LANGFUSE_PUBLIC_KEY: "  ", LANGFUSE_SECRET_KEY: "sk_test" }), null);

  const config = readObservabilityConfig({ LANGFUSE_PUBLIC_KEY: "pk_test", LANGFUSE_SECRET_KEY: "sk_test" });
  assert.equal(config?.publicKey, "pk_test");
  assert.equal(config?.secretKey, "sk_test");
  assert.equal(config?.baseUrl, "https://cloud.langfuse.com");
  assert.equal(config?.includeContent, true);

  const custom = readObservabilityConfig({
    LANGFUSE_PUBLIC_KEY: "pk_test",
    LANGFUSE_SECRET_KEY: "sk_test",
    LANGFUSE_BASE_URL: "https://langfuse.internal/",
    LANGFUSE_TRACING_ENVIRONMENT: "staging",
    LANGFUSE_RELEASE: "abc1234",
    LANGFUSE_TRACE_INCLUDE_CONTENT: "false"
  });
  assert.equal(custom?.baseUrl, "https://langfuse.internal", "尾斜杠要去掉");
  assert.equal(custom?.environment, "staging");
  assert.equal(custom?.release, "abc1234");
  assert.equal(custom?.includeContent, false);
});

test("content recording is on unless explicitly turned off", () => {
  assert.equal(includeContentEnabled({}), true);
  assert.equal(includeContentEnabled({ LANGFUSE_TRACE_INCLUDE_CONTENT: "true" }), true);
  assert.equal(includeContentEnabled({ LANGFUSE_TRACE_INCLUDE_CONTENT: "FALSE" }), false);
  assert.equal(includeContentEnabled({ LANGFUSE_TRACE_INCLUDE_CONTENT: " false " }), false);
  // 只认 false：写错的开关不该把正文悄悄丢掉。
  assert.equal(includeContentEnabled({ LANGFUSE_TRACE_INCLUDE_CONTENT: "0" }), true);
});

test("key 未配置时零调用、零抛错", async () => {
  const fetchCalls = forbidNetwork();
  const keys = ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"];
  const saved = keys.map((key) => process.env[key]);
  for (const key of keys) delete process.env[key];

  try {
    assert.equal(await initObservability(), false, "没配 key 就不该起 SDK");
    assert.equal(isObservabilityEnabled(), false);
    // 根 trace 直接是 null：调用方拿到它就什么都不做。
    assert.equal(await startTurnTrace({ traceId: "trace_x", userMessage: "我想画韩系氧气妆" }), null);
    assert.equal(fetchCalls(), 0);
  } finally {
    keys.forEach((key, index) => {
      const value = saved[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});

test("passes startTime and the parent context down to the SDK", () => {
  // 假 SDK：只记下每个 observation 收到的 name / attributes / options。
  const calls: Array<{ name: string; attributes: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const traceIO: Array<{ spanId: string; fields: any }> = [];
  const fakeApi = {
    startObservation(name: string, attributes: Record<string, unknown>, options: Record<string, unknown>) {
      calls.push({ name, attributes, options });
      const spanId = `span_${calls.length}`;
      return {
        id: spanId,
        otelSpan: { spanContext: () => ({ traceId: "trace_hex", spanId, traceFlags: 1 }) },
        update: () => undefined,
        end: () => undefined,
        setTraceIO: (fields: unknown) => void traceIO.push({ spanId, fields })
      };
    }
  };
  const root = fakeApi.startObservation("looktrace.chat.turn", {}, { asType: "agent" });
  const trace = createLangfuseTurnTrace(root, fakeApi, "trace_seed", "conv_1");

  const piTurn = trace.startObservation("pi.turn.0", {}, "agent");
  const piStartedAt = new Date(1_758_500_000_000);
  const modelCall = piTurn.startObservation("model_call.0", { model: "deepseek-chat", startTime: piStartedAt }, "generation");

  assert.equal(trace.runContext.traceId, "trace_seed");
  assert.equal(trace.runContext.conversationId, "conv_1");

  // SDK 那层 observation.startObservation() 会把 startTime 丢掉，所以必须走模块级 API。
  const turnCall = calls[1];
  assert.equal(turnCall.name, "pi.turn.0");
  assert.equal(turnCall.options.asType, "agent");
  // 父上下文显式传下去：没有它，子节点会掉到根上，树就散了。
  assert.deepEqual(turnCall.options.parentSpanContext, { traceId: "trace_hex", spanId: "span_1", traceFlags: 1 });

  const callCall = calls[2];
  assert.equal(callCall.name, "model_call.0");
  assert.equal(callCall.options.asType, "generation");
  assert.equal(callCall.options.startTime, piStartedAt, "turn_start.timestamp 必须一路传到 SDK");
  assert.deepEqual(callCall.attributes, { model: "deepseek-chat" }, "startTime 是创建选项，不能当成 attribute 再塞一遍");
  assert.deepEqual(callCall.options.parentSpanContext, { traceId: "trace_hex", spanId: "span_2", traceFlags: 1 });
  assert.equal(modelCall.id, "span_3");

  // 根 observation 的 input/output 必须额外写成 trace 级属性，否则 trace 列表里是空的。
  trace.update({ output: { answer: "妆面建议" } });
  assert.equal(traceIO.length, 1);
  assert.equal(traceIO[0].spanId, "span_1", "只有根节点镜像 trace 级 I/O");
  assert.deepEqual(traceIO[0].fields, { output: { answer: "妆面建议" } });
  piTurn.update({ output: "子节点不该镜像" });
  assert.equal(traceIO.length, 1);
});

test("drops undefined fields instead of writing them as empty", () => {
  const calls: Array<{ name: string; attributes: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const fakeApi = {
    startObservation(name: string, attributes: Record<string, unknown>, options: Record<string, unknown>) {
      calls.push({ name, attributes, options });
      return {
        id: "span_x",
        otelSpan: { spanContext: () => ({ traceId: "t", spanId: "s", traceFlags: 1 }) },
        update: () => undefined,
        end: () => undefined
      };
    }
  };
  const trace = createLangfuseTurnTrace(fakeApi.startObservation("root", {}, {}), fakeApi, "trace_seed");
  trace.startObservation("read", { input: { path: "SKILL.md" }, statusMessage: undefined }, "tool");

  assert.deepEqual(calls[1].attributes, { input: { path: "SKILL.md" } });
});

/**
 * dev 下 `/instrumentation` 的 edge 编译单元会静态解析整条 OTel 链，而 edge 里没有
 * `stream`/`fs`，解析失败会让服务器起不来（`Can't resolve 'stream'`）。
 * 现在的处理是：next.config.mjs 在 edge 编译里把 OTel 入口 alias 成空模块，
 * 而这条 alias 成立的前提是 register() 先按 runtime 挡住。
 * 守卫没了 = edge 下拿到空对象，比编译不过更难查，所以在这里钉住两者的配对。
 */
test("keeps the observability import behind the Node runtime guard", async () => {
  const instrumentation = await readFile("instrumentation.ts", "utf8");
  const guard = instrumentation.indexOf('NEXT_RUNTIME !== "nodejs"');
  const load = instrumentation.indexOf('import("./lib/observability/langfuse.ts")');

  assert.notEqual(guard, -1, "instrumentation 必须先判 runtime");
  assert.notEqual(load, -1, "观测入口应通过动态 import 加载");
  assert.ok(load > guard, "判定 runtime 之前不能加载观测模块");

  const config = await readFile("next.config.mjs", "utf8");
  assert.match(config, /nextRuntime === "edge"/, "edge 编译必须被显式处理");
  // 链上的入口都要指向空模块，漏一个就会重新出现解析失败。
  for (const pkg of ["@opentelemetry/sdk-node", "@langfuse/otel", "@langfuse/tracing"]) {
    assert.ok(config.includes(`"${pkg}": false`), `${pkg} 在 edge 下应指向空模块`);
  }
});
