/**
 * 实测（直接 spawn pi，绕开 bridge 写死的 --tools 白名单）：
 * 扩展工具返回 image 块，到底会不会进模型请求体；是否取决于模型的 input 声明。
 * 用本地 mock 端点，不调真实模型、不花钱。
 * 跑法：node --experimental-strip-types test/L3/probes/pi-image-probe2.ts
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PI_BIN = join(process.cwd(), "node_modules", ".bin", "pi");

let captured: any[] = [];

async function startMock(): Promise<Server> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (c) => { body += c; });
    request.on("end", () => {
      const n = captured.length;
      try { captured.push(JSON.parse(body)); } catch { captured.push({ parseError: true, raw: body.slice(0, 200) }); }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: unknown, finish: string | null = null) =>
        response.write(`data: ${JSON.stringify({
          id: "mock", object: "chat.completion.chunk", created: 1, model: "mock",
          choices: [{ index: 0, delta, finish_reason: finish }]
        })}\n\n`);
      if (n === 0) {
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

function runPi(modelId: string, workDir: string, extensionPath: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(PI_BIN, [
      "--mode", "json",
      "--no-session",
      "--approve",
      "--no-context-files",
      "--no-skills",
      "--no-builtin-tools",
      "--extension", extensionPath,
      "--tools", "image_probe",
      "--system-prompt", "你是测试助手。",
      "--provider", "mockverify",
      "--model", modelId,
      "-p", "调用 image_probe 工具"
    ], {
      cwd: process.cwd(),
      env: { ...process.env, PI_CODING_AGENT_DIR: workDir },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let err = "";
    child.stdout.on("data", () => {});
    child.stderr.on("data", (c) => { err += c; });
    child.on("close", () => { if (err.trim()) console.log("  stderr:", err.trim().split("\n").slice(0, 3).join(" | ")); resolve(); });
  });
}

const server = await startMock();
const port = (server.address() as { port: number }).port;
const workDir = mkdtempSync(join(tmpdir(), "pi-img2-"));

writeFileSync(join(workDir, "models.json"), JSON.stringify({
  providers: {
    mockverify: {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      api: "openai-completions",
      apiKey: "dummy",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [
        { id: "mock-text" },                            // 不声明 input
        { id: "mock-vision", input: ["text", "image"] }  // 声明视觉
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

console.log("=== 扩展工具返回 image 块 → 是否进模型请求体 ===\n");
try {
  for (const modelId of ["mock-text", "mock-vision"]) {
    captured = [];
    await runPi(modelId, workDir, extensionPath);
    const req2 = captured[1] ?? {};
    const msgs = req2.messages ?? [];
    const toolMsg = msgs.find((m: any) => m.role === "tool");
    const flat = JSON.stringify(req2);
    console.log(`──── model = ${modelId} ────`);
    console.log(`  请求数: ${captured.length}`);
    console.log(`  消息角色: ${msgs.map((m: any) => m.role).join(", ")}`);
    console.log(`  tool 消息 content: ${JSON.stringify(toolMsg?.content)?.slice(0, 120)}`);
    console.log(`  请求体含 "image_url"        : ${flat.includes("image_url")}`);
    console.log(`  请求体含 base64 图片数据    : ${flat.includes("data:image/png;base64")}`);
    console.log(`  请求体含 "(see attached"    : ${flat.includes("see attached image")}`);
    console.log("");
  }
} finally {
  server.close();
}
