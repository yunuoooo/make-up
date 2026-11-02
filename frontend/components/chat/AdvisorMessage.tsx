"use client";

import { Children, isValidElement, memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, ChevronDown, CircleAlert, CircleHelp, ShoppingBag } from "lucide-react";
import { cn } from "@/frontend/lib/utils";
import { parseExecutionStep, parseProductSuggestions, remarkAdvisorPresentation, type ProductSuggestion } from "@/frontend/lib/advisor-presentation";
import { ProductCardStrip } from "@/frontend/components/chat/ProductCardStrip";
import type { ProductCardsState } from "@/lib/commerce/types";

const LIMITATION_PATTERN = /(没有实时站内检索|无实时站内检索|未能完成检索|没有完成检索|样本量|不足以|无法取得可靠|无法取得整体图|登录失效|访问受限|妆匣暂未核对)/;

function flatten(children: ReactNode): string {
  return Children.toArray(children).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    if (isValidElement(child)) return flatten((child.props as { children?: ReactNode }).children);
    return "";
  }).join("");
}

const STATUS = {
  owned: { label: "已有", icon: Check, className: "bg-[#edf5ef] text-[#456c50]" },
  pending: { label: "已有 · 待确认", icon: CircleHelp, className: "bg-[#f0eeeb] text-[#746a5e]" },
  buy: { label: "需要买", icon: ShoppingBag, className: "bg-[#fcf1df] text-[#926b2c]" }
};

function ProductSuggestions({ items }: { items: ProductSuggestion[] }) {
  return (
    <div className="space-y-5">
      {(["owned", "pending", "buy"] as const).map((status) => {
        const group = items.filter((item) => item.status === status);
        if (!group.length) return null;
        const { icon: Icon, label, className } = STATUS[status];
        return (
          <div key={status} data-product-status={status}>
            <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", className)}>
              <Icon className="size-3.5" aria-hidden="true" />{label}
            </span>
            <div className="mt-2.5 space-y-4">
              {group.map((item, index) => (
                <div key={`${item.name}-${index}`}>
                  <p className="text-[15px] font-medium leading-6 text-[#39332e]">
                    {item.alternative ? <span className="mr-2 text-xs font-normal text-[#817267]">可选</span> : null}
                    {item.name}{item.shade ? <span className="ml-1.5 font-normal text-[#817267]">· {item.shade}</span> : null}
                  </p>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TableCell({ children, isProductCell, ...props }: React.ComponentProps<"td"> & { isProductCell: boolean }) {
  const plain = flatten(children);
  const items = isProductCell ? parseProductSuggestions(plain) : [];
  return (
    <td className="px-4 py-5 text-[14px] leading-7 text-[#686057]" {...props}>
      {items.length ? <ProductSuggestions items={items} /> : children}
    </td>
  );
}

function ReferenceImage({ src, alt }: { src?: string; alt?: string }) {
  const [failedSrc, setFailedSrc] = useState<string>();
  if (!src) return null;
  return (
    <figure className="my-6 overflow-hidden rounded-[22px] border border-black/[.055] bg-[#ede8e3]">
      {failedSrc === src ? (
        <p className="px-6 py-10 text-center text-sm text-muted-foreground">参考图片暂时无法显示</p>
      ) : (
        <a href={src} target="_blank" rel="noreferrer noopener" aria-label="查看完整妆效图" className="block">
          <img
            src={src}
            alt={alt || "整体妆效参考"}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailedSrc(src)}
            className="mx-auto block h-auto max-h-[620px] w-auto max-w-full object-contain"
          />
        </a>
      )}
    </figure>
  );
}

function ExecutionStep({ children, index }: { children: ReactNode; index: number }) {
  const step = parseExecutionStep(flatten(children), index);
  return (
    <li className="flex items-start gap-3 sm:gap-4" data-execution-step={index}>
      <span className="mt-4 grid size-9 shrink-0 place-items-center rounded-full bg-[#f3dce5] text-sm font-semibold text-[#91445e]">
        {String(index).padStart(2, "0")}
      </span>
      <div className="min-w-0 flex-1 rounded-[20px] border border-black/[.065] bg-white p-5 sm:px-6">
        <h4 className="mb-3 text-base font-semibold text-[#3b322b]">{step.title}</h4>
        <ul className="space-y-2">
          {step.actions.map((action, i) => (
            <li key={i} className="flex gap-2.5 text-base leading-7 text-[#6c6157]">
              <span className="mt-3 size-1 shrink-0 rounded-full bg-[#c4ada4]" aria-hidden="true" />
              <span>{action}</span>
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}

export const AdvisorMessage = memo(function AdvisorMessage({ text, cards }: { text: string; cards?: ProductCardsState }) {
  return (
    <div className="markdown-answer min-w-0">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm, remarkAdvisorPresentation]}
        components={{
          h1: ({ children }) => <h2 className="mb-6 mt-6 font-serif text-[clamp(1.8rem,3vw,2.4rem)] leading-tight tracking-[-.025em] text-[#302720]">{children}</h2>,
          h2: ({ children, node }) => {
            const kind = node?.properties?.["data-advisor-section"];
            return (
              <h3
                data-advisor-section={kind}
                className={cn(
                  "mb-4 mt-10 text-lg font-semibold tracking-[-.02em] text-[#3d322b]",
                  kind && "rounded-2xl border px-5 py-3.5",
                  kind === "core" && "border-[#ecd0db] bg-[#f6e1e9] text-[#7d4155]",
                  kind === "optional" && "border-[#e2d8cc] bg-[#eee7df] text-[#6d5d4c]",
                  kind === "steps" && "border-[#e8d6cb] bg-[#f3e5dd] text-[#785541]"
                )}
              >
                {children}
              </h3>
            );
          },
          h3: ({ children }) => <h3 className="mb-3 mt-8 text-base font-semibold text-[#3d322b]">{children}</h3>,
          section: ({ children, node }) => node?.properties?.["data-advisor-summary"] ? (
            <section className="mb-8 mt-5 rounded-[22px] border border-black/[.055] bg-white px-6 py-5 sm:px-7 sm:py-6" aria-label="妆效摘要">
              <p className="mb-2.5 text-xs font-medium tracking-wider text-[#a27d70]">妆效摘要</p>
              <div className="text-[16px] leading-8 text-[#716258] sm:text-[17px] [&_strong]:font-medium [&_strong]:text-[#48392f]">{children}</div>
            </section>
          ) : <section>{children}</section>,
          p: ({ children, node }) => {
            if (node?.children.some((child) => child.type === "element" && child.tagName === "img")) return <div>{children}</div>;
            const plain = flatten(children).trim();
            if (node?.properties?.["data-advisor-kit"]) return <p className="mb-3 mt-2 inline-flex items-center gap-1.5 text-xs text-[#66806b]"><Check className="size-3.5" aria-hidden="true" />已结合妆匣</p>;
            if (LIMITATION_PATTERN.test(plain)) return (
              <div className="my-5 flex gap-2.5 rounded-2xl border border-[#dfc6ce] bg-[#fff7f9] p-4 text-sm leading-7 text-[#6f4d58]">
                <CircleAlert className="mt-1 size-4 shrink-0" aria-hidden="true" /><p>{children}</p>
              </div>
            );
            return <p className="mt-3 text-[15px] leading-7 text-[#6b6057]">{children}</p>;
          },
          img: ({ src, alt }) => <ReferenceImage src={typeof src === "string" ? src : undefined} alt={alt} />,
          table: ({ children, node }) => (
            <div className="my-4 overflow-hidden rounded-[20px] border border-black/[.065] bg-white">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left" data-advisor-table={node?.properties?.["data-advisor-table"] ? "true" : undefined}>{children}</table>
              </div>
            </div>
          ),
          thead: ({ children }) => <thead className="border-b border-black/[.06] bg-[#f9f7f4] text-[13px] text-[#928579]">{children}</thead>,
          th: ({ children }) => <th className="px-4 py-3.5 text-left align-top font-medium">{children}</th>,
          tbody: ({ children }) => <tbody className="[&_tr:last-child]:border-0">{children}</tbody>,
          tr: ({ children }) => <tr className="border-b border-black/[.065] align-top">{children}</tr>,
          td: ({ children, node, ...props }) => <TableCell {...props} isProductCell={Boolean(node?.properties?.["data-advisor-products"])}>{children}</TableCell>,
          ol: ({ children, node, start }) => <ol start={start} className={node?.properties?.["data-advisor-steps"] ? "my-5 flex flex-col gap-4" : "mt-4 list-decimal space-y-3 pl-5 text-[15px] leading-7 text-[#6b6057]"}>{children}</ol>,
          ul: ({ children }) => <ul className="mt-3 list-disc space-y-2 pl-5 text-[15px] leading-7 text-[#6b6057]">{children}</ul>,
          li: ({ children, node }) => {
            const step = node?.properties?.["data-advisor-step"];
            return typeof step === "number" ? <ExecutionStep index={step}>{children}</ExecutionStep> : <li>{children}</li>;
          },
          aside: ({ node }) => node?.properties?.["data-advisor-shopping"] ? <ProductCardStrip state={cards} /> : null,
          details: ({ children }) => <details className="advisor-sources group mt-9 rounded-[18px] border border-black/[.065] bg-white/60">{children}</details>,
          summary: ({ children }) => <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-sm font-medium text-[#84786d] outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">{children}<ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>,
          a: ({ children, node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" className="text-[#a23d5d] underline decoration-[#d8587e]/40 underline-offset-2 hover:decoration-[#d8587e]">{children}</a>,
          blockquote: ({ children }) => <blockquote className="mt-4 border-l-2 border-[#dfc6ce] pl-4 text-[15px] leading-7 text-[#6f4d58]">{children}</blockquote>,
          hr: () => <hr className="my-8 border-black/[.07]" />,
          code: ({ children }) => <code className="rounded bg-[#f1ece9] px-1.5 py-0.5 font-mono text-[13px] text-[#5e5751]">{children}</code>
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
