import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPiAgent } from "../../lib/pi/bridge.ts";
import type { AppSseEvent } from "../../lib/pi/events.ts";
import {
  SESSION_MAX_COUNT,
  deleteSession,
  findSessionFile,
  isValidSessionId,
  projectSessionDir,
  projectSessionDirName,
  pruneSessions
} from "../../lib/pi/session.ts";

const CWD = "/Users/william/make-up";

function makeState(): { stateDir: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-session-"));
  return { stateDir: join(root, ".local-data", "pi"), cwd: root };
}

/** 按 pi 的命名写一份最小会话文件：只有头一行是真的，正文对本模块不重要。 */
function writeSession(stateDir: string, cwd: string, id: string, fileName = `2026-09-23T00-00-00-000Z_${id}.jsonl`): string {
  const dir = projectSessionDir(cwd, stateDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, fileName);
  writeFileSync(file, `${JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-09-23T00:00:00.000Z",
    cwd
  })}\n`);
  return file;
}

test("accepts the ids pi itself accepts and rejects anything that could escape the session dir", () => {
  // 客户端生成的形式：conversation_<uuid>。
  assert.ok(isValidSessionId("conversation_9f0e6b1c-2f4a-4c1e-9c3a-7d5b8e2a1f60"));
  assert.ok(isValidSessionId("probe_conv_abc"));
  assert.ok(isValidSessionId("a.b-c_d"));

  for (const invalid of ["", ".", "..", "../../etc/passwd", "a/b", "/abs/path", "-lead", "trail-", ".hidden", "has space", "a".repeat(129)]) {
    assert.equal(isValidSessionId(invalid), false, `应拒绝 ${JSON.stringify(invalid)}`);
  }
});

test("derives the same project session dir pi uses", () => {
  // 规则抄自 pi 的 getDefaultSessionDirPath：去前导斜杠、把 / 与 : 换成 -、两边补 --。
  // pi 改了命名规则时这条会先失败，而不是等到线上找不到会话才发现。
  assert.equal(projectSessionDirName(CWD), "--Users-william-make-up--");
  assert.equal(projectSessionDirName("/srv/app/"), "--srv-app--");
});

test("finds the session file by header id, not by file name suffix alone", async () => {
  const { stateDir, cwd } = makeState();
  assert.equal(await findSessionFile(cwd, "conversation_a", stateDir), null, "还没有会话时返回 null");

  const wanted = writeSession(stateDir, cwd, "conversation_a");
  assert.equal(await findSessionFile(cwd, "conversation_a", stateDir), wanted);

  // 更长的 id 也以 `_conversation_a.jsonl` 结尾：只按后缀匹配会认错文件。
  writeSession(stateDir, cwd, "x_conversation_a", "2026-09-23T00-00-01-000Z_conversation_a.jsonl");
  assert.equal(await findSessionFile(cwd, "conversation_a", stateDir), wanted);

  // 非法 id 不去碰文件系统。
  assert.equal(await findSessionFile(cwd, "../conversation_a", stateDir), null);
});

test("deletes only the session file it found", async () => {
  const { stateDir, cwd } = makeState();
  const file = writeSession(stateDir, cwd, "conversation_b");
  const other = writeSession(stateDir, cwd, "conversation_c");

  assert.equal(await deleteSession(cwd, "conversation_b", stateDir), true);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(other), true, "别的会话不能跟着一起没");
  // 已经删掉：再删一次返回 false，接口据此回 404。
  assert.equal(await deleteSession(cwd, "conversation_b", stateDir), false);
});

test("prunes sessions by age first and by count second", async () => {
  const { stateDir, cwd } = makeState();
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-09-23T12:00:00.000Z");
  const files = ["a", "b", "c", "d"].map((name) => writeSession(stateDir, cwd, `conversation_${name}`));
  // 让 d 最旧、a 最新，并让 d 超出保质期。
  files.forEach((file, index) => {
    const age = index === 3 ? 40 * day : index * 60 * 1000;
    const when = new Date(now - age);
    utimesSync(file, when, when);
  });

  // 上限收到 2 条：最旧的 d 因过期删掉，c 因超额删掉，a、b 留下。
  const result = await pruneSessions(cwd, stateDir, { maxCount: 2, maxAgeMs: 30 * day, now });
  assert.equal(result.scanned, 4);
  assert.equal(result.deleted, 2);
  assert.ok(existsSync(files[0]) && existsSync(files[1]));
  assert.ok(!existsSync(files[2]) && !existsSync(files[3]));

  // 目录不存在（从没聊过）时不是错误。
  const empty = makeState();
  assert.deepEqual(await pruneSessions(empty.cwd, empty.stateDir, { now }), { scanned: 0, deleted: 0 });
});

test("keeps the default session cap in step with the conversation list", async () => {
  // 界面最多保留 30 条对话，服务端不该比它留得更久。
  assert.equal(SESSION_MAX_COUNT, 30);
});

test("reports sessionFound from the session actually on disk", async () => {
  const { stateDir, cwd } = makeState();
  const conversationId = "conversation_on_disk";
  writeSession(stateDir, cwd, conversationId);

  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = stateDir;
  try {
    const events: AppSseEvent[] = [];
    // 技能文件不存在：这条路径在 spawn 之前返回，测试不启动任何进程。
    await runPiAgent(
      { prompt: "我是干皮，预算 500", skillPath: join(cwd, "no-such-skill"), cwd, conversationId },
      (event) => void events.push(event)
    );

    const status = events.find((event) => event.event === "status");
    // 磁盘上确实有这个会话：界面才敢说"继续追问会带上此前轮次"。
    assert.equal(status?.data.sessionId, conversationId);
    assert.equal(status?.data.sessionFound, true);
    assert.equal(status?.data.ephemeral, false);

    // 没建过的 id：这一轮从零开始。
    const fresh: AppSseEvent[] = [];
    await runPiAgent(
      { prompt: "我是干皮", skillPath: join(cwd, "no-such-skill"), cwd, conversationId: "conversation_brand_new" },
      (event) => void fresh.push(event)
    );
    assert.equal(fresh.find((event) => event.event === "status")?.data.sessionFound, false);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
