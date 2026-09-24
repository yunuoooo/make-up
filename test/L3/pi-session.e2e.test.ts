import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPiAgent, resolveSkillPath } from "../../lib/pi/bridge.ts";
import { projectSessionDir } from "../../lib/pi/session.ts";

// 需要本机安装 pi；验证"同一个会话 id 的第二轮真的能读到第一轮"，不调用真实模型。
const enabled = process.env.RUN_L3_E2E === "1";
const repoRoot = process.cwd();
const skillPath = resolveSkillPath({ cwd: repoRoot });

test("L3 keeps one Pi session per conversation so the follow-up sees the first round", { skip: !enabled }, async () => {
  const requests: any[] = [];
  const server = await startMockModel(requests, [
    "第一轮答案：我推荐韩系氧气妆，重点是清透底妆。",
    "第二轮答案：按你的肤质把底妆改成持妆路线。",
    "第三轮答案：这轮没有前文。"
  ]);
  const workDir = mkdtempSync(join(tmpdir(), "pi-session-"));
  writeFileSync(join(workDir, "models.json"), JSON.stringify({
    providers: {
      mockverify: {
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        api: "openai-completions",
        apiKey: "dummy",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: "mock-1" }]
      }
    }
  }));
  const stubExtension = join(workDir, "stub-extension.ts");
  writeFileSync(stubExtension, "export default function stub() {}\n");
  process.env.PI_CODING_AGENT_DIR = workDir;

  const conversationId = "conversation_e2e_session_1";
  const base = {
    provider: "mockverify",
    model: "mock-1",
    extensionPath: stubExtension,
    skillPath,
    cwd: repoRoot
  };

  try {
    const first = await runPiAgent({ ...base, prompt: "我想画韩系氧气妆", conversationId }, () => {});
    assert.equal(first.status, "succeeded");
    const second = await runPiAgent({ ...base, prompt: "我是干皮，预算 500", conversationId }, () => {});
    assert.equal(second.status, "succeeded");

    assert.equal(requests.length, 2, "每轮一次模型调用，索引才对得上");
    // 第二轮请求里必须出现第一轮的问和答：这就是"第二阶段复用第一阶段"的全部机制。
    const secondMessages = JSON.stringify(requests[1].messages);
    assert.match(secondMessages, /我想画韩系氧气妆/);
    assert.match(secondMessages, /第一轮答案/);

    // 不带会话键的一轮从零开始：反证上下文来自会话，而不是别的东西顺带带过去的。
    const ephemeral = await runPiAgent({ ...base, prompt: "第三轮" }, () => {});
    assert.equal(ephemeral.status, "succeeded");
    assert.equal(requests.length, 3);
    const ephemeralMessages = JSON.stringify(requests[2].messages);
    assert.ok(!ephemeralMessages.includes("我想画韩系氧气妆"), "无会话的一轮不该看到前面的对话");
    assert.ok(!ephemeralMessages.includes("第一轮答案"));

    // 一个会话一份文件：两轮追加同一个 JSONL，而单轮无状态那轮不落盘。
    const dir = projectSessionDir(repoRoot, workDir);
    const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    assert.deepEqual(files.filter((name) => name.endsWith(`_${conversationId}.jsonl`)).length, 1);
    assert.equal(files.length, 1, "--no-session 的一轮不该留下会话文件");
    const content = readFileSync(join(dir, files[0]), "utf8");
    assert.match(content, /我想画韩系氧气妆/);
    assert.match(content, /第一轮答案/);
    assert.match(content, /我是干皮，预算 500/);
  } finally {
    server.close();
    delete process.env.PI_CODING_AGENT_DIR;
  }
});

async function startMockModel(requests: any[], replies: string[]): Promise<Server> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const reply = replies[Math.min(requests.length, replies.length - 1)];
      requests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        id: "mock",
        object: "chat.completion.chunk",
        created: 1,
        model: "mock-1",
        choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }]
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "mock",
        object: "chat.completion.chunk",
        created: 1,
        model: "mock-1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return server;
}
