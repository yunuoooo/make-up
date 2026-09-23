import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import {
  createPiEventMapper,
  extractAssistantText,
  parsePiJsonLine,
  redactSensitive,
  type AppSseEvent,
  type PiRunContext
} from "./events.ts";
import { findSessionFile, isValidSessionId } from "./session.ts";
import { createTurnCollector } from "../observability/collector.ts";
import { flushObservability, includeContentEnabled } from "../observability/langfuse.ts";
import type { TurnTrace } from "../observability/types.ts";

export type PiBridgeOptions = {
  prompt: string;
  extensionPath?: string;
  skillPath?: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  piBin?: string;
  cwd?: string;
  /**
   * 会话键：pi 用它 resume-or-create 同一份会话文件，第二阶段的追问因此能看到
   * 第一阶段的研究结论（spec `09-23-conversation-sessions.md`）。
   * 缺失或不合法时退回单轮无状态（`--no-session`），不会自造一个每次都不同的 id。
   */
  conversationId?: string;
  /**
   * 由调用方预生成，好让观测层在 spawn 之前就建好根 trace。
   * 不传则自行生成（单独用 bridge 时用得上）。
   */
  traceId?: string;
  /** 根 observation。为 null / 省略表示本轮不上报。 */
  trace?: TurnTrace | null;
  signal?: AbortSignal;
};

export type PiBridgeResult = {
  answerText: string;
  status: "succeeded" | "failed" | "cancelled";
  run: Pick<PiRunContext, "traceId" | "agentRunId" | "conversationId" | "messageId">;
  provider: string;
  model: string;
  exitCode: number | null;
};

export type PiEventSink = (event: AppSseEvent) => void | Promise<void>;

// Skill 是行为的唯一来源：研究流程、输出格式和边界都写在 SKILL.md 及其 references 里，
// 这里只保留运行时约束（可用工具、只读边界、脱敏），不重复技能内容。
const DEFAULT_SYSTEM_PROMPT = `你是运行在 Pi Agent 中的小红书妆容研究助手。
可用工具只有 \`read\`（读取技能与参考文件）和只读的 \`xhs_*\` 小红书数据源工具；没有 bash、编辑、写入或发布工具。
\`read\` 只用于读取技能目录内的 SKILL.md、references/ 和 scripts/；不要读取 .env、密钥、Cookie、凭据或仓库里的其他文件，也不要把它们写进回答。
每个请求都先按 <available_skills> 里的 location 用 \`read\` 读取匹配技能的 SKILL.md，再严格按该技能的工作流、输出格式和边界执行；技能内容与系统提示词冲突时以技能为准。技能引用的相对路径（references/、scripts/）按 SKILL.md 所在目录解析后再读取。
回答用中文，只把工具实际返回的内容当作证据，说明真实样本量和失败限制；不要泄露 xsec_token、Cookie、Authorization、API token 或完整请求 URL。笔记配图只使用工具返回的图片地址，不要自己拼链接或补签名参数。`;

// pi 通过内置 read 工具按需加载 SKILL.md；白名单里没有 read，技能就无法进入上下文。
// 工具名与数据源解耦：切换 XHS_SOURCE_MODE 时这份白名单不需要改。
const READ_ONLY_TOOL_ALLOWLIST = "read,xhs_source_status,xhs_search_notes,xhs_get_note_detail";

const DEFAULT_SKILL_PATH = "xiaohongshu-makeup-advisor-latest";

// pi 是项目依赖（@earendil-works/pi-coding-agent），二进制装在 node_modules/.bin；
// 不依赖全局安装或用户目录下的 pi，服务器上 npm install 后即可用。
const DEFAULT_PI_STATE_DIR = ".local-data/pi";

export function resolveSkillPath(options: Pick<PiBridgeOptions, "skillPath" | "cwd"> = {}): string {
  return resolve(options.cwd ?? process.cwd(), options.skillPath ?? process.env.PI_SKILL_PATH ?? DEFAULT_SKILL_PATH);
}

// pi 接受 SKILL.md 文件或包含它的目录；校验入口文件能避免技能丢失后静默退回系统提示词。
export function resolveSkillEntry(skillPath: string): string {
  return skillPath.endsWith(".md") ? skillPath : join(skillPath, "SKILL.md");
}

export function resolvePiBin(cwd: string = process.cwd()): string {
  if (process.env.PI_BIN) return process.env.PI_BIN;
  return join(cwd, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
}

// pi 的会话、模型缓存和信任状态都写在项目内，部署时整个目录自包含，不落到 $HOME 或 /tmp。
export function resolvePiStateDir(cwd: string = process.cwd()): string {
  return process.env.PI_CODING_AGENT_DIR ?? resolve(cwd, DEFAULT_PI_STATE_DIR);
}

/**
 * 会话参数：有合法 id 就交给 pi 续话，没有就明确地跑成单轮无状态。
 *
 * 不能两者都传——pi 里 `--no-session` 优先，会静默退回内存会话（session-manager 的
 * createSessionManager 先看 noSession），那样「加了 --session-id」看起来生效，实际没有。
 */
export function sessionArgs(conversationId: string | undefined): string[] {
  return conversationId && isValidSessionId(conversationId)
    ? ["--session-id", conversationId]
    : ["--no-session"];
}

export function buildPiArgs(options: PiBridgeOptions): string[] {
  const cwd = options.cwd ?? process.cwd();
  const extensionPath = options.extensionPath ?? resolve(cwd, ".pi/extensions/xhs-source.ts");
  return [
    "--mode", "json",
    ...sessionArgs(options.conversationId),
    "--approve",
    "--no-context-files",
    "--no-skills",
    "--no-builtin-tools",
    "--extension", extensionPath,
    "--skill", resolveSkillPath(options),
    "--tools", READ_ONLY_TOOL_ALLOWLIST,
    "--system-prompt", options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    "--provider", options.provider ?? process.env.PI_PROVIDER ?? "deepseek",
    "--model", options.model ?? process.env.PI_MODEL ?? "deepseek-chat",
    "-p", options.prompt
  ];
}

export function formatSseEvent(event: AppSseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** 观测调用一律不许冒泡进请求路径：抛错只丢观测数据，不改任何产品行为。 */
function safely<T>(operation: () => T): T | null {
  try {
    return operation();
  } catch {
    return null;
  }
}

export async function runPiAgent(options: PiBridgeOptions, sink: PiEventSink): Promise<PiBridgeResult> {
  const startedAt = Date.now();
  const traceId = options.traceId ?? `trace_${randomUUID()}`;
  const agentRunId = `pi_${randomUUID()}`;
  // conversationId 是 trace 归因用的标签；sessionId 才是 pi 的会话键。
  // 两者同值时（chat 链路）它们指向同一条会话，没有合法 id 时只有前者存在。
  const conversationId = options.conversationId ?? `conv_${randomUUID()}`;
  const sessionId = options.conversationId && isValidSessionId(options.conversationId) ? options.conversationId : null;
  const messageId = `msg_${randomUUID()}`;
  const cwd = options.cwd ?? process.cwd();
  const stateDir = resolvePiStateDir(cwd);
  // 「续话还是新开」只是给界面的一句实话：查不到就说明这一轮会从零开始，
  // 前端据此提示用户，而不是让他以为前文还在。
  const sessionFile = sessionId ? await findSessionFile(cwd, sessionId, stateDir) : null;
  const provider = options.provider ?? process.env.PI_PROVIDER ?? "deepseek";
  const model = options.model ?? process.env.PI_MODEL ?? "deepseek-chat";
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const context: PiRunContext = {
    traceId,
    agentRunId,
    conversationId,
    messageId,
    provider,
    model,
    systemPrompt,
    userPrompt: options.prompt
  };

  const skillPath = resolveSkillPath(options);
  const trace = options.trace ?? null;
  // pi.run 在 spawn **之前**开出：它到进程 close 的宽度就是真正的进程墙钟（6.3）。
  // 观测调用一律走 safely：任何一个 observation 抛错都不能冒泡进请求路径。
  const run = safely(() => trace?.startObservation("pi.run", {
    metadata: {
      agentRunId,
      conversationId,
      messageId,
      provider,
      model,
      skillPath,
      // 完整系统提示词不进 trace：静态、每次一样、又长。哈希用来确认版本变了。
      systemPromptHash: createHash("sha256").update(systemPrompt).digest("hex").slice(0, 12),
      systemPromptLength: systemPrompt.length
    }
  }, "agent")) ?? null;
  // 前端拿到的是 trace_<uuid>，把同一批 id 也挂到根上，便于按会话回查。
  safely(() => trace?.update({ metadata: { agentRunId, conversationId, messageId, provider, model } }));

  const collector = createTurnCollector(trace, {
    includeContent: includeContentEnabled(),
    run,
    flush: flushObservability,
    provider,
    model
  });

  const mapper = createPiEventMapper(context);
  let answerText = "";
  let finalMessageText = "";
  let cancelled = Boolean(options.signal?.aborted);
  let spawnError: Error | null = null;
  let child: ChildProcess;

  // pi 把警告和错误写在 stderr（例如「找不到这个 id 的会话，已新建」）。
  // 它必须被消费：只 pipe 不读，管道写满 64 KB 会把子进程堵死；顺手留最后几行，
  // 失败时当作原因带上——否则那些信息哪儿都没有。
  const stderrTail: string[] = [];
  const STDERR_TAIL_LINES = 20;
  const stderrHint = (): string =>
    stderrTail.length ? `（pi stderr：${redactSensitive(stderrTail.slice(-5).join(" | "))}）` : "";

  const finish = async (result: PiBridgeResult, errorMessage?: string): Promise<PiBridgeResult> => {
    const settled: PiBridgeResult = { ...result, answerText: redactSensitive(result.answerText) };
    if (errorMessage && settled.status === "failed") {
      await sink({
        event: "error",
        data: { message: `${errorMessage}${stderrHint()}`, runtime: "pi", traceId: settled.run.traceId }
      });
    }
    await sink({
      event: "result",
      data: {
        answerText: settled.answerText || (settled.status === "cancelled" ? "本轮已取消。" : "Pi 没有返回文本。"),
        status: settled.status,
        run: settled.run,
        durationMs: Date.now() - startedAt,
        runtime: { engine: "pi", provider: settled.provider, model: settled.model, exitCode: settled.exitCode }
      }
    });
    // 收尾放在 result 之后：用户先拿到答案，再等尾批推出去。
    await collector.finish(settled.status);
    return settled;
  };

  await sink({
    event: "status",
    data: {
      phase: "starting",
      runtime: "pi",
      traceId,
      agentRunId,
      conversationId,
      // 本轮是续话还是新开：sessionId 为 null 表示这轮按单轮无状态跑。
      sessionId,
      sessionFound: sessionFile !== null,
      ephemeral: sessionId === null,
      messageId,
      skillPath,
      skillEntry: resolveSkillEntry(skillPath)
    }
  });

  if (cancelled) {
    return finish({
      answerText,
      status: "cancelled",
      run: { traceId, agentRunId, conversationId, messageId },
      provider,
      model,
      exitCode: null
    });
  }

  try {
    await access(resolveSkillEntry(skillPath));
  } catch {
    return finish({
      answerText: "",
      status: "failed",
      run: { traceId, agentRunId, conversationId, messageId },
      provider,
      model,
      exitCode: null
    }, `未找到技能文件 ${resolveSkillEntry(skillPath)}；Pi Agent 的行为由技能决定，缺失时不回退到系统提示词。`);
  }

  const piBin = options.piBin ?? resolvePiBin(cwd);
  try {
    await access(piBin);
  } catch {
    return finish({
      answerText: "",
      status: "failed",
      run: { traceId, agentRunId, conversationId, messageId },
      provider,
      model,
      exitCode: null
    }, `未找到 pi 可执行文件 ${piBin}；请先运行 npm install（pi 是本项目的依赖），或用 PI_BIN 指定路径。`);
  }

  await mkdir(stateDir, { recursive: true });

  try {
    child = spawn(piBin, buildPiArgs({ ...options, provider, model, systemPrompt }), {
      cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    spawnError = error instanceof Error ? error : new Error(String(error));
    return finish({
      answerText: "",
      status: "failed",
      run: { traceId, agentRunId, conversationId, messageId },
      provider,
      model,
      exitCode: null
    }, spawnError.message);
  }

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    }
  });

  const abortHandler = () => {
    cancelled = true;
    if (!child.killed) child.kill("SIGTERM");
  };
  options.signal?.addEventListener("abort", abortHandler, { once: true });

  const closePromise = new Promise<number | null>((resolveClose) => {
    child.once("error", (error) => {
      spawnError = error;
      resolveClose(null);
    });
    child.once("close", (code) => resolveClose(code));
  });

  const lines = createInterface({ input: child.stdout! });
  try {
    for await (const line of lines) {
      const parsed = parsePiJsonLine(String(line));
      if (!parsed) continue;

      if (parsed.type === "message_update" && parsed.assistantMessageEvent?.type === "text_delta") {
        answerText += String(redactSensitive(parsed.assistantMessageEvent.delta ?? ""));
      }
      if (parsed.type === "message_end" && parsed.message?.role === "assistant") {
        finalMessageText = redactSensitive(extractAssistantText(parsed.message.content)) || finalMessageText;
      }

      // 观测与 SSE 并行消费同一个（已脱敏的）事件流：SSE 是给前端的投影，信息有损，
      // 观测要的是原始事件本身。
      collector.consume(parsed);
      for (const event of mapper.consume(parsed)) await sink(event);
    }
  } finally {
    lines.close();
  }

  const exitCode = await closePromise;
  options.signal?.removeEventListener("abort", abortHandler);
  const runtimeError = spawnError as Error | null;
  if (runtimeError) {
    return finish({
      answerText: finalMessageText || answerText,
      status: cancelled ? "cancelled" : "failed",
      run: { traceId, agentRunId, conversationId, messageId },
      provider,
      model,
      exitCode
    }, runtimeError.message);
  }

  return finish({
    answerText: finalMessageText || answerText,
    status: cancelled ? "cancelled" : exitCode === 0 ? "succeeded" : "failed",
    run: { traceId, agentRunId, conversationId, messageId },
    provider,
    model,
    exitCode
  }, exitCode === 0 || cancelled ? undefined : `Pi 进程退出码：${exitCode}`);
}

export { DEFAULT_SYSTEM_PROMPT };
