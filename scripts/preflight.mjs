// 部署前检查。由 scripts/deploy.sh（本机/手工路径）和 scripts/deploy-remote.sh
// （CI 发布到服务器时，对**新树**多做一次）共同调用，两边共用同一份逻辑。
//
//   node scripts/preflight.mjs --env                     # 校验 .env
//   node scripts/preflight.mjs --extension               # 扩展自检（不发上游请求）
//   node scripts/preflight.mjs --data-dir=DIR            # 断言用户数据落在 DIR 里（只发布端用）
//   --env-file=PATH                                       # 默认 <cwd>/.env
//
// 为什么抽出来而不是各抄一份：2026-09-24 有过一次真实误导——文档还写着「xhs 走 Just
// One API」，而那条链路对图文笔记返回空 data、文件也已删除。**配置错了不会报错，只会
// 静默降级**（不发请求、答案里说「没有实时站内检索」）。这两段检查是唯一能当场问清
// 「模式、供应商、token」的地方，抄成两份必然会漂。
//
// --extension 要求 cwd 是被检查的树根：pi 的扩展加载器和扩展自己 import 的
// lib/xhs/*.ts 都是相对 cwd 解析的。

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const envFileArg = args.find((a) => a.startsWith("--env-file="));
const envFile = envFileArg ? envFileArg.slice("--env-file=".length) : path.join(process.cwd(), ".env");
const wantEnv = args.includes("--env");
const wantExtension = args.includes("--extension");
const dataDirArg = args.find((a) => a.startsWith("--data-dir="));

if (!wantEnv && !wantExtension && !dataDirArg) {
  console.error("用法：node scripts/preflight.mjs --env | --extension | --data-dir=DIR [--env-file=PATH]");
  process.exit(2);
}

function loadEnv() {
  try {
    process.loadEnvFile(envFile);
  } catch (err) {
    console.error(`✗ 读不到 ${envFile}：${err.message}`);
    process.exit(1);
  }
}

if (wantEnv) {
  loadEnv();
  // 只报「有没有」和「指向哪里」，绝不打印值。
  const problems = [];
  const warn = [];
  const mode = (process.env.XHS_SOURCE_MODE ?? "").trim();
  if (mode !== "api") {
    problems.push(`XHS_SOURCE_MODE 期望 "api"，实际是 "${mode || "(空)"}"。TikHub 是唯一的取数链路：其它值会让整条链路静默降级——不发请求，也不伪装成真实来源。`);
  }
  const token = (process.env.XHS_API_TOKEN ?? "").trim();
  if (!token) problems.push("XHS_API_TOKEN 为空：整条取数链路会静默降级，一次上游请求都不发。");
  const base = (process.env.XHS_API_BASE_URL ?? "").trim();
  if (base && !base.includes("tikhub.io")) problems.push(`XHS_API_BASE_URL 指向 ${base}，但 xhs 的供应商现在是 TikHub（api.tikhub.io）。`);
  if (!(process.env.DEEPSEEK_API_KEY ?? "").trim() && !(process.env.OPENAI_API_KEY ?? "").trim()) {
    warn.push("没有 DEEPSEEK_API_KEY / OPENAI_API_KEY：除非你显式配了别的 PI_PROVIDER，否则模型跑不起来。");
  }
  if (problems.length) {
    console.error("✗ .env 有 " + problems.length + " 个问题：");
    for (const p of problems) console.error("  - " + p);
    process.exit(1);
  }
  const limit = (process.env.XHS_API_DETAIL_LIMIT ?? "10").trim();
  const cards = (process.env.TAOBAO_CARDS_ENABLED ?? "false").trim();
  console.log(`  ✓ xhs: api 模式 → ${base || "https://api.tikhub.io"}（token 已配置，详情上限 ${limit} 篇）`);
  console.log(`  ✓ 淘宝卡片: ${cards === "true" || cards === "1" ? "开（一轮最多 8 张，按次计费）" : "关"}`);
  for (const w of warn) console.log("  ! " + w);
}

if (dataDirArg) {
  loadEnv();
  // 发布树里不含用户数据，全靠这两个变量把数据指到树外面。缺了任何一个，应用不会
  // 报错——它会在 cwd 下新建一个空的 .local-data，页面照常 200，而历史对话、收藏
  // 全都不见了。这是本次改动里最贵的一种静默故障，所以单独设一道闸。
  const wanted = path.resolve(dataDirArg.slice("--data-dir=".length)).replace(/\/+$/, "");
  const problems = [];
  for (const key of ["LOOKTRACE_DATA_DIR", "PI_CODING_AGENT_DIR"]) {
    const raw = (process.env[key] ?? "").trim().replace(/^["']|["']$/g, "");
    if (!raw) {
      problems.push(`${key} 没配：应用会在 cwd 下新建一个空的 .local-data。`);
      continue;
    }
    const resolved = path.resolve(raw).replace(/\/+$/, "");
    if (resolved !== wanted && !resolved.startsWith(`${wanted}/`)) {
      problems.push(`${key} 指向 ${resolved}，应该落在 ${wanted} 下。`);
    }
  }
  if (problems.length) {
    console.error("✗ 用户数据目录不对：");
    for (const p of problems) console.error("  - " + p);
    process.exit(1);
  }
  console.log(`  ✓ 用户数据 → ${wanted}`);
}

if (wantExtension) {
  loadEnv();
  const cwd = process.cwd();
  // 深层 import 要拼绝对路径：从真实文件里用相对说明符会相对**本文件**解析，而不是 cwd。
  const loaderPath = path.join(cwd, "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
  const { createExtensionRuntime } = await import("@earendil-works/pi-coding-agent");
  const { loadExtensions } = await import(pathToFileURL(loaderPath).href);
  // 两个技能都必须存在，缺一个就在 spawn 前直接失败——少加载一个是静默的：
  // 模型会照着另一个技能的措辞往下走，而少了 makeup-kit 时它读不到妆匣规则却仍然标 ✅。
  const skillProblems = [];
  for (const dir of ["xiaohongshu-makeup-advisor-latest", "makeup-kit"]) {
    const entry = path.join(cwd, dir, "SKILL.md");
    if (!(await import("node:fs/promises")).stat(entry).then(() => true, () => false)) {
      skillProblems.push(`缺少技能文件 ${entry}`);
    }
  }
  if (skillProblems.length) {
    console.error("✗ 技能不完整：");
    for (const p of skillProblems) console.error("  - " + p);
    process.exit(1);
  }
  console.log("  ✓ 技能: xiaohongshu-makeup-advisor-latest + makeup-kit");
  // 不发任何上游请求：只问扩展「你看到的数据源是什么」。
  const r = await loadExtensions(
    [".pi/extensions/xhs-source.ts", ".pi/extensions/kit-source.ts"],
    cwd,
    undefined,
    createExtensionRuntime()
  );
  // 工具要从**所有**扩展里收：现在不止一个扩展，只看第一个会漏掉妆匣工具。
  const tools = (r.extensions ?? []).flatMap((extension) =>
    [...extension.tools.values()].map((t) => t.definition ?? t)
  );
  const status = await tools.find((t) => t.name === "xhs_source_status")?.execute("deploy-check", {});
  if (!status) {
    console.error(`✗ 没注册出 xhs_source_status（errors=${r.errors.length}），先修好再重启。`);
    for (const e of r.errors ?? []) console.error(`  - ${e.message ?? e}`);
    process.exit(1);
  }
  const result = `errors=${r.errors.length} ${status.content[0].text}`;
  console.log(`  ${result}`);
  if (!result.includes("errors=0")) {
    console.error("✗ 扩展加载失败（errors 非 0），先修好再重启。");
    process.exit(1);
  }
  if (!(result.includes('"mode":"api"') && result.includes('"configured":true'))) {
    console.error("✗ 扩展没读到 api 模式的凭据——重启也不会生效，回去看 .env 校验。");
    process.exit(1);
  }
  // 妆匣工具也自检一次：它跑的是同一套 jiti 加载器，别名解析不了的话在运行时才炸，
  // 而且报错是模块解析失败、不指向妆匣。这里调一次就能当场看见。
  const kit = tools.find((t) => t.name === "kit_list_products");
  if (!kit) {
    console.error("✗ 没注册出 kit_list_products——妆匣读不到，顾问会退化成凭印象推荐。");
    process.exit(1);
  }
  const kitResult = await kit.execute("deploy-check", {});
  const kitPayload = JSON.parse(kitResult.content[0].text);
  if (!["ok", "empty", "read-failed"].includes(kitPayload.availability)) {
    console.error(`✗ 妆匣工具返回的 availability 不认识：${kitPayload.availability}`);
    process.exit(1);
  }
  console.log(`  ✓ 妆匣: availability=${kitPayload.availability}`);
}
