import { redactSensitive } from "../pi/events.ts";
import type { Observation, TraceFields, TurnTrace } from "./types.ts";

/**
 * Langfuse 实现：NodeSDK 单例 + 手动 startObservation。
 *
 * 为什么是手动埋点而不是自动埋点：模型调用发生在 pi **子进程**里，
 * `@langfuse/openai` 之类的包装器包不到它；pi 的 JSON 事件流才是唯一事实来源。
 *
 * 降级约定与 TAOBAO_API_TOKEN 一致：两个 key 没配就完全不上报——不发请求、不抛错、
 * 不打印假数据。Langfuse 挂掉、慢、没配 key，产品请求都照常返回。
 */

const DEFAULT_BASE_URL = "https://cloud.langfuse.com";
/** forceFlush 的上限：Langfuse 慢不能让请求挂着。 */
const DEFAULT_FLUSH_TIMEOUT_MS = 2000;

export type ObservabilityConfig = {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  environment?: string;
  release?: string;
  /** false 时只记形状与字节数。 */
  includeContent: boolean;
};

/** 两个 key 都在才算配置好；缺一个就整条观测链安静关闭。 */
export function readObservabilityConfig(env: Record<string, string | undefined> = process.env): ObservabilityConfig | null {
  const publicKey = (env.LANGFUSE_PUBLIC_KEY ?? "").trim();
  const secretKey = (env.LANGFUSE_SECRET_KEY ?? "").trim();
  if (!publicKey || !secretKey) return null;
  return {
    publicKey,
    secretKey,
    baseUrl: (env.LANGFUSE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    environment: (env.LANGFUSE_TRACING_ENVIRONMENT ?? "").trim() || undefined,
    release: (env.LANGFUSE_RELEASE ?? "").trim() || undefined,
    includeContent: includeContentEnabled(env)
  };
}

/** 内容开关独立于 key：没配 key 时读它也没有意义，但读法要一致。 */
export function includeContentEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.LANGFUSE_TRACE_INCLUDE_CONTENT ?? "true").trim().toLowerCase() !== "false";
}

type ObservabilityState = {
  processor: { forceFlush(): Promise<void> } | null;
  sdk: { shutdown(): Promise<void> } | null;
  started: boolean;
};

/** dev 的 HMR 会重复求值模块，进程级只能初始化一次。 */
const GLOBAL_KEY = "__looktraceObservability";
type GlobalWithState = typeof globalThis & { [GLOBAL_KEY]?: ObservabilityState };

function state(): ObservabilityState {
  const scope = globalThis as GlobalWithState;
  if (!scope[GLOBAL_KEY]) scope[GLOBAL_KEY] = { processor: null, sdk: null, started: false };
  return scope[GLOBAL_KEY];
}

/**
 * 起 NodeSDK + LangfuseSpanProcessor 单例。由 instrumentation.ts 调用；
 * 重复调用是幂等的。
 */
export async function initObservability(
  config?: ObservabilityConfig | null,
  env: Record<string, string | undefined> = process.env
): Promise<boolean> {
  const current = state();
  if (current.started) return current.processor !== null;
  current.started = true;

  const resolved = config ?? readObservabilityConfig(env);
  if (!resolved) return false;

  try {
    const [{ NodeSDK }, { LangfuseSpanProcessor }] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@langfuse/otel")
    ]);

    const processor = new LangfuseSpanProcessor({
      publicKey: resolved.publicKey,
      secretKey: resolved.secretKey,
      baseUrl: resolved.baseUrl,
      ...(resolved.environment ? { environment: resolved.environment } : {}),
      ...(resolved.release ? { release: resolved.release } : {}),
      exportMode: "batched",
      // 出口兜底：入口已经脱敏过一次，这里再过一遍，防止后加字段绕过入口。
      // 注意 SDK 只对 input/output 调用 mask；metadata 走的是扁平 key，不在覆盖范围内，
      // 所以内容纪律必须靠「正文只放 input/output」这条，而不是靠这里。
      mask: ({ data }: { data: unknown }) => redactSensitive(data),
      // 二维码/内联图片的 base64 不得被抽取上传。
      mediaUploadEnabled: false
    });

    const sdk = new NodeSDK({ serviceName: "looktrace-mvp", spanProcessors: [processor] });
    sdk.start();
    current.processor = processor;
    current.sdk = sdk;
    return true;
  } catch (error) {
    // 版本/打包问题不该让请求挂掉：降级为 no-op，只留一条 warn。
    console.warn("[observability] Langfuse 初始化失败，本轮起改为不上报：", error instanceof Error ? error.message : error);
    return false;
  }
}

export function isObservabilityEnabled(): boolean {
  return state().processor !== null;
}

/** 推尾批，带上限超时。任何时候都不抛错。 */
export async function flushObservability(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
  const processor = state().processor;
  if (!processor) return;
  try {
    await Promise.race([
      processor.forceFlush(),
      new Promise<void>((resolveTimeout) => {
        const timer = setTimeout(resolveTimeout, timeoutMs);
        timer.unref?.();
      })
    ]);
  } catch {
    // 推不上去只丢观测数据，不影响产品请求。
  }
}

/** 进程退出钩子用得上；正常请求路径不需要。 */
export async function shutdownObservability(): Promise<void> {
  const current = state();
  try {
    await current.processor?.forceFlush();
    await current.sdk?.shutdown();
  } catch {
    // 同上。
  } finally {
    current.processor = null;
    current.sdk = null;
    current.started = false;
  }
}

/**
 * 开一棵根 trace。返回 null 表示本轮不上报（没配 key / 初始化失败）——
 * 调用方拿到 null 就什么都不做：一条 observation、一次网络调用都不会发生。
 */
export async function startTurnTrace(input: {
  traceId: string;
  userMessage: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
}): Promise<TurnTrace | null> {
  if (!state().started) await initObservability();
  if (!state().processor) return null;

  try {
    const tracing = await import("@langfuse/tracing");
    // trace_<uuid> 在 SSE、Langfuse、服务端日志三处是同一个实体。
    const traceId = await tracing.createTraceId(input.traceId);
    const root = tracing.startObservation("looktrace.chat.turn", {
      input: input.userMessage,
      metadata: {
        traceId: input.traceId,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...input.metadata
      }
    }, {
      asType: "agent",
      parentSpanContext: { traceId, spanId: randomSpanId(), traceFlags: 1 }
    });
    // trace 的**名字**必须显式写。TS SDK 只打 `langfuse.internal.is_app_root`，后端据此
    // 能把 span 名当成 trace 名，但**不会**提升 input/output；Python SDK 打的是
    // `langfuse.internal.as_root`，两者不是一回事（已用真实上报逐一核对）。少写 name，
    // trace 列表里就是一条无名记录，得点进去才看得见内容。
    root.otelSpan.setAttributes({
      [tracing.LangfuseOtelSpanAttributes.TRACE_NAME]: TRACE_NAME
    });
    // input 和 name 一样得在建的时候就写一份 trace 级的；output 要到收尾才知道，
    // 由 createLangfuseTurnTrace 的 update 镜像过去。
    root.setTraceIO({ input: input.userMessage });
    return createLangfuseTurnTrace(root, tracing, input.traceId, input.conversationId);
  } catch (error) {
    console.warn("[observability] 建 trace 失败，本轮改为不上报：", error instanceof Error ? error.message : error);
    return null;
  }
}

/** 根 observation 的名字，也是 trace 的名字。 */
export const TRACE_NAME = "looktrace.chat.turn";

/** 16 位小写 hex，OTel 的 span id 格式。 */
export function randomSpanId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 把 Langfuse 的 observation 包成本项目的 `Observation`。
 *
 * 两处偏离 SDK 默认行为，都是被真实上报逼出来的：
 *
 * 1. 子节点走**模块级**的 `api.startObservation` 而不是 SDK 那层 `observation.startObservation()`
 *    方法：后者只转发 `asType` 与父上下文，会把 `startTime` 直接丢掉——而 `pi.turn.N` 的起点
 *    必须用 `turn_start.timestamp`（6.3），丢了就只能退化成「bridge 收到事件的时刻」。
 *    这里显式带上 `parentSpanContext`（效果与 SDK 内部一致），另外把 startTime 传下去。
 * 2. 根节点的 input/output 额外用 `setTraceIO` 写一份 **trace 级**属性：`is_app_root` 不带这两个，
 *    不写的话 trace 列表里 input/output 是空的，只有点进根 observation 才看得到。
 *
 * 导出是为了让 L1 测试用一个假 SDK 钉住这些转发行为——不需要真 key、不发请求。
 */
export function createLangfuseTurnTrace(root: any, api: any, traceId: string, conversationId?: string): TurnTrace {
  const wrap = (observation: any, isRoot = false): Observation => ({
    id: String(observation.id ?? ""),
    update(fields) {
      observation.update(definedFields(fields));
      if (isRoot) mirrorTraceIO(observation, fields);
    },
    end(endTime) {
      observation.end(endTime);
    },
    startObservation(name, fields, type) {
      const { startTime } = fields;
      return wrap(api.startObservation(name, definedFields(fields), {
        asType: type ?? "span",
        parentSpanContext: observation.otelSpan.spanContext(),
        ...(startTime ? { startTime } : {})
      }));
    }
  });
  const wrapped = wrap(root, true);
  return {
    ...wrapped,
    runContext: { traceId, ...(conversationId ? { conversationId } : {}) }
  };
}

/** 根 observation 的 input/output 就是 trace 的 input/output。 */
function mirrorTraceIO(observation: any, fields: TraceFields): void {
  if (fields.input === undefined && fields.output === undefined) return;
  observation.setTraceIO(definedFields({ input: fields.input, output: fields.output }));
}

/** 丢掉 undefined 与 startTime（创建选项，更新时无意义）。 */
function definedFields(fields: TraceFields): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || key === "startTime") continue;
    output[key] = value;
  }
  return output;
}
