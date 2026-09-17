"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type MarkdownMessageProps = {
  text: string;
  role?: "assistant" | "user";
};

/**
 * Skill 决定回答格式：标题、加粗、列表和「必要／非必要」两张表格都在 Markdown 里。
 * react-markdown 默认不渲染原始 HTML，模型输出不会被当成 HTML 注入。
 */
export const MarkdownMessage = memo(function MarkdownMessage({ text, role = "assistant" }: MarkdownMessageProps) {
  return (
    <div className={`message-text markdown-body ${role}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // react-markdown 会把 hast 节点作为 node 传入，直接展开会变成 node="[object Object]" 属性。
          a: ({ children, node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener">{children}</a>
          ),
          table: ({ children, node: _node, ...props }) => (
            <div className="markdown-table-scroll">
              <table {...props}>{children}</table>
            </div>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
