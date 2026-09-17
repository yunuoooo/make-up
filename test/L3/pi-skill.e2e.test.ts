import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPiAgent, resolveSkillPath } from "../../lib/pi/bridge.ts";
import type { AppSseEvent } from "../../lib/pi/events.ts";

// 需要本机安装 pi；验证“技能真的进了 Pi 的上下文”，不调用真实模型。
const enabled = process.env.RUN_L3_E2E === "1";
const repoRoot = process.cwd();
const skillPath = resolveSkillPath({ cwd: repoRoot });
const skillEntry = join(skillPath, "SKILL.md");
const happyPath = join(skillPath, "references/happy-path.md");

test("L3 loads the repo skill into Pi and reads it with the built-in read tool", { skip: !enabled }, async () => {
  const requests: any[] = [];
  // 固定脚本：先读 SKILL.md，再读一份 references，最后收尾。
  const script = [
    { tool: "read", args: { path: skillEntry } },
    { tool: "read", args: { path: happyPath } },
    { text: "调研完成。" }
  ];
  const server = await startMockModel(requests, script);
  const workDir = mkdtempSync(join(tmpdir(), "pi-skill-"));
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

  try {
    const events: AppSseEvent[] = [];
    const result = await runPiAgent({
      prompt: "我想画韩系氧气妆",
      provider: "mockverify",
      model: "mock-1",
      extensionPath: stubExtension,
      skillPath,
      cwd: repoRoot
    }, (event) => { events.push(event); });

    assert.equal(result.status, "succeeded", JSON.stringify(events.filter((event) => event.event === "error")));

    // 1. Pi 把技能清单注入系统提示词，并开放 read 工具供按需加载。
    const first = requests[0];
    const systemPrompt = first.messages.find((message: any) => message.role === "system")?.content ?? "";
    assert.match(systemPrompt, /<available_skills>/);
    assert.match(systemPrompt, /xiaohongshu-makeup-advisor/);
    assert.match(systemPrompt, new RegExp(skillEntry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(
      first.tools.some((tool: any) => tool.function?.name === "read"),
      "read 必须在工具白名单内，否则模型无法加载 SKILL.md"
    );

    // 2. 模型读到的内容就是仓库里的技能正文和参考文件。
    const loaded = JSON.stringify(requests.at(-1)?.messages ?? []);
    assert.match(loaded, /小红书妆容顾问/);
    assert.match(loaded, /双阶段推荐 Happy Path/);

    // 3. 事件流对前端透出 read 调用与初始技能路径。
    assert.ok(events.some((event) => event.event === "tool_started" && event.data.toolName === "read"));
    const starting = events.find((event) => event.event === "status" && event.data.phase === "starting");
    assert.equal(starting?.data.skillPath, skillPath);
  } finally {
    server.close();
    delete process.env.PI_CODING_AGENT_DIR;
  }
});

async function startMockModel(requests: any[], script: Array<{ tool?: string; args?: unknown; text?: string }>): Promise<Server> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const step = script[Math.min(requests.length, script.length - 1)];
      requests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "text/event-stream" });
      chunk(response, { role: "assistant", content: step.text ?? null });
      if (step.tool) {
        chunk(response, {
          tool_calls: [{
            index: 0,
            id: `call_${requests.length}`,
            type: "function",
            function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) }
          }]
        });
      }
      chunk(response, {}, "stop");
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return server;
}

function chunk(response: NodeJS.WritableStream, delta: unknown, finish: string | null = null): void {
  response.write(`data: ${JSON.stringify({
    id: "mock",
    object: "chat.completion.chunk",
    created: 1,
    model: "mock-1",
    choices: [{ index: 0, delta, finish_reason: finish }]
  })}\n\n`);
}
