import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const dataDir = path.join(process.cwd(), ".local-data");

export async function readJson<T>(fileName: string, fallback: T): Promise<T> {
  try {
    const text = await readFile(path.join(dataDir, fileName), "utf8");
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson<T>(fileName: string, data: T): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const target = path.join(dataDir, fileName);
  // 先写临时文件再 rename：裸 writeFile 被 SIGTERM 截断会留下半个 JSON，而上面的
  // readJson 遇到解析失败是**返回 fallback** 的，user-products 又是「读-改-写」——
  // 读到 [] 之后下一次写入就把 [] 固化了。部署每次都会停一次服务，这个 race 于是
  // 从偶发变成每次发版都掷一次骰子。
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
