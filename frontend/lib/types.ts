import type { AgentAnswer, UserProduct } from "@/lib/types/domain";

export type Turn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  answer?: AgentAnswer;
};

export type ProductFormState = {
  brand: string;
  name: string;
  category: string;
  shade: string;
  colorFamily: string;
  finish: string;
  texture: string;
  effectTags: string;
  notes: string;
};

export type ProductFormChange = (field: keyof ProductFormState, value: string) => void;

export type ProductSelection = UserProduct | null;
