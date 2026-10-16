// 相对路径而不是 `@/`：`test/L1` 用 node 原生测试运行器直接跑这些模块，那边没有
// `@/*` 的路径映射（先例：`frontend/lib/types.ts` 只敢用 type-only 的别名导入）。
import { KIT_CATEGORY_NAMES } from "../../lib/kit/categories.ts";
import type { ProductFormState } from "./types";

export const CURRENT_USER_ID = "local-user";

/**
 * 妆匣的开放开关。
 *
 * 2026-10-16 打开（规格 `docs/specs/10-16-makeup-kit.md` 决策 4）：Agent 现在能通过
 * `kit_list_products` 读到妆匣，录入与筛选因此恢复。关闭期间进去只看到占位卡。
 */
export const IS_LIBRARY_OPEN: boolean = true;

/**
 * 品类筛选项。**从 `lib/kit/categories.ts` 派生，不要在这里另写一份**——
 * 技能文本、工具层归一化和这里必须是同一套（规格第 7.1 节）。
 * 顺序由那边的 `KIT_CATEGORIES` 决定，前端筛选与历史数据都依赖它。
 */
export const CATEGORY_OPTIONS: string[] = [...KIT_CATEGORY_NAMES];

export const SUGGESTED_PROMPTS = [
  "韩系氧气妆",
  "清冷通勤妆",
  "自然消肿眼妆"
];

export const INSPIRATION_PROMPT = "韩系氧气妆";

export const INSPIRATION_IMAGE = "/oxygen-makeup.png";

export const EMPTY_PRODUCT_FORM: ProductFormState = {
  brand: "",
  name: "",
  category: "腮红",
  shade: "",
  colorFamily: "",
  finish: "",
  texture: "",
  effectTags: "",
  notes: ""
};

export const CONVERSATION_STORAGE_KEY = "looktrace.conversations.v1";

/** localStorage 容量有限，只保留最近的若干条对话。 */
export const MAX_CONVERSATIONS = 30;

/**
 * 打开历史对话时的提示：会话上下文保存在服务端（pi 原生 session），
 * 追问会带上前几轮的推荐结论。另见 spec 09-23-conversation-sessions.md。
 */
export const RESUMABLE_NOTICE = "继续追问会带上此前轮次的研究结论，上下文保存在服务端会话里。";

/** 服务端会话已不在（被清理、换机器或清了 .local-data）时的提示：本地历史还在，Agent 从零开始。 */
export const SESSION_MISSING_NOTICE = "服务端已没有这条会话的上下文，本轮从零开始；左侧记录仍可回看。";

export const DISCLAIMER = "建议仅用于妆容与选品，不替代皮肤科诊疗。";
