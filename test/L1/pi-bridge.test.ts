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
  type PiBridgeOptions
} from "../../lib/pi/bridge.ts";

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
