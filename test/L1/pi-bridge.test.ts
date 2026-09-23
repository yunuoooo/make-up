import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildPiArgs,
  formatSseEvent,
  resolvePiBin,
  resolvePiStateDir,
  resolveSkillEntry,
  resolveSkillPath,
  runPiAgent,
  sessionArgs,
  type PiBridgeOptions
} from "../../lib/pi/bridge.ts";
import { createPiEventMapper, type AppSseEvent } from "../../lib/pi/events.ts";

function withEnv(name: string, value: string, run: () => void): void {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

const options: PiBridgeOptions = {
  prompt: "我想画韩系氧气妆",
  extensionPath: "/tmp/xiaohongshu-mcp.ts",
  skillPath: "/tmp/xiaohongshu-makeup-advisor-latest",
  systemPrompt: "只做只读小红书研究。",
  provider: "deepseek",
  model: "deepseek-chat"
};

test("builds an isolated Pi command for the read-only XHS runtime", () => {
  const args = buildPiArgs(options);
  assert.deepEqual(args, [
    "--mode", "json",
    "--no-session",
    "--approve",
    "--no-context-files",
    "--no-skills",
    "--no-builtin-tools",
    "--extension", "/tmp/xiaohongshu-mcp.ts",
    "--skill", "/tmp/xiaohongshu-makeup-advisor-latest",
    "--tools", "read,xhs_check_login_status,xhs_search_feeds,xhs_get_feed_detail",
    "--system-prompt", "只做只读小红书研究。",
    "--provider", "deepseek",
    "--model", "deepseek-chat",
    "-p", "我想画韩系氧气妆"
  ]);
});

test("keys the pi session on the conversation id so a follow-up sees the first round", () => {
  const conversationId = "conversation_9f0e6b1c-2f4a-4c1e-9c3a-7d5b8e2a1f60";
  const args = buildPiArgs({ ...options, conversationId });

  // 会话键交给 pi 自己 resume-or-create：同一个 id 的第二轮自动带上第一轮的上下文。
  assert.deepEqual(sessionArgs(conversationId), ["--session-id", conversationId]);
  assert.deepEqual(args.slice(0, 4), ["--mode", "json", "--session-id", conversationId]);
  // pi 里 --no-session 优先于 --session-id（走内存会话），两个一起传等于没接会话。
  assert.ok(!args.includes("--no-session"), "接了会话就不能再传 --no-session");

  // pi 明确禁止 --session-id 与这几个一起用，传了会直接退出。
  for (const flag of ["--session", "--continue", "--resume", "--fork"]) {
    assert.ok(!args.includes(flag), `${flag} 与 --session-id 互斥`);
  }
});

test("falls back to a stateless round instead of inventing a session id", () => {
  // 没有 id 或 id 不合法时不再自造一个每轮都不同的 id 冒充会话：
  // 那样看起来有会话，实际每轮都是从零开始，而且会在磁盘上堆一堆一次性会话。
  for (const value of [undefined, "", "../../etc/passwd", "a/b", ".hidden"]) {
    assert.deepEqual(sessionArgs(value), ["--no-session"], `不应为 ${JSON.stringify(value)} 建会话`);
  }
});

test("loads the advisor skill through the read tool instead of the system prompt", () => {
  const args = buildPiArgs({ ...options, skillPath: undefined, systemPrompt: undefined });
  const valueAfter = (flag: string) => args[args.indexOf(flag) + 1];

  // pi only injects <available_skills> for paths passed with --skill, and the model
  // loads SKILL.md on demand with the built-in read tool.
  assert.equal(valueAfter("--skill"), resolveSkillPath({ cwd: process.cwd() }));
  assert.deepEqual(valueAfter("--tools").split(","), [
    "read",
    "xhs_check_login_status",
    "xhs_search_feeds",
    "xhs_get_feed_detail"
  ]);

  // The system prompt must defer to the skill rather than restate its workflow.
  const systemPrompt = valueAfter("--system-prompt");
  assert.match(systemPrompt, /SKILL\.md/);
  assert.match(systemPrompt, /以技能为准/);
  for (const inlined of ["首轮只调用一次 xhs_search_feeds", "最多读取一篇", "不要先调用 xhs_check_login_status"]) {
    assert.ok(!systemPrompt.includes(inlined), `system prompt should not inline skill rule: ${inlined}`);
  }
});

test("resolves the shipped advisor skill and its SKILL.md entry", () => {
  const skillPath = resolveSkillPath({ cwd: process.cwd() });
  assert.equal(skillPath, `${process.cwd()}/xiaohongshu-makeup-advisor-latest`);
  assert.equal(resolveSkillEntry(skillPath), `${skillPath}/SKILL.md`);
  assert.equal(resolveSkillEntry("/tmp/custom/SKILL.md"), "/tmp/custom/SKILL.md");
  // The default path must exist, otherwise the runtime fails before spawning pi.
  assert.ok(existsSync(resolveSkillEntry(skillPath)), "advisor SKILL.md must be present in the repo");
});

test("runs the pi dependency installed in the project instead of a global pi", () => {
  const piBin = resolvePiBin(process.cwd());
  assert.equal(piBin, `${process.cwd()}/node_modules/.bin/pi`);
  // pi 是 package.json 里的依赖，npm install 后本地二进制必须存在，否则部署会静默用不到。
  assert.ok(existsSync(piBin), "pi must be installed under node_modules/.bin by npm install");
  withEnv("PI_BIN", "/opt/custom/pi", () => {
    assert.equal(resolvePiBin(process.cwd()), "/opt/custom/pi");
  });
});

test("keeps pi runtime state inside the project rather than the global pi config", () => {
  const stateDir = resolvePiStateDir(process.cwd());
  assert.equal(stateDir, `${process.cwd()}/.local-data/pi`);
  // 部署物必须自包含：状态目录落在项目内，而不是全局 ~/.pi 或 /tmp。
  assert.ok(stateDir.startsWith(`${process.cwd()}/`), "pi state must live inside the project");
  assert.notEqual(stateDir, join(homedir(), ".pi"));
  assert.notEqual(stateDir, join(homedir(), ".pi", "agent"));
  assert.ok(!stateDir.startsWith("/tmp/"), "pi state must not live in /tmp");
  withEnv("PI_CODING_AGENT_DIR", "/opt/custom/pi-state", () => {
    assert.equal(resolvePiStateDir(process.cwd()), "/opt/custom/pi-state");
  });
});

test("formats application events as parseable SSE blocks", () => {
  assert.equal(
    formatSseEvent({ event: "text_delta", data: { text: "你好" } }),
    'event: text_delta\ndata: {"text":"你好"}\n\n'
  );
});

test("gives SSE callers a duration for every finished call", () => {
  const context = {
    traceId: "trace_1",
    agentRunId: "run_1",
    conversationId: "conv_1",
    messageId: "msg_1",
    provider: "deepseek",
    model: "deepseek-chat",
    systemPrompt: "只做只读小红书研究。",
    userPrompt: "我想画韩系氧气妆"
  };
  let clock = 1_000;
  const mapper = createPiEventMapper(context, { now: () => clock });

  mapper.consume({ type: "message_start", message: { role: "assistant", model: "deepseek-chat" } });
  clock += 2_400;
  assert.equal((mapper.consume({ type: "message_end", message: { role: "assistant", content: [] } })[0].data as any).durationMs, 2_400);

  mapper.consume({ type: "tool_execution_start", toolCallId: "call_1", toolName: "xhs_get_feed_detail", args: {} });
  clock += 45_000;
  const [finished] = mapper.consume({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "xhs_get_feed_detail",
    result: { content: [{ type: "text", text: "The operation was aborted due to timeout" }] },
    isError: true
  });
  assert.equal((finished.data as any).durationMs, 45_000);
  // 45s 上限的那一簇和 4–16s 的成功簇，在过程区里一眼可分。
  assert.equal((finished.data as any).status, "failed");

  // 配不上对就不给数字：编一个 0 会被读成「瞬间完成」。
  const [orphan] = mapper.consume({ type: "tool_execution_end", toolCallId: "ghost", toolName: "read", result: {}, isError: false });
  assert.equal("durationMs" in (orphan.data as any), false);

  // turn 的边界不给前端加事件类型（SSE 契约不变），但也必须显式处理、不落 default。
  assert.deepEqual(mapper.consume({ type: "turn_start", turnIndex: 0, timestamp: 1 }), []);
  assert.deepEqual(mapper.consume({ type: "turn_end", turnIndex: 0 }), []);
});

test("reports the run wall clock on the result event", async () => {
  const events: AppSseEvent[] = [];
  const result = await runPiAgent(
    // 技能文件不存在：这条路径在 spawn 之前就返回，测试不启动任何进程。
    { prompt: "我想画韩系氧气妆", skillPath: "/tmp/looktrace-missing-skill-for-test" },
    (event) => void events.push(event)
  );

  assert.equal(result.status, "failed");
  const resultEvent = events.find((event) => event.event === "result");
  assert.ok(resultEvent);
  const durationMs = (resultEvent.data as { durationMs?: unknown }).durationMs;
  assert.equal(typeof durationMs, "number");
  assert.ok((durationMs as number) >= 0, "result 要带上本次耗时");
  // 失败原因照旧要透出，新增字段不能顶掉它。
  assert.ok(events.some((event) => event.event === "error"));
});

test("tells the client whether the round resumes a session or starts from zero", async () => {
  const events: AppSseEvent[] = [];
  // 技能文件不存在：这条路径在 spawn 之前返回，测试不启动任何进程。
  await runPiAgent(
    { prompt: "我想画韩系氧气妆", skillPath: "/tmp/looktrace-missing-skill-for-test" },
    (event) => void events.push(event)
  );

  const status = events.find((event) => event.event === "status");
  // 没给会话键：这一轮是明确的单轮无状态，界面据此可以说实话。
  assert.equal(status?.data.sessionId, null);
  assert.equal(status?.data.sessionFound, false);
  assert.equal(status?.data.ephemeral, true);
});

test("finishes the round even when the observation sink throws", async () => {
  const events: AppSseEvent[] = [];
  const throwing = {
    id: "boom",
    runContext: { traceId: "trace_boom" },
    update() {
      throw new Error("sink exploded");
    },
    end() {
      throw new Error("sink exploded");
    },
    startObservation(): never {
      throw new Error("sink exploded");
    }
  };

  const result = await runPiAgent({
    prompt: "我想画韩系氧气妆",
    skillPath: "/tmp/looktrace-missing-skill-for-test",
    trace: throwing
  }, (event) => void events.push(event));

  // 观测炸了只丢观测：答案路径和状态一个字都不能变。
  assert.equal(result.status, "failed");
  assert.equal(events.filter((event) => event.event === "result").length, 1);
});
