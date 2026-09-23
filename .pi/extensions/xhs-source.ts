import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createXhsClient, XhsApiError, type XhsClient } from "../../lib/xhs/justoneapi.ts";
import { createMcpSource, type McpSource } from "../../lib/xhs/mcp-source.ts";
import type { XhsNoteDetail, XhsNoteSummary } from "../../lib/xhs/types.ts";

/**
 * 小红书数据源的工具层：把「搜索 + 详情」两个只读能力交给模型，数据源本身藏在下面。
 *
 * - 工具名与数据源解耦（`XHS_SOURCE_MODE=api|mcp` 共用同名），迁移期切换模式时技能、
 *   系统提示词、事件映射和前端图标都不需要改。
 * - 两道闸门都在**发出请求之前**判断：未知 noteId 不发请求、超预算不发请求、未配凭据不发请求。
 *   技能是行为引导，模型可以忽略；工具层是硬拦，模型绕不过去。
 * - 失败返回可读文本并带上 `reason`，让模型能按技能要求如实说明样本量和限制。
 *
 * 端点、字段、错误码一律见 docs/specs/09-24-justoneapi-xhs-ssot.md；
 * 架构决策与改动面见 docs/specs/09-24-xhs-api-integration.md。
 */

type Mode = "api" | "mcp" | "unavailable";

type Refusal = { reason: string; message: string };

/** 本轮（= 一次 pi 进程 = 一条用户消息）的状态，随扩展实例生灭。 */
type TurnState = {
  /** noteId → 搜索结果里记下的类型与（mcp 模式的）xsec_token。 */
  seen: Map<string, { noteType?: string; xsecToken?: string }>;
  /** mcp 模式：本次运行里读失败过的笔记，别让模型反复撞同一个超时窗口。 */
  unreadable: Map<string, string>;
  searchCalls: number;
  detailCalls: number;
  /** 累计上游耗时（不含模型思考），超过预算就不再发请求。 */
  upstreamMs: number;
  /** 配额、余额、凭据这类问题一旦出现就整批停止——重试只会继续烧配额。 */
  stopped: Refusal | null;
};

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readMode(env: Record<string, string | undefined>): Mode {
  const raw = (env.XHS_SOURCE_MODE ?? "mcp").trim().toLowerCase();
  if (raw === "api") return "api";
  if (raw === "mcp") return "mcp";
  // mock 与未知值都按「没有这条数据源」处理：不发请求，也不伪装成真实来源。
  return "unavailable";
}

function isTimeout(error: unknown): boolean {
  const value = error as { name?: string; message?: string } | null;
  return value?.name === "TimeoutError" || /aborted due to timeout|timed out/i.test(value?.message ?? "");
}

/** mcp 模式：从 search_feeds 的返回里记下每条笔记的类型与 xsec_token。 */
function rememberFeeds(state: TurnState, text: string): void {
  try {
    const parsed = JSON.parse(text);
    for (const feed of Array.isArray(parsed?.feeds) ? parsed.feeds : []) {
      const id = typeof feed?.id === "string" ? feed.id : "";
      if (!id) continue;
      state.seen.set(id, {
        noteType: typeof feed?.noteCard?.type === "string" ? feed.noteCard.type : undefined,
        xsecToken: typeof feed?.xsecToken === "string" ? feed.xsecToken
          : typeof feed?.xsec_token === "string" ? feed.xsec_token : undefined
      });
    }
  } catch {
    // 解析不出来就不记：类型未知时按原样放行，不因为解析失败而误拦（旧行为不变）。
  }
}

function jsonText(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

/** 摘要形状：图上/答案里只用标题、作者、日期和预览，正文只走详情。 */
function summaryShape(note: XhsNoteSummary): Record<string, unknown> {
  return {
    noteId: note.noteId,
    title: note.title,
    ...(note.authorName ? { authorName: note.authorName } : {}),
    ...(note.noteType ? { noteType: note.noteType } : {}),
    ...(note.postedAt ? { postedAt: note.postedAt } : {}),
    ...(note.stats ? { stats: note.stats } : {}),
    ...(note.preview ? { preview: note.preview } : {}),
    ...(note.cover ? { cover: note.cover } : {})
  };
}

function detailShape(note: XhsNoteDetail): Record<string, unknown> {
  return {
    noteId: note.noteId,
    title: note.title,
    ...(note.authorName ? { authorName: note.authorName } : {}),
    ...(note.noteType ? { noteType: note.noteType } : {}),
    ...(note.postedAt ? { postedAt: note.postedAt } : {}),
    ...(note.ipLocation ? { ipLocation: note.ipLocation } : {}),
    text: note.text,
    tags: note.tags,
    ...(note.stats ? { stats: note.stats } : {}),
    images: note.images,
    truncated: note.truncated
  };
}

/** 上游失败 → 可读文本 + 停止标记。不把请求 URL 或凭据带进任何信息。 */
function apiFailure(state: TurnState, error: unknown): Error {
  if (error instanceof XhsApiError) {
    if (error.quotaLimited) {
      state.stopped = { reason: "quota-exhausted", message: "配额或余额不足" };
      return new Error(
        `小红书取数配额或余额不足（上游 code=${error.code}），本轮剩余请求已全部停止。`
        + "不要再换关键词重试，请按已经拿到的内容如实说明样本量。"
      );
    }
    if (error.authFailed) {
      state.stopped = { reason: "auth-failed", message: "凭据失效或权限不足" };
      return new Error(
        `小红书取数凭据失效或权限不足（上游 code=${error.code}），本轮停止取数。`
        + "请按已经拿到的内容如实说明，并提示维护者检查 XHS_API_TOKEN 是否包含小红书端点权限。"
      );
    }
    return new Error(`小红书取数失败（上游 code=${error.code}）：${error.message}。按实际样本量如实说明。`);
  }
  if (isTimeout(error)) return new Error("小红书取数超时，本轮该次调用失败。按已拿到的内容如实说明样本量。");
  return new Error(`小红书取数失败：${error instanceof Error ? error.message : String(error)}`);
}

export default async function xhsSourceExtension(pi: ExtensionAPI): Promise<void> {
  const env = process.env;
  const mode = readMode(env);

  const searchPages = positiveInt(env.XHS_API_SEARCH_PAGES, 2);
  const detailLimit = positiveInt(env.XHS_API_DETAIL_LIMIT, 6);
  const budgetMs = positiveInt(env.XHS_API_BUDGET_SECONDS, 60) * 1000;

  const state: TurnState = {
    seen: new Map(),
    unreadable: new Map(),
    searchCalls: 0,
    detailCalls: 0,
    upstreamMs: 0,
    stopped: null
  };

  let client: XhsClient | null = null;
  let mcp: McpSource | null = null;
  if (mode === "api") client = createXhsClient({ env });
  if (mode === "mcp") mcp = createMcpSource();

  /** 每个工具结果都带上的计数：配额烧了多少，只有这里能看见。 */
  function details(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      endpoint: "xhs",
      mode,
      calls: { search: state.searchCalls, detail: state.detailCalls },
      ...extra
    };
  }

  function refusal(refusal: Refusal): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } {
    return {
      content: [{ type: "text", text: jsonText({ source: "xhs", mode, reason: refusal.reason, message: refusal.message }) }],
      details: details({ reason: refusal.reason })
    };
  }

  /** 所有闸门的唯一入口：按顺序判，先满足的先拒。 */
  function blocked(kind: "search" | "detail", noteId?: string): Refusal | null {
    if (state.stopped) return state.stopped;
    if (mode === "unavailable") {
      return {
        reason: "not-configured",
        message: "小红书数据源未启用（XHS_SOURCE_MODE 不是 api 或 mcp）。本轮没有实时站内检索，请直说这一点，"
          + "可以改用用户提供的笔记链接、文字或截图继续分析。"
      };
    }
    if (mode === "api" && !client?.configured) {
      return {
        reason: "not-configured",
        message: "小红书数据源未配置（XHS_API_TOKEN 为空）。本轮没有实时站内检索，请直说这一点，"
          + "可以改用用户提供的笔记链接、文字或截图继续分析。"
      };
    }
    if (state.upstreamMs >= budgetMs) {
      return { reason: "budget-exhausted", message: `本轮取数预算（${budgetMs / 1000} 秒）已用尽，不再发起新的请求。按已拿到的内容如实说明样本量。` };
    }
    if (kind === "search" && state.searchCalls >= searchPages) {
      return { reason: "budget-exhausted", message: `本轮搜索次数上限（${searchPages} 页）已用尽。按已拿到的内容如实说明样本量，不要重复搜索同一个关键词。` };
    }
    if (kind === "detail" && state.detailCalls >= detailLimit) {
      return { reason: "budget-exhausted", message: `本轮详情篇数上限（${detailLimit} 篇）已用尽。按已读到的正文如实说明样本量，不要重复读同一篇。` };
    }
    // api 模式：只允许打开本轮搜索真实返回过的笔记。防幻觉、防用户消息里的 id 直接变成一次计费调用。
    if (kind === "detail" && mode === "api" && noteId && !state.seen.has(noteId)) {
      return {
        reason: "unknown-note",
        message: "这个 noteId 不在本轮搜索结果里，已拒绝（不发起请求）。请先用 xhs_search_notes 找到笔记，再打开其中的一条。"
      };
    }
    return null;
  }

  async function timed<T>(run: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await run();
    } finally {
      state.upstreamMs += performance.now() - startedAt;
    }
  }

  const searchDescription = mode === "mcp"
    ? "在小红书按关键词搜索笔记，返回笔记卡片（标题、作者、类型、互动数、封面）。"
      + "结果里 noteCard.type 为 normal 的是图文笔记，video 是视频笔记。"
      + "搜索只负责定位；**搜索卡片不是正文**，要读正文请用 xhs_get_note_detail。"
    : "在小红书按关键词搜索笔记，返回标题、作者、发布时间、互动数、封面，以及一段约 60 字的**截断预览**。"
      + "预览不是正文，任何情况下都不能当正文用；要读正文请用 xhs_get_note_detail。"
      + "搜索只负责定位，用来决定打开哪几篇。";

  const detailDescription = mode === "mcp"
    ? "读取一篇笔记的详情。**本地约束：只对本轮搜索结果里 noteCard.type 为 normal 的图文笔记调用。**"
      + "视频笔记会被本地直接拒绝（上游读取视频笔记必卡满 60 秒才超时），不要尝试。"
      + `本轮最多读 ${detailLimit} 篇。详情读不出来时直接换搜索结果里的下一篇，不要重试同一篇。`
    : "读取一篇笔记的正文全文、话题和图片。只能读本轮 xhs_search_notes 返回过的 noteId，"
      + `本轮最多读 ${detailLimit} 篇。正文全文只有这个工具给得到，搜索里的预览不能替代。`;

  pi.registerTool({
    name: "xhs_source_status",
    label: "XHS Source Status",
    description: "报告小红书数据源的状态：当前模式、是否已配置、本轮已用的搜索与详情次数。不返回任何凭据。",
    parameters: Type.Object({}),
    async execute() {
      if (mode === "mcp" && mcp) {
        try {
          const { text } = await timed(() => mcp!.callTool("check_login_status", {}));
          return {
            content: [{ type: "text", text: jsonText({ source: "mcp", mode, message: text }) }],
            details: details()
          };
        } catch (error) {
          throw apiFailure(state, error);
        }
      }
      const configured = mode === "api" ? Boolean(client?.configured) : mode === "mcp";
      return {
        content: [{
          type: "text",
          text: jsonText({
            source: mode === "api" ? "justoneapi" : "none",
            mode,
            configured,
            limits: { searchPages, detailLimit, budgetSeconds: Math.round(budgetMs / 1000) },
            calls: { search: state.searchCalls, detail: state.detailCalls },
            upstreamMs: Math.round(state.upstreamMs),
            ...(state.stopped ? { stopped: state.stopped.reason } : {})
          })
        }],
        details: details()
      };
    }
  });

  pi.registerTool({
    name: "xhs_search_notes",
    label: "XHS Search Notes",
    description: searchDescription,
    parameters: Type.Object({
      keyword: Type.String({ description: "搜索关键词，例如 `韩系氧气妆 教程`" }),
      page: Type.Optional(Type.Number({ description: "页码，从 1 开始，默认 1" })),
      sortType: Type.Optional(Type.String({
        description: "排序：general 综合（默认）/ popularity_descending 热度 / time_descending 时间 / comment_descending 评论数 / collect_descending 收藏数"
      }))
    }),
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as { keyword?: unknown; page?: unknown; sortType?: unknown };
      const keyword = typeof args.keyword === "string" ? args.keyword.trim() : "";
      if (!keyword) return refusal({ reason: "bad-argument", message: "keyword 不能为空。" });
      const page = Number.isFinite(Number(args.page)) && Number(args.page) > 0 ? Math.floor(Number(args.page)) : 1;

      const gate = blocked("search");
      if (gate) return refusal(gate);

      if (mode === "mcp" && mcp) {
        try {
          const { text } = await timed(() => mcp!.callTool("search_feeds", {
            keyword,
            ...(page > 1 ? { page } : {}),
            ...(typeof args.sortType === "string" && args.sortType ? { sortType: args.sortType } : {})
          }));
          state.searchCalls += 1;
          // 搜索结果同时是笔记类型的来源：记下来，详情才知道该不该拦。
          rememberFeeds(state, text);
          return { content: [{ type: "text", text }], details: details() };
        } catch (error) {
          throw apiFailure(state, error);
        }
      }

      try {
        const result = await timed(() => client!.searchNotes(keyword, { page }));
        state.searchCalls += 1;
        for (const note of result.notes) state.seen.set(note.noteId, { noteType: note.noteType });
        return {
          content: [{
            type: "text",
            text: jsonText({
              source: "justoneapi",
              mode,
              page: result.page,
              hasMore: result.hasMore,
              notes: result.notes.map(summaryShape)
            })
          }],
          details: details(result.notes.length === 0 ? { reason: "empty-result" } : {})
        };
      } catch (error) {
        throw apiFailure(state, error);
      }
    }
  });

  pi.registerTool({
    name: "xhs_get_note_detail",
    label: "XHS Note Detail",
    description: detailDescription,
    parameters: Type.Object({
      noteId: Type.String({ description: "笔记 ID，取自 xhs_search_notes 的返回" })
    }),
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as { noteId?: unknown };
      const noteId = typeof args.noteId === "string" ? args.noteId.trim() : "";
      if (!noteId) return refusal({ reason: "bad-argument", message: "noteId 不能为空。" });

      const gate = blocked("detail", noteId);
      if (gate) return refusal(gate);

      if (mode === "mcp" && mcp) {
        const known = state.seen.get(noteId);
        // 视频笔记在这里就挡掉，不发上游请求——上游读取视频笔记必卡满 60 秒才失败。
        if (known?.noteType === "video") {
          return refusal({
            reason: "video-note",
            message: `笔记 ${noteId} 是视频笔记，已跳过。上游读取视频笔记会卡满 60 秒才超时，`
              + "请改用搜索结果里 noteCard.type 为 normal 的图文笔记。"
          });
        }
        if (state.unreadable.has(noteId)) {
          return refusal({
            reason: "unreadable-note",
            message: `笔记 ${noteId} 本次运行中读取失败过（${state.unreadable.get(noteId)}），已跳过。请改用搜索结果里的其他笔记，不要重试这一篇。`
          });
        }
        try {
          // xsec_token 由这里内部补上：它不进模型上下文，也不进答案。
          const { text } = await timed(() => mcp!.callTool("get_feed_detail", {
            feed_id: noteId,
            xsec_token: known?.xsecToken ?? ""
          }));
          state.detailCalls += 1;
          return { content: [{ type: "text", text }], details: details() };
        } catch (error) {
          if (isTimeout(error)) state.unreadable.set(noteId, "读取超时");
          throw apiFailure(state, error);
        }
      }

      try {
        const note = await timed(() => client!.getNoteDetail(noteId));
        state.detailCalls += 1;
        if (!note) {
          return refusal({ reason: "empty-result", message: `笔记 ${noteId} 没有返回详情内容，换下一篇。` });
        }
        return {
          content: [{ type: "text", text: jsonText({ source: "justoneapi", mode, note: detailShape(note) }) }],
          details: details()
        };
      } catch (error) {
        throw apiFailure(state, error);
      }
    }
  });

  pi.registerCommand("xhs-status", {
    description: "Show the Xiaohongshu data source status",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const configured = mode === "api" ? Boolean(client?.configured) : mode === "mcp";
      const label = mode === "unavailable"
        ? `XHS source disabled (XHS_SOURCE_MODE=${env.XHS_SOURCE_MODE ?? "unset"})`
        : `XHS source: ${mode}${configured ? "" : " (未配置凭据)"} · 本轮 search ${state.searchCalls}/${searchPages} · detail ${state.detailCalls}/${detailLimit}`;
      ctx.ui.notify(label, mode === "unavailable" || !configured ? "warning" : "info");
    }
  });
}
