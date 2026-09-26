import type { Metadata } from "next";
import { XhsReadsView } from "@/frontend/components/reads/XhsReadsView";

export const metadata: Metadata = {
  title: "取数记录｜妆迹"
};

/**
 * 取数记录：把 agent 从小红书读到的原始内容摊开看（含视频口播字幕）。
 *
 * 刻意不做成对话界面里的一个视图：它是排查工具，不是产品功能——单独一条 URL 方便
 * 对着日志和时间点核对，也不会在正常使用时占着侧边栏。
 */
export default function XhsReadsPage() {
  return <XhsReadsView />;
}
