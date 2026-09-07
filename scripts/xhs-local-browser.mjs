import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const port = process.env.XHS_LOCAL_BROWSER_PORT || "9222";
const profileDir = resolve(process.cwd(), ".local-data/xhs-browser-profile");
const startUrl = "https://www.xiaohongshu.com";

mkdirSync(profileDir, { recursive: true });

const appCandidates = [
  "/Applications/Google Chrome.app",
  `${homedir()}/Applications/Google Chrome.app`,
  "/Applications/Microsoft Edge.app",
  `${homedir()}/Applications/Microsoft Edge.app`
];

const appPath = appCandidates.find((candidate) => existsSync(candidate));

if (!appPath) {
  console.error("没有找到 Google Chrome 或 Microsoft Edge。请先安装其中一个浏览器。");
  process.exit(1);
}

const child = spawn("open", [
  "-na",
  appPath,
  "--args",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  startUrl
], {
  stdio: "inherit"
});

child.on("exit", (code) => {
  if (code && code !== 0) {
    process.exit(code);
  }

  console.log("");
  console.log("已打开妆迹专用小红书浏览器。");
  console.log(`1. 在打开的浏览器里登录小红书：${startUrl}`);
  console.log(`2. 在 .env 里设置 XHS_SOURCE_MODE="local_browser"`);
  console.log(`3. 确认 XHS_LOCAL_BROWSER_DEBUG_URL="http://127.0.0.1:${port}"`);
  console.log("4. 保持这个浏览器开着，再回到妆迹聊天页搜索妆容。");
});
