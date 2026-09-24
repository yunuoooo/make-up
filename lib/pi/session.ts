import { open, readdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * 会话 id 由客户端提供，并且会成为文件名的一部分，规则必须和 pi 保持一致
 * （`@earendil-works/pi-coding-agent/dist/core/session-manager.js` 的 assertValidSessionId）。
 * 不合法时 pi 自己会 `process.exit(1)`，那样我们只能拿到一行 stderr；
 * 在这里先判掉，才能给前端一个正常的 400。
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const MAX_SESSION_ID_LENGTH = 128;
const SESSION_FILE_SUFFIX = ".jsonl";

/** 本地状态只涨不落是事故的温床：老会话按时间过期，剩下的按条数封顶。 */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_MAX_COUNT = 30;

export function isValidSessionId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_SESSION_ID_LENGTH && SESSION_ID_PATTERN.test(id);
}

/** pi 的会话根目录 = `<PI_CODING_AGENT_DIR>/sessions`。 */
export function resolveSessionsRoot(stateDir: string): string {
  return join(stateDir, "sessions");
}

/**
 * pi 按工作目录分目录存放会话，目录名是 cwd 去掉前导斜杠后把 `/`、`:` 换成 `-`，
 * 两边各补 `--`（`session-manager.js` 的 getDefaultSessionDirPath）。
 * 例：`/Users/william/make-up` → `--Users-william-make-up--`。
 */
export function projectSessionDirName(cwd: string): string {
  return `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function projectSessionDir(cwd: string, stateDir: string): string {
  return join(resolveSessionsRoot(stateDir), projectSessionDirName(cwd));
}

/**
 * 只读文件头一行确认 id：会话头是小 JSON，没必要为了验证身份把整份会话读进内存。
 * 读不满一行（头被 4 KB 截断）时 JSON.parse 会失败，按"不认识"处理。
 */
async function readSessionHeaderId(file: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
    const header = JSON.parse(line) as { type?: string; id?: string };
    return header.type === "session" && typeof header.id === "string" ? header.id : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * 找到 pi 在这个项目里为 sessionId 建的那份会话文件。
 *
 * pi 的文件名是 `<时间戳>_<id>.jsonl`（`session-manager.js` 里 `join(dir, \`${fileTimestamp}_${id}.jsonl\`)`），
 * 所以先按后缀筛，再读文件头确认——后缀会被更长的 id 撞上（`a_conv_1` 也以 `_conv_1.jsonl` 结尾）。
 */
export async function findSessionFile(cwd: string, sessionId: string, stateDir: string): Promise<string | null> {
  if (!isValidSessionId(sessionId)) return null;

  let entries: string[];
  try {
    entries = await readdir(projectSessionDir(cwd, stateDir));
  } catch {
    return null; // 这个项目还没有任何会话文件。
  }

  const suffix = `_${sessionId}${SESSION_FILE_SUFFIX}`;
  for (const entry of entries) {
    if (!entry.endsWith(suffix)) continue;
    const file = join(projectSessionDir(cwd, stateDir), entry);
    if (await readSessionHeaderId(file) === sessionId) return file;
  }
  return null;
}

/** 删除一份服务端会话；没有对应文件时返回 false，调用方据此回 404。 */
export async function deleteSession(cwd: string, sessionId: string, stateDir: string): Promise<boolean> {
  const file = await findSessionFile(cwd, sessionId, stateDir);
  if (!file) return false;
  try {
    await unlink(file);
    return true;
  } catch {
    return false;
  }
}

export type PruneResult = { scanned: number; deleted: number };

/**
 * 清理本项目的会话文件：先按最后活动时间过期，再按条数封顶。
 *
 * 只看 mtime 和文件名，不解析会话内容——清理是顺手做的事，不值得为它读一遍全部会话。
 * 文件在列举与删除之间被别处删掉时忽略，下一轮再对账。
 */
export async function pruneSessions(
  cwd: string,
  stateDir: string,
  options: { maxAgeMs?: number; maxCount?: number; now?: number } = {}
): Promise<PruneResult> {
  const maxAgeMs = options.maxAgeMs ?? SESSION_MAX_AGE_MS;
  const maxCount = options.maxCount ?? SESSION_MAX_COUNT;
  const now = options.now ?? Date.now();
  const dir = projectSessionDir(cwd, stateDir);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { scanned: 0, deleted: 0 };
  }

  const files: { file: string; modifiedAt: number }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(SESSION_FILE_SUFFIX)) continue;
    const file = join(dir, entry);
    try {
      const info = await stat(file);
      if (info.isFile()) files.push({ file, modifiedAt: info.mtimeMs });
    } catch {
      // 文件刚被删或权限变化：跳过，不中断整轮清理。
    }
  }

  // 新的在前：过期和超额两种理由共用同一份有序清单，每个文件只判一次。
  files.sort((left, right) => right.modifiedAt - left.modifiedAt);
  let deleted = 0;
  for (const [index, item] of files.entries()) {
    const expired = now - item.modifiedAt > maxAgeMs;
    const overLimit = index >= maxCount;
    if (!expired && !overLimit) continue;
    try {
      await unlink(item.file);
      deleted += 1;
    } catch {
      // 同上的容错：删不掉就留给下一轮。
    }
  }
  return { scanned: files.length, deleted };
}

const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
const lastPruneAt = new Map<string, number>();

/**
 * 聊天请求路径上的节流清理：每十分钟最多扫一次目录。
 * 清理失败不影响本轮对话，调用方也不必等它——用 void 接住即可。
 */
export function pruneSessionsThrottled(cwd: string, stateDir: string, now = Date.now()): Promise<PruneResult | null> {
  const key = projectSessionDir(cwd, stateDir);
  const last = lastPruneAt.get(key) ?? 0;
  if (now - last < PRUNE_INTERVAL_MS) return Promise.resolve(null);
  lastPruneAt.set(key, now);
  return pruneSessions(cwd, stateDir, { now }).catch(() => ({ scanned: 0, deleted: 0 }));
}
