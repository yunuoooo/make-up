"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CONVERSATION_STORAGE_KEY, MAX_CONVERSATIONS } from "@/frontend/lib/constants";
import type { ConversationSummary, Turn } from "@/frontend/lib/types";

type StoredState = {
  conversations: ConversationSummary[];
  turns: Record<string, Turn[]>;
};

const EMPTY_STATE: StoredState = { conversations: [], turns: {} };

function readStoredState(): StoredState {
  if (typeof window === "undefined") return EMPTY_STATE;

  try {
    const raw = window.localStorage.getItem(CONVERSATION_STORAGE_KEY);
    if (!raw) return EMPTY_STATE;
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    return {
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
      turns: parsed.turns && typeof parsed.turns === "object" ? parsed.turns : {}
    };
  } catch {
    return EMPTY_STATE;
  }
}

/**
 * 对话记录只存在浏览器本地：pi 以 --no-session 运行，服务端没有可回放的历史。
 * 这里保存的是"给用户回看"的副本，不是 Agent 的上下文。
 */
export function useConversations(onError: (message: string) => void) {
  const [state, setState] = useState<StoredState>(EMPTY_STATE);
  const [isHydrated, setIsHydrated] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    // localStorage 只有客户端能读，放进 effect 才不会和水合结果打架。
    setState(readStoredState());
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    try {
      window.localStorage.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify(state));
    } catch {
      onError("浏览器暂时无法保存对话记录，请检查隐私或存储设置。");
    }
  }, [isHydrated, onError, state]);

  const load = useCallback((id: string): Turn[] => stateRef.current.turns[id] ?? [], []);

  const save = useCallback((id: string, turns: Turn[], title: string) => {
    setState((current) => {
      const existing = current.conversations.find((conversation) => conversation.id === id);
      const now = new Date().toISOString();
      const summary: ConversationSummary = {
        id,
        title: existing?.title ?? title,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };

      const conversations = [summary, ...current.conversations.filter((item) => item.id !== id)]
        .slice(0, MAX_CONVERSATIONS);
      // 被裁掉的对话连正文一起清掉，否则 localStorage 只涨不落。
      const kept = new Set(conversations.map((conversation) => conversation.id));
      const storedTurns: Record<string, Turn[]> = {};
      for (const [key, value] of Object.entries(current.turns)) {
        if (kept.has(key)) storedTurns[key] = value;
      }
      storedTurns[id] = turns;

      return { conversations, turns: storedTurns };
    });
  }, []);

  const remove = useCallback((id: string) => {
    setState((current) => {
      const storedTurns = { ...current.turns };
      delete storedTurns[id];
      return {
        conversations: current.conversations.filter((conversation) => conversation.id !== id),
        turns: storedTurns
      };
    });
  }, []);

  return { conversations: state.conversations, isHydrated, load, save, remove };
}
