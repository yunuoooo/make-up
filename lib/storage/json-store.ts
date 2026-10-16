import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** 用户数据放哪：默认 `<cwd>/.local-data`；生产上由 `LOOKTRACE_DATA_DIR` 指到发布树外面
 * （`/srv/make-up-shared/.local-data`），这样发版换目录天生碰不到用户数据。
 * 故意写成函数而不是模块级常量：模块级求值隐含依赖「Next 在 import 之前已经读完
 * .env」这个顺序，不留这个坑。 */
function dataDir(): string {
  return process.env.LOOKTRACE_DATA_DIR ?? path.join(process.cwd(), ".local-data");
}

export async function readJson<T>(fileName: string, fallback: T): Promise<T> {
  try {
    const text = await readFile(path.join(dataDir(), fileName), "utf8");
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export type JsonReadResult<T> =
  | { status: "ok"; data: T }
  /** 文件不存在：这是「还没有数据」，不是故障。 */
  | { status: "missing" }
  /** 读到了但读不懂（截断、坏 JSON、权限）。**不能当成空**。 */
  | { status: "corrupt"; error: string };

/**
 * 区分「没有」和「坏了」的读取。
 *
 * `readJson` 对**任何**失败都返回 fallback，这对「读-改-写」的路径是危险的忽略：
 * 文件被截断时它会读成 `[]`（见下面 writeJson 的注释）。展示型调用方无所谓，
 * 但妆匣要如实告诉模型「本轮没取得数据」还是「妆匣是空的」——这两句话对用户的
 * 含义完全相反，混起来模型就会把「没读到」说成「你没有」。
 */
export async function readJsonChecked<T>(fileName: string): Promise<JsonReadResult<T>> {
  let text: string;
  try {
    text = await readFile(path.join(dataDir(), fileName), "utf8");
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") return { status: "missing" };
    return { status: "corrupt", error: error instanceof Error ? error.message : String(error) };
  }

  try {
    return { status: "ok", data: JSON.parse(text) as T };
  } catch (error) {
    return { status: "corrupt", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function writeJson<T>(fileName: string, data: T): Promise<void> {
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, fileName);
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
