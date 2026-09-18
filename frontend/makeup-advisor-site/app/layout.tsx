import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "妆迹｜妆容拆解小助手",
  description: "通过对话拆解妆容、匹配已有化妆品，并清楚标记需要购买与已经拥有的单品。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
