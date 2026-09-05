import type { ProductFormState } from "./types";

export const CURRENT_USER_ID = "local-user";

export const SAMPLE_PROMPTS = [
  "我想要白开水妆，但是不要太甜，要干净低饱和一点",
  "小红书搜清冷骨相妆，我应该买什么化妆品",
  "低饱和雾面通勤妆需要准备哪些产品，直接给候选 SKU"
];

export const CATEGORY_OPTIONS = ["粉底液", "腮红", "眉笔", "唇泥", "唇釉", "修容", "眼影", "卧蚕笔"];

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

export const WELCOME_TURN = {
  id: "welcome",
  role: "assistant" as const,
  text: "告诉我一个文字妆容目标，或者直接输入你想搜索的妆容方向。我会参考互联网信息拆出妆容特点，再看你的妆匣，最后给 SKU 候选。"
};
