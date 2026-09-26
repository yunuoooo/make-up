import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { projectSessionDir } from "./session.ts";

/**
 * 从 pi 的会话文件里把**小红书取数**那几段读回来，给可观测性页面用。
 *
 * 为什么读会话文件而不是另建一份存储：**工具返回的原始 payload 本来就一字不差地存在那里**，
 * 它是「下一轮还能记得上一轮读过什么」的机制本身（见 `lib/pi/session.ts`）。另写一份就等于
 * 把同一件事存两遍，还会漏掉历史。代价是要认 pi 的文件格式——**这是本仓库已经在做的事**
 * （`session.ts` 里的文件名规则、头部格式都照 `session-manager.js` 对齐过），所以不算新增依赖，
 * 但格式变了这里会读不出来：因此解析失败一律**降级成「没有取数记录」而不是报错**，
 * 可观测性页面不该把聊天页弄挂。
 *
 * 只读，不写，不删。
 */

const SESSION_FILE_SUFFIX = ".jsonl";
/** 列表只扫最近这些份会话：可观测性页面不需要把三十份历史全解析一遍。 */
export const READ_SESSIONS_LIMIT = 20;
/** 单份会话最多返回这么多条取数记录（一份长会话可能读了几十篇）。 */
export const READ_ENTRIES_LIMIT = 200;
/** 取数工具名 → 记录类型。`xhs_source_status` 只是查状态，不含帖子内容，不收。 */
const READ_TOOLS: Record<string, "search" | "detail"> = {
  xhs_search_notes: "search",
  xhs_get_note_detail: "detail"
};

export type XhsReadEntry = {
  toolCallId: string;
  kind: "search" | "detail";
  /** 出网时间（毫秒）。 */
  at: number;
  /** 这次调用**要的是什么**：搜索关键词或笔记 id。 */
  arg: Record<string, unknown>;
  ok: boolean;
  /** 工具返回的原始 JSON，**一字未改**——页面要展示的就是它。 */
  payload: Record<string, unknown> | null;
  /** payload 读不出来时保留原文，免得页面上一片空白。 */
  raw?: string;
};

export type XhsReadSession = {
  conversationId: string;
  startedAt: number | null;
  updatedAt: number;
  entries: XhsReadEntry[];
};

/** 列表页要的概要：不带上 payload，免得为了看一眼列表把所有字幕都传一遍。 */
export type XhsReadSummary = {
  conversationId: string;
  startedAt: number | null;
  updatedAt: number;
  searches: number;
  details: number;
  /** 详情里**真正拿到字幕**的篇数。 */
  transcripts: number;
  /** 详情里的失败篇数（`no-voice` / `no-transcript` / `transcript-failed`）。 */
  withoutTranscript: number;
};

/** 会话文件里的一行。只声明用得到的字段，其余一律忽略。 */
type SessionLine = {
  type?: string;
  id?: string;
  timestamp?: string;
  message?: {
    role?: string;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    timestamp?: number;
    content?: Array<{
      type?: string;
      text?: string;
      id?: string;
      name?: string;
      arguments?: unknown;
    }>;
  };
};

function parseLine(line: string): SessionLine | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? (value as SessionLine) : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * `arguments` 是模型给工具的参数。只留标量：它会被原样展示在页面上，
 * 夹带对象的话渲染起来没完没了。
 */
function scalarArgs(value: unknown): Record<string, unknown> {
  const args = asRecord(value);
  if (!args) return {};
  const kept: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(args)) {
    if (item === null || ["string", "number", "boolean"].includes(typeof item)) kept[key] = item;
  }
  return kept;
}

/**
 * 会话文件的全文 → 取数记录。**纯函数**，不碰文件系统，方便直接喂样本测。
 *
 * 工具参数在 assistant 消息的 `toolCall` 块里，返回值在随后的 `toolResult` 消息里，
 * 两者靠 `toolCallId` 对上——所以要先扫一遍收集参数，再按顺序配对。
 */
export function parseXhsReads(jsonl: string): XhsReadEntry[] {
  const lines = jsonl.split("\n").map(parseLine).filter((line): line is SessionLine => line !== null);

  const args = new Map<string, Record<string, unknown>>();
  for (const line of lines) {
    if (line.type !== "message" || line.message?.role !== "assistant") continue;
    for (const part of line.message.content ?? []) {
      if (part?.type !== "toolCall" || typeof part.id !== "string") continue;
      args.set(part.id, scalarArgs(part.arguments));
    }
  }

  const entries: XhsReadEntry[] = [];
  for (const line of lines) {
    const message = line.message;
    if (line.type !== "message" || message?.role !== "toolResult") continue;
    const kind = typeof message.toolName === "string" ? READ_TOOLS[message.toolName] : undefined;
    if (!kind) continue;
    const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
    const text = message.content?.find((part) => typeof part.text === "string")?.text ?? "";
    const at = typeof message.timestamp === "number"
      ? message.timestamp
      : Date.parse(line.timestamp ?? "") || 0;

    const parsed = (() => {
      try {
        return asRecord(JSON.parse(text));
      } catch {
        return null;
      }
    })();

    entries.push({
      toolCallId,
      kind,
      at,
      arg: args.get(toolCallId) ?? {},
      ok: message.isError !== true,
      payload: parsed,
      // 解析不出来时保留原文：可观测性页面宁可显示一段看不懂的文本，也不要空白。
      ...(parsed ? {} : { raw: text.slice(0, 4000) })
    });
  }
  return entries;
}

/** 概要：给列表用。字幕按 `note.transcript` 在不在算。 */
export function summarizeXhsReads(entries: XhsReadEntry[]): Omit<XhsReadSummary, "conversationId" | "startedAt" | "updatedAt"> {
  let searches = 0;
  let details = 0;
  let transcripts = 0;
  let withoutTranscript = 0;
  for (const entry of entries) {
    if (entry.kind === "search") {
      searches += 1;
      continue;
    }
    details += 1;
    const note = asRecord(entry.payload?.note);
    if (asRecord(note?.transcript)) transcripts += 1;
    else withoutTranscript += 1;
  }
  return { searches, details, transcripts, withoutTranscript };
}

/** 会话头一行里的 id（同 `session.ts` 的读法，但这里要的是整份内容，顺手解析即可）。 */
function conversationIdOf(lines: SessionLine[]): string {
  const header = lines.find((line) => line.type === "session");
  return typeof header?.id === "string" ? header.id : "";
}

/**
 * 列出一份会话文件里的取数记录。文件读不出来就返回 null（页面显示「这份读不出来」），
 * **不抛错**：可观测性页面不该因为一份坏文件整页打不开。
 */
export async function readSessionReads(file: string): Promise<XhsReadSession | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n").map(parseLine).filter((line): line is SessionLine => line !== null);
  const entries = parseXhsReads(text);
  if (entries.length === 0) return null;

  const times = entries.map((entry) => entry.at).filter((value) => value > 0);
  const headerAt = Date.parse(lines.find((line) => line.type === "session")?.timestamp ?? "");
  return {
    conversationId: conversationIdOf(lines) || file.replace(/^.*_/, "").replace(SESSION_FILE_SUFFIX, ""),
    startedAt: Number.isFinite(headerAt) ? headerAt : null,
    updatedAt: times.length ? Math.max(...times) : 0,
    entries: entries.slice(0, READ_ENTRIES_LIMIT)
  };
}

/** 会话文件按修改时间倒序，最多 `limit` 份。 */
async function recentSessionFiles(cwd: string, stateDir: string, limit: number): Promise<string[]> {
  const dir = projectSessionDir(cwd, stateDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: { file: string; modifiedAt: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(SESSION_FILE_SUFFIX)) continue;
    const file = join(dir, name);
    try {
      const info = await stat(file);
      if (info.isFile()) files.push({ file, modifiedAt: info.mtimeMs });
    } catch {
      // 刚被清理掉：跳过。
    }
  }
  return files
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, limit)
    .map((item) => item.file);
}

/** 所有最近会话的概要（新的在前）。解析不出来或没有取数记录的会话直接跳过。 */
export async function listXhsReads(cwd: string, stateDir: string, limit = READ_SESSIONS_LIMIT): Promise<XhsReadSummary[]> {
  const files = await recentSessionFiles(cwd, stateDir, limit);
  const summaries: XhsReadSummary[] = [];
  for (const file of files) {
    const session = await readSessionReads(file);
    if (!session) continue;
    summaries.push({
      conversationId: session.conversationId,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      ...summarizeXhsReads(session.entries)
    });
  }
  return summaries.sort((left, right) => right.updatedAt - left.updatedAt);
}

/** 找一份会话的取数记录。找不到返回 null（调用方据此回 404）。 */
export async function findXhsReads(cwd: string, stateDir: string, conversationId: string): Promise<XhsReadSession | null> {
  const files = await recentSessionFiles(cwd, stateDir, READ_SESSIONS_LIMIT);
  for (const file of files) {
    // 文件名以 `<时间戳>_<id>.jsonl` 结尾，先按后缀粗筛再读内容确认，理由同 `session.ts`。
    if (!file.endsWith(`_${conversationId}${SESSION_FILE_SUFFIX}`)) continue;
    const session = await readSessionReads(file);
    if (session && session.conversationId === conversationId) return session;
  }
  return null;
}
