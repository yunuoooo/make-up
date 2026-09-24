"use client";

import { Children, cloneElement, isValidElement, memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CircleAlert } from "lucide-react";
import { cn } from "@/frontend/lib/utils";

/**
 * 回答由技能决定格式：一句整体妆效、一张整体妆效图、「必要／非必要」两张拆解表、
 * 决定妆效的顺序和可追溯来源，全部是 Markdown。这里把 Markdown 映射到样例的设计语言，
 * 表格、💰/✅ 徽章和配图卡片都按样例的排版渲染，内容一律来自 Agent 真实输出。
 */

const MARKER_PATTERN = /^\s*(💰|✅)\s*/;
/** 技能要求无法取得可靠结果时明说限制，命中这些措辞才渲染成样例的提示块。 */
const LIMITATION_PATTERN = /(没有实时站内检索|无实时站内检索|未能完成检索|没有完成检索|样本量|无法取得可靠|无法取得整体图|登录失效|访问受限|不足以)/;

function flatten(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (isValidElement(child)) {
        return flatten((child.props as { children?: ReactNode }).children);
      }
      return "";
    })
    .join("");
}

/**
 * 一个单元格里可能有多件单品，逐件处理才能各自带上徽章。
 * 不能靠 <br> 切分：react-markdown 默认丢弃原始 HTML（这是防止小红书内容注入的护栏），
 * 模型写的 <br> 根本不会到达这里，所以按 💰/✅ 标记本身切分。
 */
function splitOnMarkers(children: ReactNode): ReactNode[][] {
  const segments: ReactNode[][] = [];
  let current: ReactNode[] = [];
  let started = false;

  const flush = () => {
    if (current.some((node) => flatten(node).trim())) segments.push(current);
    current = [];
  };

  for (const child of Children.toArray(children)) {
    if (isValidElement(child) && child.type === "br") continue;
    if (typeof child === "string") {
      // 原始 HTML 会被转义成文本，模型写的 <br> 会原样显示出来；每件单品已经各占一行，直接丢掉。
      if (/^\s*<br\s*\/?>\s*$/i.test(child)) continue;
      // 这个字符类必须带 u 标志：💰 是代理对，没有 u 时类里只有高位代理，
      // 会在代理对中间切开，标记就再也匹配不上了。
      for (const piece of child.split(/(?=[💰✅])/u)) {
        if (!piece) continue;
        if (MARKER_PATTERN.test(piece)) {
          if (started) flush();
          started = true;
        }
        current.push(piece);
      }
      continue;
    }
    current.push(child);
  }

  flush();
  return segments;
}

/** 去掉单元格开头的 💰/✅ —— 它已经变成徽章，不再重复出现在正文里。 */
function stripMarker(children: ReactNode): ReactNode {
  let stripped = false;
  const walk = (nodes: ReactNode): ReactNode =>
    Children.map(nodes, (child) => {
      if (stripped) return child;
      if (typeof child === "string") {
        const next = child.replace(MARKER_PATTERN, "");
        if (next !== child) stripped = true;
        return next;
      }
      if (isValidElement(child)) {
        const props = child.props as { children?: ReactNode };
        if (props.children === undefined) return child;
        return cloneElement(child, { ...props, children: walk(props.children) } as never);
      }
      return child;
    });
  return walk(children);
}

function MarkerBadge({ marker, label, className }: { marker: string; label?: string; className?: string }) {
  const owned = marker === "✅";
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-1 text-[12px] font-semibold",
        owned ? "bg-[#e6f3e9] text-[#397049]" : "bg-[#fff0d8] text-[#91601a]",
        className
      )}
    >
      {label ?? (owned ? "✅ 已有" : "💰 需要买")}
    </span>
  );
}

/** 样例的表格卡片：圆角容器 + 横向滚动 + 浅色表头。 */
function DataTable({ children, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="mt-3 overflow-hidden rounded-[18px] border border-black/[.07] bg-white">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-left" {...props}>
          {children}
        </table>
      </div>
    </div>
  );
}

function TableCell({ children, ...props }: React.ComponentProps<"td">) {
  const segments = splitOnMarkers(children);
  const hasMarker = segments.some((segment) => MARKER_PATTERN.test(flatten(segment)));

  if (!hasMarker) {
    return (
      <td className="px-4 py-4 text-sm leading-6 text-[#5e5751]" {...props}>
        {children}
      </td>
    );
  }

  return (
    <td className="space-y-3 px-4 py-4" {...props}>
      {segments
        .filter((segment) => flatten(segment).trim())
        .map((segment, index) => {
          const text = flatten(segment);
          const marker = text.match(MARKER_PATTERN)?.[1];
          if (!marker) {
            return (
              <p key={index} className="text-sm leading-6 text-[#5e5751]">
                {segment}
              </p>
            );
          }
          return (
            <div key={index}>
              <MarkerBadge marker={marker} />
              <p className="mt-1.5 text-[13px] leading-6 text-[#6a635d] [&_strong]:font-semibold [&_strong]:text-[#36312e]">
                {stripMarker(segment)}
              </p>
            </div>
          );
        })}
    </td>
  );
}

/** 样例的「标记说明」行：把图例里的 💰/✅ 渲染成药丸。 */
function LegendRow({ children }: { children: ReactNode }) {
  const text = flatten(children);
  return (
    <div className="mt-5 flex flex-wrap items-center gap-2 text-xs text-[#7d756f]">
      <span className="font-semibold text-[#4e4843]">标记说明</span>
      {text.includes("💰") ? <MarkerBadge marker="💰" label="💰 需要购买" className="px-2.5" /> : null}
      {text.includes("✅") ? <MarkerBadge marker="✅" label="✅ 已确认拥有" className="px-2.5" /> : null}
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  const text = flatten(children);
  const optional = /非必要/.test(text);
  return (
    <div className="mb-3 mt-7 flex items-center gap-2">
      <span
        className={cn(
          "rounded-full px-2.5 py-1 text-xs font-semibold",
          optional ? "bg-[#eeeae7] text-[#706963]" : "bg-[#242421] text-white"
        )}
      >
        {optional ? "按需" : "核心"}
      </span>
      <h3 className="text-base font-semibold text-[#2c2825]">{children}</h3>
    </div>
  );
}

function ResearchNotice({ children }: { children: ReactNode }) {
  return (
    <div className="mt-5 flex gap-2 rounded-[16px] border border-[#dfc6ce] bg-[#fff7f9] p-4 text-sm leading-6 text-[#6f4d58]">
      <CircleAlert className="mt-1 size-4 shrink-0 text-[#c04f70]" />
      <p>{children}</p>
    </div>
  );
}

function ReferenceImage({ src, alt }: { src?: string; alt?: string }) {
  if (!src) return null;
  return (
    <div className="relative mt-6 aspect-[16/7] max-w-3xl overflow-hidden rounded-[22px] bg-[#e8dfdc]">
      {/* 小红书图床有防盗链，去掉 referrer 才能直接显示。 */}
      <img
        src={src}
        alt={alt ?? "参考妆效"}
        loading="lazy"
        referrerPolicy="no-referrer"
        className="absolute inset-0 h-full w-full object-cover object-[center_36%]"
      />
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/55 to-transparent px-5 pb-4 pt-14 text-sm text-white">
        {alt || "参考妆效：观察整体色彩、质地和视觉重心"}
      </div>
    </div>
  );
}

export const AdvisorMessage = memo(function AdvisorMessage({ text }: { text: string }) {
  const isLegend = (value: ReactNode) => {
    const plain = flatten(value);
    return plain.length <= 60 && plain.includes("💰") && /需要购买/.test(plain);
  };

  return (
    <div className="markdown-answer min-w-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // react-markdown 会把 hast 节点作为 node 传入，直接展开会变成 node="[object Object]" 属性。
          h1: ({ children, node: _node, ...props }) => (
            <h2 className="mt-2 font-serif text-[clamp(1.35rem,2.4vw,1.8rem)] leading-tight tracking-[-.025em] text-[#282421]" {...props}>
              {children}
            </h2>
          ),
          h2: ({ children, node: _node, ...props }) => {
            const plain = flatten(children);
            if (/非必要|必要/.test(plain)) return <SectionHeading>{children}</SectionHeading>;
            return (
              <h2 className="mt-2 font-serif text-[clamp(1.35rem,2.4vw,1.8rem)] leading-tight tracking-[-.025em] text-[#282421]" {...props}>
                {children}
              </h2>
            );
          },
          h3: ({ children, node: _node, ...props }) => (
            <h3 className="mt-6 text-base font-semibold text-[#312d2a]" {...props}>
              {children}
            </h3>
          ),
          p: ({ children, node, ...props }) => {
            // 图片独占一行时不能套 <p>：配图卡片是块级元素，套进去就是 <p><div> 的非法嵌套。
            // 这里看 hast 节点而不是 React 子节点——img 已经被上面的 components 换成自定义组件了。
            const first = node?.children?.[0];
            const imageOnly = node?.children?.length === 1
              && first?.type === "element"
              && (first as { tagName?: string }).tagName === "img";
            if (imageOnly) return <>{children}</>;
            if (isLegend(children)) return <LegendRow>{children}</LegendRow>;
            const plain = flatten(children).trim();
            if (LIMITATION_PATTERN.test(plain) && plain.length > 12) {
              return <ResearchNotice>{children}</ResearchNotice>;
            }
            const isLead = /^整体妆效/.test(plain);
            return (
              <p
                className={cn(
                  "mt-3 leading-7 text-[#5e5751]",
                  isLead ? "text-[17px] leading-8 text-[#312d2a]" : "text-[15px]"
                )}
                {...props}
              >
                {children}
              </p>
            );
          },
          a: ({ children, node: _node, ...props }) => (
            <a
              {...props}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[#a23d5d] underline decoration-[#d8587e]/40 underline-offset-2 hover:decoration-[#d8587e]"
            >
              {children}
            </a>
          ),
          img: ({ node: _node, src, alt }) => <ReferenceImage src={typeof src === "string" ? src : undefined} alt={alt} />,
          table: ({ children, node: _node, ...props }) => <DataTable {...props}>{children}</DataTable>,
          thead: ({ children, node: _node, ...props }) => (
            <thead className="border-b border-black/[.06] bg-[#f8f6f4] text-[12px] font-medium text-[#857e78]" {...props}>
              {children}
            </thead>
          ),
          th: ({ children, node: _node, ...props }) => (
            <th className="px-4 py-3 text-left align-top font-medium" {...props}>
              {children}
            </th>
          ),
          tbody: ({ children, node: _node, ...props }) => (
            <tbody className="[&_tr:last-child]:border-0" {...props}>
              {children}
            </tbody>
          ),
          tr: ({ children, node: _node, ...props }) => (
            <tr className="border-b border-black/[.055] align-top" {...props}>
              {children}
            </tr>
          ),
          td: ({ children, node: _node, ...props }) => <TableCell {...props}>{children}</TableCell>,
          ul: ({ children, node: _node, ...props }) => (
            <ul className="mt-3 space-y-1.5 pl-5 text-[14px] leading-6 text-[#6d655f]" {...props}>
              {children}
            </ul>
          ),
          ol: ({ children, node: _node, ...props }) => {
            // Markdown 的列表项之间夹着换行文本节点，序号只能数真正的列表项。
            let step = 0;
            return (
              <ol className="mt-4 space-y-3" {...props}>
                {Children.map(children, (child) =>
                  isValidElement(child) ? cloneElement(child, { "data-step": step++ } as never) : child
                )}
              </ol>
            );
          },
          li: ({ children, node: _node, ...props }) => {
            // ol 渲染时会注入 data-step；它只是内部标记，不该落到 DOM 上。
            const { "data-step": step, ...rest } = props as { "data-step"?: number };
            const itemProps = rest as React.ComponentProps<"li">;
            if (typeof step !== "number") {
              return (
                <li className="list-disc text-[14px] leading-6 text-[#6d655f]" {...itemProps}>
                  {children}
                </li>
              );
            }
            return (
              <li className="flex gap-3 text-sm leading-6 text-[#6d655f]" {...itemProps}>
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#f6e4e9] text-[11px] font-semibold text-[#a44361]">
                  {step + 1}
                </span>
                <span className="min-w-0 flex-1">{children}</span>
              </li>
            );
          },
          blockquote: ({ children, node: _node, ...props }) => (
            <blockquote className="mt-3 border-l-2 border-[#dfc6ce] pl-4 text-[14px] leading-7 text-[#6f4d58]" {...props}>
              {children}
            </blockquote>
          ),
          hr: ({ node: _node, ...props }) => <hr className="my-6 border-black/[.07]" {...props} />,
          code: ({ children, node: _node, ...props }) => (
            <code className="rounded bg-[#f1ece9] px-1.5 py-0.5 font-mono text-[13px] text-[#5e5751]" {...props}>
              {children}
            </code>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
