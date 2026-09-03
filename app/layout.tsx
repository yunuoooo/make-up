import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "妆迹 LOOKTRACE MVP",
  description: "文字版妆容目标拆解、妆匣匹配和 SKU 候选推荐工作台。"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
