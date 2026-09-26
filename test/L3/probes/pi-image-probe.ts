/**
 * 实测：pi 的【扩展工具】返回 image 块时，会不会真的送进模型请求体。
 * 用本地 mock 端点，不调真实模型、不花钱。
 * 跑法：node --experimental-strip-types test/L3/probes/pi-image-probe.ts
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPiAgent } from "../../../lib/pi/bridge.ts";

// 1x1 透明 PNG
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const requests: any[] = [];

async function startMock(): Promise<Server> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (c) => { body += c; });
    request.on("end", () => {
      const n = requests.length;
      requests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: unknown, finish: string | null = null) =>
        response.write(`data: ${JSON.stringify({
          id: "mock", object: "chat.completion.chunk", created: 1, model: "mock",
          choices: [{ index: 0, delta, finish_reason: finish }]
        })}\n\n`);
      if (n === 0) {
        // 第一轮：让模型调用我们的图片工具
        send({ role: "assistant", content: null });
        send({ tool_calls: [{ index: 0, id: "call_1", type: "function",
          function: { name: "image_probe", arguments: "{}" } }] });
        send({}, "stop");
      } else {
        send({ role: "assistant", content: "收到。" });
        send({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return server;
}

async function runWithModel(modelId: string, server: Server, workDir: string, extensionPath: string, skillPath: string) {
  requests.length = 0;
  const events: any[] = [];
  const result = await runPiAgent(
    { prompt: "调用 image_probe", provider: "mockverify", model: modelId, extensionPath, skillPath, cwd: process.cwd() },
    (e) => { events.push(e); }
  );
  const toolResultMsg = (requests[1]?.messages ?? []).find((m: any) => m.role === "tool");
  const allImages = JSON.stringify(requests[1] ?? {}).includes("image_url");
  // 也看 provider 是否把图片单独塞进了别的消息
  const anyDataUri = JSON.stringify(requests[1] ?? {}).includes("data:image/png;base64");

  console.log(`\n──── model = ${modelId} ────`);
  console.log(`  runPiAgent status: ${result.status}`);
  console.log(`  第 2 次请求的消息角色: ${(requests[1]?.messages ?? []).map((m: any) => m.role).join(", ")}`);
  console.log(`  tool 消息的 content: ${JSON.stringify(toolResultMsg?.content)?.slice(0, 160)}`);
  console.log(`  请求体里出现 image_url      : ${allImages}`);
  console.log(`  请求体里出现 base64 图片数据: ${anyDataUri}`);
  if (!allImages) {
    const err = events.find((e) => e.event === "error");
    if (err) console.log(`  error 事件: ${JSON.stringify(err.data).slice(0, 200)}`);
  }
}

const server = await startMock();
const port = (server.address() as { port: number }).port;
const workDir = mkdtempSync(join(tmpdir(), "pi-image-"));
const skillPath = join(workDir, "skill");
mkdirSync(skillPath, { recursive: true });
writeFileSync(join(skillPath, "SKILL.md"), "---\nname: stub\ndescription: stub skill\n---\n\nstub\n");

writeFileSync(join(workDir, "models.json"), JSON.stringify({
  providers: {
    mockverify: {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      api: "openai-completions",
      apiKey: "dummy",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [
        { id: "mock-text" },                                  // 不声明模态（等价于 deepseek-chat 这种目录外的 id）
        { id: "mock-vision", input: ["text", "image"] }        // 声明视觉
      ]
    }
  }
}));

const extensionPath = join(workDir, "probe-extension.ts");
writeFileSync(extensionPath, `
import { Type } from "typebox";
export default function probe(pi: any) {
  pi.registerTool({
    name: "image_probe",
    label: "Image Probe",
    description: "返回一张图片",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "image", data: ${JSON.stringify(PNG_B64)}, mimeType: "image/png" }], details: {} };
    }
  });
}
`);

process.env.PI_CODING_AGENT_DIR = workDir;
try {
  console.log("=== 实验：扩展工具返回 image 块，看它到不到达模型请求体 ===");
  await runWithModel("mock-text", server, workDir, extensionPath, skillPath);
  await runWithModel("mock-vision", server, workDir, extensionPath, skillPath);
} finally {
  server.close();
  delete process.env.PI_CODING_AGENT_DIR;
}
