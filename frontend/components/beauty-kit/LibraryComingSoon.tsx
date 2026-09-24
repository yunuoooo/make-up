"use client";

import { Lock } from "lucide-react";

/** 化妆品库未开放时的占位页。开关见 frontend/lib/constants.ts 的 IS_LIBRARY_OPEN。 */
export function LibraryComingSoon() {
  return (
    <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto px-4 py-7 sm:px-8 lg:px-12">
      <div className="w-full max-w-lg rounded-[24px] border border-dashed border-black/[.12] bg-white/55 px-6 py-16 text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-[18px] bg-[#f8e7ec] text-[#b64d6c]">
          <Lock />
        </div>
        <p className="mt-5 text-[11px] font-semibold uppercase tracking-[.16em] text-[#b24c6b]">My beauty kit</p>
        <h1 className="mt-2 font-serif text-3xl tracking-[-.025em] text-[#282421]">暂未开放</h1>
        <p className="mt-3 text-sm leading-6 text-[#817a74]">
          化妆品库还在打磨，暂时不能录入和管理你的妆品。
        </p>
        <p className="mt-1 text-sm leading-6 text-[#817a74]">妆容对话不受影响，可以照常提问。</p>
      </div>
    </div>
  );
}
