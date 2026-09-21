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

/** 打开历史对话时的提示：pi 以 --no-session 运行，每轮都是独立上下文。 */
export const STATELESS_NOTICE = "Agent 每轮独立运行，追问不会带上此前的对话内容。";

export const DISCLAIMER = "建议仅用于妆容与选品，不替代皮肤科诊疗。";
