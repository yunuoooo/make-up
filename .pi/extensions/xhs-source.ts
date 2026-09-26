import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createXhsClient, SHAPE_DRIFT_CODE, XhsApiError, type XhsClient } from "../../lib/xhs/tikhub.ts";
import type { XhsNoteDetail, XhsNoteSummary, XhsTranscriptIssue } from "../../lib/xhs/types.ts";

/**
 * 小红书数据源的工具层：把「搜索 + 详情」两个只读能力交给模型，数据源藏在下面。
 *
 * 取数只有一条链路：TikHub（`lib/xhs/tikhub.ts`）。2026-09-24 之前还有一条本地 MCP 回退
 * 路径，已随 Phase D 清账删除——所以这里没有模式分支，只剩「api」和「没配好就降级」。
 *
 * 两道闸门都在**发出请求之前**判断：未知 noteId 不发请求、超预算不发请求、未配凭据不发请求。
 * 技能是行为引导，模型可以忽略；工具层是硬拦，模型绕不过去。
 *
 * 端点、字段、两层信封、计费陷阱一律见 docs/specs/09-24-tikhub-xhs-ssot.md。
 */

type Mode = "api" | "unavailable";

type Refusal = { reason: string; message: string };

/** 本轮（= 一次 pi 进程 = 一条用户消息）的状态，随扩展实例生灭。 */
type TurnState = {
  /** noteId → 搜索结果里记下的类型；详情只在「本轮搜索返回过」的 id 上调用。 */
  seen: Map<string, string | undefined>;
  searchCalls: number;
  detailCalls: number;
  /** 累计上游耗时（不含模型思考），超过预算就不再发请求。 */
  upstreamMs: number;
  /** 配额、凭据这类问题一旦出现就整批停止——重试只会继续烧额度。 */
  stopped: Refusal | null;
  /** 上游「报成功却没内容」的连续次数；连续两篇就停止开新笔记（采集侧的问题，换篇也没用）。 */
  consecutiveEmptyDetails: number;
  /** 采集侧失败后只停详情，不停搜索——搜索本身是好的，没必要把整轮掐死。 */
  detailStopped: Refusal | null;
};

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readMode(env: Record<string, string | undefined>): Mode {
  // 除了 api，任何值（含 mock、留空、写错）都按「没有这条数据源」处理：
  // 不发请求，也不伪装成真实来源。这条是保险丝，不是开关。
  return (env.XHS_SOURCE_MODE ?? "api").trim().toLowerCase() === "api" ? "api" : "unavailable";
}

function isTimeout(error: unknown): boolean {
  const value = error as { name?: string; message?: string } | null;
  return value?.name === "TimeoutError" || /aborted due to timeout|timed out/i.test(value?.message ?? "");
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
    // 只有视频笔记有的两个：`durationSeconds` 统一成秒，`transcript` 是带 `[MM:SS]` 的纯文本。
    // `transcriptIssue` **不进这里**——它是「字幕为什么没拿到」，属于工具结果而不是笔记本身。
    ...(note.durationSeconds ? { durationSeconds: note.durationSeconds } : {}),
    text: note.text,
    tags: note.tags,
    ...(note.stats ? { stats: note.stats } : {}),
    images: note.images,
    ...(note.transcript ? { transcript: note.transcript } : {}),
    truncated: note.truncated
  };
}

/**
 * 字幕缺失时交给模型的那句话（视频理解规格第 4.2 节）。
 *
 * **不能静默省略**：这个仓库最贵的事故就是「配置错了不报错，只是静默降级」——
 * 模型不知道自己没拿到字幕，就会按「视频我都看过了」往下写。
 */
function transcriptNotice(issue: XhsTranscriptIssue): string {
  if (issue.reason === "no-voice") {
    return "这条视频没有人声讲解（多半是配乐 + 字幕贴纸），拿不到口播内容，不要再花预算在它身上。";
  }
  if (issue.reason === "no-transcript") {
    return "这条视频没有字幕轨道，只能靠标题、正文和封面，不要编造视频里的画面细节。";
  }
  return `字幕没取到（${issue.detail}），只能靠标题、正文和封面，不要编造视频里的画面细节。`;
}

/** 上游失败 → 可读文本 + 停止标记。不把请求头、token 或 URL 带进任何信息。 */
function apiFailure(state: TurnState, error: unknown): Error {
  if (error instanceof XhsApiError) {
    if (error.code === SHAPE_DRIFT_CODE) {
      // 信封正常、只是字段不认识：重试和换 token 都没用，把上游字段名原样交给模型和维护者。
      return new Error(`小红书取数读不出正文：${error.message}。这不是网络或权限问题，换一篇；多篇都这样就是上游改了字段。`);
    }
    if (error.quotaLimited) {
      state.stopped = { reason: "quota-exhausted", message: "限流或套餐额度用尽" };
      return new Error(
        `小红书取数被限流或套餐额度已用尽（HTTP ${error.code}），本轮剩余请求已全部停止。`
        + "不要再换关键词重试，请按已经拿到的内容如实说明样本量。"
      );
    }
    if (error.authFailed) {
      state.stopped = { reason: "auth-failed", message: "凭据无效或无权" };
      return new Error(
        `小红书取数凭据无效或无权（HTTP ${error.code}），本轮停止取数。`
        + "请按已经拿到的内容如实说明，并提示维护者检查 XHS_API_TOKEN。"
      );
    }
    if (error.billed) {
      // TikHub 的「服务异常」也是计费的：重试等于再付一次，所以文案要说清这次已经花过钱。
      return new Error(`小红书取数失败：${error.message}。这一次调用已经计费，不要重试同一篇，按已拿到的内容如实说明。`);
    }
    return new Error(`小红书取数失败（HTTP ${error.code}）：${error.message}。按实际样本量如实说明。`);
  }
  if (isTimeout(error)) return new Error("小红书取数超时，本轮该次调用失败。按已拿到的内容如实说明样本量。");
  return new Error(`小红书取数失败：${error instanceof Error ? error.message : String(error)}`);
}

export default async function xhsSourceExtension(pi: ExtensionAPI): Promise<void> {
  const env = process.env;
  const mode = readMode(env);

  const searchPages = positiveInt(env.XHS_API_SEARCH_PAGES, 2);
  const detailLimit = positiveInt(env.XHS_API_DETAIL_LIMIT, 10);
  const budgetMs = positiveInt(env.XHS_API_BUDGET_SECONDS, 60) * 1000;

  const state: TurnState = {
    seen: new Map(),
    searchCalls: 0,
    detailCalls: 0,
    upstreamMs: 0,
    stopped: null,
    consecutiveEmptyDetails: 0,
    detailStopped: null
  };

  const client: XhsClient | null = mode === "api" ? createXhsClient({ env }) : null;

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
    if (kind === "detail" && state.detailStopped) return state.detailStopped;
    if (mode === "unavailable") {
      return {
        reason: "not-configured",
        message: `小红书数据源未启用（XHS_SOURCE_MODE=${env.XHS_SOURCE_MODE ?? "未设置"}）。本轮没有实时站内检索，请直说这一点，`
          + "可以改用用户提供的笔记链接、文字或截图继续分析。"
      };
    }
    if (!client?.configured) {
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
    // 只允许打开本轮搜索真实返回过的笔记。防幻觉、防用户消息里的 id 直接变成一次计费调用；
    // TikHub 对无效 id 也计费，所以这道闸门从「省时间」变成了「省钱」。
    if (kind === "detail" && noteId && !state.seen.has(noteId)) {
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

  pi.registerTool({
    name: "xhs_source_status",
    label: "XHS Source Status",
    description: "报告小红书数据源的状态：是否已配置、本轮已用的搜索与详情次数。不返回任何凭据。",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{
          type: "text",
          text: jsonText({
            source: mode === "api" ? "tikhub" : "none",
            mode,
            configured: mode === "api" && Boolean(client?.configured),
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
    description: "在小红书按关键词搜索笔记，**图文与视频一起返回**（不再按笔记类型过滤），"
      + "返回标题、作者、发布时间、互动数、封面、笔记类型（noteType：normal 图文 / video 视频），"
      + "以及一段约 60 字的**截断预览**。"
      + "预览不是正文，任何情况下都不能当正文用；要读正文（视频还会带上口播字幕）请用 xhs_get_note_detail。"
      + "搜索只负责定位，用来决定打开哪几篇；搜不到就换关键词或拆条件。",
    parameters: Type.Object({
      keyword: Type.String({ description: "搜索关键词，例如 `韩系氧气妆 教程`" }),
      page: Type.Optional(Type.Number({ description: "页码，从 1 开始，默认 1" })),
      sortType: Type.Optional(Type.String({
        description: "排序：general 综合（默认）/ time_descending 最新 / popularity_descending 最多点赞 / comment_descending 最多评论 / collect_descending 最多收藏"
      }))
    }),
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as { keyword?: unknown; page?: unknown; sortType?: unknown };
      const keyword = typeof args.keyword === "string" ? args.keyword.trim() : "";
      if (!keyword) return refusal({ reason: "bad-argument", message: "keyword 不能为空。" });
      const page = Number.isFinite(Number(args.page)) && Number(args.page) > 0 ? Math.floor(Number(args.page)) : 1;

      const gate = blocked("search");
      if (gate) return refusal(gate);

      try {
        const result = await timed(() => client!.searchNotes(keyword, { page }));
        state.searchCalls += 1;
        for (const note of result.notes) state.seen.set(note.noteId, note.noteType);
        return {
          content: [{
            type: "text",
            text: jsonText({
              source: "tikhub",
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
    description: "读取一篇笔记的正文全文、话题和图片。视频笔记还会一并带上**口播字幕**（带 `[MM:SS]` 时间戳的纯文本），"
      + "不需要额外动作；引用视频结论时带上时间戳。"
      + "视频没有字幕时笔记照常返回，并带 `reason`（no-voice 没有人声 / no-transcript 没有字幕轨 / transcript-failed 字幕没取到），"
      + "遇到就如实说明并降级到标题、正文和封面，**不要编造视频里的画面细节**。"
      + `只能读本轮 xhs_search_notes 返回过的 noteId，本轮最多读 ${detailLimit} 篇。`
      + "正文全文只有这个工具给得到，搜索里的预览不能替代。",
    parameters: Type.Object({
      noteId: Type.String({ description: "笔记 ID，取自 xhs_search_notes 的返回" })
    }),
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as { noteId?: unknown };
      const noteId = typeof args.noteId === "string" ? args.noteId.trim() : "";
      if (!noteId) return refusal({ reason: "bad-argument", message: "noteId 不能为空。" });

      const gate = blocked("detail", noteId);
      if (gate) return refusal(gate);

      try {
        // 类型取自本轮搜索结果（`seen` 里白拿），详情按它分流到图文或视频端点——
        // 必须在**调用前**定：两个端点形状不同，而每次尝试都计费（视频理解规格第 3.2 节）。
        const note = await timed(() => client!.getNoteDetail(noteId, { noteType: state.seen.get(noteId) }));
        state.detailCalls += 1;
        if (!note) {
          // 上游「报成功却没内容」，与「字段不认识」是两回事：这条是采集侧，那条是契约侧。
          // TikHub 是响应即计费，所以这种空内容也已经花过钱——文案要说清。
          state.consecutiveEmptyDetails += 1;
          if (state.consecutiveEmptyDetails >= 2) {
            state.detailStopped = {
              reason: "collection-failed",
              message: "上游连续两篇都报成功却没有内容——这是采集侧的问题，不是这些笔记的问题，"
                + "而且每次这样的调用都已计费。不要再打开新笔记，按已经拿到的搜索结果如实说明样本不足。"
            };
            return refusal(state.detailStopped);
          }
          return refusal({
            reason: "empty-result",
            message: `笔记 ${noteId} 上游返回的成功响应里没有内容（这一次调用已计费），换下一篇。`
          });
        }
        state.consecutiveEmptyDetails = 0;
        // 字幕缺失是**预期内结果**：笔记照样返回，只把原因和一句人话一并交给模型。
        const issue = note.transcriptIssue;
        return {
          content: [{
            type: "text",
            text: jsonText({
              source: "tikhub",
              mode,
              ...(issue ? { reason: issue.reason, message: transcriptNotice(issue) } : {}),
              note: detailShape(note)
            })
          }],
          details: details(issue ? { reason: issue.reason } : {})
        };
      } catch (error) {
        throw apiFailure(state, error);
      }
    }
  });

  pi.registerCommand("xhs-status", {
    description: "Show the Xiaohongshu data source status",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const configured = mode === "api" && Boolean(client?.configured);
      const label = mode === "unavailable"
        ? `XHS source disabled (XHS_SOURCE_MODE=${env.XHS_SOURCE_MODE ?? "unset"})`
        : `XHS source: tikhub${configured ? "" : " (未配置凭据)"} · 本轮 search ${state.searchCalls}/${searchPages} · detail ${state.detailCalls}/${detailLimit}`;
      ctx.ui.notify(label, configured ? "info" : "warning");
    }
  });
}
