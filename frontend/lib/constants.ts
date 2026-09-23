import type { ProductFormState } from "./types";

export const CURRENT_USER_ID = "local-user";

/** 与技能 SKILL.md 的用词保持一致，顾问给出的品类能直接落进筛选项。 */
export const CATEGORY_OPTIONS = [
  "底妆",
  "遮瑕",
  "定妆",
  "眉笔",
  "眼影",
  "眼线",
  "睫毛膏",
  "腮红",
  "修容",
  "高光",
  "唇妆",
  "工具"
];

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
