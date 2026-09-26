import test from "node:test";
import assert from "node:assert/strict";
import { parseXhsReads, summarizeXhsReads } from "../../lib/pi/session-reads.ts";

/**
 * 取数记录的解析：会话文件 → 页面要的那几条。
 *
 * 这里钉的是**认不出来的东西一律跳过、不抛错**：可观测性页面读的是别的进程写的文件，
 * 格式或内容出意外时页面应该是空的或不全的，而不是整页崩掉。
 *
 * 样本按 pi 会话文件的真实形状手写（`session` 头 + `model_change` + message 流），
 * 真实样本见 `.local-data/pi/sessions/`（不进 git）。
 */

const line = (value: unknown) => JSON.stringify(value);

/** 一次工具调用：assistant 里带 `toolCall`（参数在这里），随后是 `toolResult`（返回值）。 */
function toolExchange(options: {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  at?: number;
  isError?: boolean;
  resultAsText?: string;
}) {
  const at = options.at ?? 1790431228452;
  return [
    line({
      type: "message",
      id: `a-${options.callId}`,
      timestamp: new Date(at).toISOString(),
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "我先搜一下" },
          { type: "toolCall", id: options.callId, name: options.name, arguments: options.args }
        ]
      }
    }),
    line({
      type: "message",
      id: `r-${options.callId}`,
      timestamp: new Date(at + 1000).toISOString(),
      message: {
        role: "toolResult",
        toolCallId: options.callId,
        toolName: options.name,
        isError: options.isError ?? false,
        timestamp: at + 1000,
        content: [{ type: "text", text: options.resultAsText ?? JSON.stringify(options.result) }]
      }
    })
  ];
}

const session = [
  line({ type: "session", version: 3, id: "conversation_x", timestamp: "2026-09-26T14:00:09.654Z", cwd: "/tmp" }),
  line({ type: "model_change", id: "m1", parentId: null, provider: "deepseek", modelId: "deepseek-chat" }),
  line({ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "研究亚裔妆" }] } })
];

test("取数记录：搜索与详情各成一条，参数按 toolCallId 对上", () => {
  const jsonl = [
    ...session,
    ...toolExchange({
      callId: "call_search",
      name: "xhs_search_notes",
      args: { keyword: "亚裔妆 教程", page: 1 },
      result: { source: "tikhub", mode: "api", page: 1, hasMore: true, notes: [{ noteId: "n1", title: "T" }] }
    }),
    ...toolExchange({
      callId: "call_detail",
      name: "xhs_get_note_detail",
      args: { noteId: "n1" },
      result: { source: "tikhub", mode: "api", note: { noteId: "n1", noteType: "video", transcript: { lang: "source", text: "[00:01] 上妆前" } } }
    }),
    // 查状态不算取数内容，不进这个页面。
    ...toolExchange({ callId: "call_status", name: "xhs_source_status", args: {}, result: { configured: true } }),
    // read 工具更不算。
    ...toolExchange({ callId: "call_read", name: "read", args: { path: "SKILL.md" }, result: "文件内容" })
  ].join("\n");

  const entries = parseXhsReads(jsonl);
  assert.deepEqual(entries.map((entry) => entry.kind), ["search", "detail"]);
  assert.deepEqual(entries.map((entry) => entry.toolCallId), ["call_search", "call_detail"]);
  assert.deepEqual(entries[0].arg, { keyword: "亚裔妆 教程", page: 1 }, "关键词来自 toolCall 的 arguments");
  assert.deepEqual(entries[1].arg, { noteId: "n1" });
  assert.equal(entries[0].ok, true);
  assert.equal(entries[0].at, 1790431229452, "时间取 toolResult 自己的时间戳（结果回来的那一刻）");
  // payload 就是工具返回的原始 JSON——页面上展示的必须是这一份。
  assert.equal((entries[1].payload?.note as Record<string, unknown>).noteType, "video");
});

test("取数记录：工具参数只留标量（页面要原样展示，不展开对象）", () => {
  const jsonl = [
    ...session,
    ...toolExchange({
      callId: "c1",
      name: "xhs_search_notes",
      args: { keyword: "妆容", nested: { a: 1 }, list: [1, 2], flag: false },
      result: { source: "tikhub", mode: "api", notes: [] }
    })
  ].join("\n");
  assert.deepEqual(parseXhsReads(jsonl)[0].arg, { keyword: "妆容", flag: false });
});

test("取数记录：返回不是 JSON 时保留原文，不抛错", () => {
  const jsonl = [
    ...session,
    ...toolExchange({
      callId: "c1",
      name: "xhs_get_note_detail",
      args: { noteId: "n1" },
      result: null,
      resultAsText: "这不是 JSON：取数读不出正文"
    })
  ].join("\n");

  const [entry] = parseXhsReads(jsonl);
  assert.equal(entry.payload, null);
  assert.match(entry.raw ?? "", /取数读不出正文/, "原文要留着，页面靠它显示「读不出来」");
});

test("取数记录：拒答与空结果照样记一条（最有价值的就是这些）", () => {
  const jsonl = [
    ...session,
    ...toolExchange({
      callId: "c1",
      name: "xhs_get_note_detail",
      args: { noteId: "n1" },
      result: { source: "tikhub", mode: "api", reason: "unknown-note", message: "不在本轮搜索结果里" }
    }),
    ...toolExchange({
      callId: "c2",
      name: "xhs_get_note_detail",
      args: { noteId: "n2" },
      result: { source: "tikhub", mode: "api", note: { noteId: "n2", noteType: "video", title: "T" } },
      resultAsText: "",
      isError: true
    })
  ].join("\n");

  const entries = parseXhsReads(jsonl);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].payload?.reason, "unknown-note");
  assert.equal(entries[1].ok, false, "工具报错也要留下痕迹");
});

test("取数记录：坏行、缺 header、空文件都不崩", () => {
  assert.deepEqual(parseXhsReads(""), []);
  assert.deepEqual(parseXhsReads("这不是 JSONL\n{半行"), []);
  const half = [
    "{坏的",
    line({ type: "session", id: "x" }),
    line({ type: "message", message: { role: "toolResult", toolName: "xhs_search_notes", content: [{ text: "{}" }] } })
  ].join("\n");
  const entries = parseXhsReads(half);
  assert.equal(entries.length, 1, "没有 toolCallId 也照样收，参数为空即可");
  assert.deepEqual(entries[0].arg, {});
});

test("概要：按「有没有拿到字幕」分开数", () => {
  const jsonl = [
    ...session,
    ...toolExchange({ callId: "s1", name: "xhs_search_notes", args: { keyword: "a" }, result: { notes: [] } }),
    ...toolExchange({
      callId: "d1", name: "xhs_get_note_detail", args: { noteId: "n1" },
      result: { note: { noteId: "n1", transcript: { lang: "source", text: "[00:01] x" } } }
    }),
    ...toolExchange({
      callId: "d2", name: "xhs_get_note_detail", args: { noteId: "n2" },
      result: { reason: "no-voice", note: { noteId: "n2" } }
    }),
    ...toolExchange({
      callId: "d3", name: "xhs_get_note_detail", args: { noteId: "n3" },
      result: { reason: "no-transcript", note: { noteId: "n3" } }
    })
  ].join("\n");

  assert.deepEqual(summarizeXhsReads(parseXhsReads(jsonl)), {
    searches: 1,
    details: 3,
    transcripts: 1,
    withoutTranscript: 2
  });
});
