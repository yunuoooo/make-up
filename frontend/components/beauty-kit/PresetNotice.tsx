"use client";

import { Button } from "@/frontend/components/ui/button";

/**
 * 「示例妆匣」提示条。
 *
 * 预设套件是**真的写进了用户妆匣**的（否则 Agent 标 `✅` 就是在替用户声称持有，
 * 见 `makeup-kit/SKILL.md:17`）。落库的代价由这条提示条承担：只要库里还有
 * `recordSource === "preset"` 的条目就常驻，直到用户改掉或清空。
 *
 * 清空只删预设条目，用户自己录的和导入的一条都不动。
 */
export function PresetNotice({
  count,
  onClear,
  isClearing
}: {
  count: number;
  onClear: () => void;
  isClearing: boolean;
}) {
  return (
    <div className="mb-4 rounded-xl border border-[#e7d9c4] bg-[#fdf7ec] px-4 py-3 text-sm text-[#6b5a41]">
      <p className="font-medium">
        示例妆匣：这 {count} 件是预设的常见单品，不是你的化妆品。
      </p>
      <p className="mt-1 text-xs leading-relaxed text-[#8a7758]">
        顾问会把它当作你已有的东西来给建议。改成你实际在用的，或一键清空——清空只删这些示例，你自己录入的和导入的都会留下。
      </p>
      <div className="mt-3 flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 rounded-lg border-[#d8c4a4] bg-white/70 text-xs text-[#6b5a41] hover:bg-white"
          onClick={onClear}
          disabled={isClearing}
        >
          {isClearing ? "正在清空…" : "清空示例"}
        </Button>
        <span className="text-xs text-[#8a7758]">或逐件编辑，改过的那件就不再算示例。</span>
      </div>
    </div>
  );
}
