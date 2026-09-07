import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function resolveDataDir(): string {
  if (process.env.LOCAL_DATA_DIR) return process.env.LOCAL_DATA_DIR;

  if (process.env.VERCEL || process.cwd().startsWith("/var/task")) {
    return path.join("/tmp", "looktrace-local-data");
  }

  return path.join(process.cwd(), ".local-data");
}

const dataDir = resolveDataDir();

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
  await writeFile(path.join(dataDir, fileName), JSON.stringify(data, null, 2), "utf8");
}

export function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
