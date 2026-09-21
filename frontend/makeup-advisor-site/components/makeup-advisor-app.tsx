"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Archive,
  ArrowUpRight,
  ArrowUp,
  ChevronRight,
  CircleAlert,
  Clock3,
  Library,
  LoaderCircle,
  MessageCircleMore,
  MoreHorizontal,
  PackageOpen,
  PencilLine,
  Plus,
  Search,
  ShoppingBag,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import type {
  AdvisorReply,
  ChatMessage,
  ConversationSummary,
  Product,
  RecommendationProduct,
  RecommendationRow,
} from "@/lib/makeup-types";
import { buildAdvisorReply } from "@/lib/advisor";

const suggestions = ["韩系氧气妆", "清冷通勤妆", "自然消肿眼妆"];
const categories = [
  "底妆",
  "遮瑕",
  "定妆",
  "眉笔",
  "眼影",
  "眼线",
  "睫毛膏",
  "腮红",
  "修容",
  "高光",
  "唇妆",
  "工具",
];

type View = "chat" | "library";

type ProductForm = {
  brand: string;
  name: string;
  category: string;
  shade: string;
  finish: string;
  tags: string;
  notes: string;
};

type WebMcpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    untrustedContentHint: boolean;
  };
  execute: (input: unknown) => unknown | Promise<unknown>;
};

type WebMcpContext = {
  registerTool: (
    tool: WebMcpTool,
    options?: { signal?: AbortSignal },
  ) => void | Promise<void>;
};

const emptyProductForm: ProductForm = {
  brand: "",
  name: "",
  category: "腮红",
  shade: "",
  finish: "",
  tags: "",
  notes: "",
};

const LOCAL_STATE_KEY = "looktrace.makeup-advisor.v1";

type LocalState = {
  products: Product[];
  conversations: ConversationSummary[];
  messages: Record<string, ChatMessage[]>;
};

function createLocalId(prefix: string) {
  const uuid = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${uuid}`;
}

function readLocalState(): LocalState {
  if (typeof window === "undefined") {
    return { products: [], conversations: [], messages: {} };
  }

  try {
    const stored = window.localStorage.getItem(LOCAL_STATE_KEY);
    if (!stored) return { products: [], conversations: [], messages: {} };
    const parsed = JSON.parse(stored) as Partial<LocalState>;
    return {
      products: Array.isArray(parsed.products) ? parsed.products : [],
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
      messages: parsed.messages && typeof parsed.messages === "object" ? parsed.messages : {},
    };
  } catch {
    return { products: [], conversations: [], messages: {} };
  }
}

function productToForm(product: Product): ProductForm {
  return {
    brand: product.brand,
    name: product.name,
    category: product.category,
    shade: product.shade,
    finish: product.finish,
    tags: product.tags,
    notes: product.notes,
  };
}

function timeLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
  }).format(date);
}

function ProductRecommendationCard({ product }: { product: RecommendationProduct }) {
  const [brand, name, ...details] = product.label.split("｜");

  return (
    <a
      href={product.taobaoUrl}
      target="_blank"
      rel="noopener noreferrer nofollow"
      aria-label={`${product.label}：去淘宝查看商品详情`}
      className="group block overflow-hidden rounded-[18px] border border-black/[.075] bg-[#fffdfc] shadow-[0_8px_24px_rgba(55,42,37,.05)] transition duration-200 hover:-translate-y-0.5 hover:border-[#ff6a3d]/35 hover:shadow-[0_14px_34px_rgba(88,49,36,.11)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e45d78] focus-visible:ring-offset-2"
    >
      <div className="grid grid-cols-[92px_minmax(0,1fr)] sm:grid-cols-[116px_minmax(0,1fr)]">
        <div className="relative min-h-[156px] overflow-hidden border-r border-black/[.055] bg-[#f5f0ed]">
          <img
            src={product.image}
            alt={product.imageAlt}
            loading="lazy"
            className="absolute inset-0 h-full w-full object-contain p-2 transition duration-300 group-hover:scale-[1.035]"
          />
          <span className="absolute left-2 top-2 rounded-full bg-white/92 px-2 py-1 text-[10px] font-semibold tracking-[.04em] text-[#e55427] shadow-sm backdrop-blur-sm">
            淘宝推荐
          </span>
        </div>

        <div className="flex min-w-0 flex-col p-3.5">
          <div className="flex items-start justify-between gap-2">
            <span
              className={
                product.status === "owned"
                  ? "inline-flex rounded-full bg-[#e6f3e9] px-2 py-1 text-[11px] font-semibold text-[#397049]"
                  : "inline-flex rounded-full bg-[#fff0d8] px-2 py-1 text-[11px] font-semibold text-[#91601a]"
              }
            >
              {product.status === "owned" ? "✅ 已有" : "💰 需要买"}
            </span>
            <ArrowUpRight className="size-4 shrink-0 text-[#b5aaa3] transition group-hover:text-[#e55427]" />
          </div>

          <p className="mt-2 text-[11px] font-semibold uppercase tracking-[.08em] text-[#9a5a6d]">
            {brand}
          </p>
          <p className="mt-1 text-sm font-semibold leading-5 text-[#302b28]">{name}</p>
          {details.length ? (
            <p className="mt-1 line-clamp-2 text-[12px] leading-[1.55] text-[#7e756f]">
              {details.join(" · ")}
            </p>
          ) : null}

          <div className="mt-auto pt-3">
            <p className="flex items-center gap-1.5 text-[12px] font-semibold text-[#e55427]">
              <ShoppingBag className="size-3.5" />
              点击查看商品详情，可加入购物车
            </p>
            <p className="mt-1 text-[11px] text-[#a09892]">{product.evidence} · 前往淘宝</p>
          </div>
        </div>
      </div>
    </a>
  );
}

function ResultTable({
  title,
  rows,
  optional = false,
}: {
  title: string;
  rows: RecommendationRow[];
  optional?: boolean;
}) {
  return (
    <section className="mt-7">
      <div className="mb-3 flex items-center gap-2">
        <span
          className={
            optional
              ? "rounded-full bg-[#eeeae7] px-2.5 py-1 text-xs font-semibold text-[#706963]"
              : "rounded-full bg-[#242421] px-2.5 py-1 text-xs font-semibold text-white"
          }
        >
          {optional ? "按需" : "核心"}
        </span>
        <h3 className="text-base font-semibold text-[#2c2825]">{title}</h3>
      </div>

      <div className="overflow-hidden rounded-[18px] border border-black/[.07] bg-white">
        <div className="divide-y divide-black/[.055] 2xl:hidden">
          {rows.map((item) => (
            <article key={`${item.area}-${item.target}`} className="p-4 sm:p-5">
              <dl className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
                <div>
                  <dt className="text-[11px] font-semibold tracking-[.08em] text-[#a29a94]">区域</dt>
                  <dd className="mt-1 text-sm font-semibold text-[#3b3632]">{item.area}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-semibold tracking-[.08em] text-[#a29a94]">目标特点</dt>
                  <dd className="mt-1 text-sm leading-6 text-[#5e5751]">{item.target}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-semibold tracking-[.08em] text-[#a29a94]">用什么达成</dt>
                  <dd className="mt-1 text-sm leading-6 text-[#5e5751]">{item.method}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-semibold tracking-[.08em] text-[#a29a94]">怎么选与怎么做</dt>
                  <dd className="mt-1 text-sm leading-6 text-[#716a64]">{item.guidance}</dd>
                </div>
              </dl>

              <div className="mt-5 border-t border-black/[.055] pt-4">
                <p className="mb-3 text-[11px] font-semibold tracking-[.08em] text-[#a65a70]">
                  淘宝推荐与具体产品
                </p>
                <div className={item.products.length > 1 ? "grid gap-3 lg:grid-cols-2" : "max-w-xl"}>
                  {item.products.map((product) => (
                    <ProductRecommendationCard key={product.label} product={product} />
                  ))}
                </div>
              </div>
            </article>
          ))}
        </div>

        <div className="hidden overflow-x-auto 2xl:block">
          <table className="w-full min-w-[1080px] border-collapse text-left">
            <thead>
              <tr className="border-b border-black/[.06] bg-[#f8f6f4] text-[12px] font-medium text-[#857e78]">
                <th className="w-[10%] px-4 py-3">区域</th>
                <th className="w-[15%] px-4 py-3">目标特点</th>
                <th className="w-[13%] px-4 py-3">用什么达成</th>
                <th className="w-[22%] px-4 py-3">怎么选与怎么做</th>
                <th className="w-[40%] px-4 py-3">淘宝推荐与具体产品</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr
                  key={`${item.area}-${item.target}`}
                  className="border-b border-black/[.055] align-top last:border-0"
                >
                  <td className="px-4 py-4 text-sm font-semibold text-[#3b3632]">{item.area}</td>
                  <td className="px-4 py-4 text-sm leading-6 text-[#5e5751]">{item.target}</td>
                  <td className="px-4 py-4 text-sm leading-6 text-[#5e5751]">{item.method}</td>
                  <td className="px-4 py-4 text-sm leading-6 text-[#716a64]">{item.guidance}</td>
                  <td className="space-y-3 px-4 py-4">
                    {item.products.map((product) => (
                      <ProductRecommendationCard key={product.label} product={product} />
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function AdvisorMessage({ reply }: { reply: AdvisorReply }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="max-w-3xl">
        <p className="text-[11px] font-semibold uppercase tracking-[.16em] text-[#b24c6b]">
          {reply.styleName}
        </p>
        <h2 className="mt-2 font-serif text-[clamp(1.6rem,3vw,2.4rem)] leading-tight tracking-[-.025em] text-[#282421]">
          {reply.summary}
        </h2>
      </div>

      {reply.image ? (
        <div className="relative mt-6 aspect-[16/7] max-w-3xl overflow-hidden rounded-[22px] bg-[#e8dfdc]">
          <img
            src={reply.image}
            alt={`${reply.styleName}参考妆效`}
            className="absolute inset-0 h-full w-full object-cover object-[center_36%]"
          />
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/55 to-transparent px-5 pb-4 pt-14 text-sm text-white">
            参考妆效：观察整体色彩、质地和视觉重心
          </div>
        </div>
      ) : null}

      <div className="mt-5 flex gap-2 rounded-[16px] border border-[#dfc6ce] bg-[#fff7f9] p-4 text-sm leading-6 text-[#6f4d58]">
        <CircleAlert className="mt-1 size-4 shrink-0 text-[#c04f70]" />
        <p>{reply.researchNotice}</p>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2 text-xs text-[#7d756f]">
        <span className="font-semibold text-[#4e4843]">标记说明</span>
        <span className="rounded-full bg-[#fff0d8] px-2.5 py-1 text-[#91601a]">💰 需要购买</span>
        <span className="rounded-full bg-[#e6f3e9] px-2.5 py-1 text-[#397049]">✅ 已确认拥有</span>
      </div>

      <ResultTable title="必要：特点与选品拆解" rows={reply.necessary} />
      <ResultTable title="非必要：特点与选品拆解" rows={reply.optional} optional />

      <section className="mt-7 grid gap-4 lg:grid-cols-[1.05fr_.95fr]">
        <div className="rounded-[18px] border border-black/[.07] bg-white p-5">
          <h3 className="text-base font-semibold text-[#312d2a]">决定妆效的顺序</h3>
          <ol className="mt-4 space-y-3">
            {reply.steps.map((step, index) => (
              <li key={step} className="flex gap-3 text-sm leading-6 text-[#6d655f]">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#f6e4e9] text-[11px] font-semibold text-[#a44361]">
                  {index + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </div>
        <div className="rounded-[18px] bg-[#242421] p-5 text-white">
          <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-[#ff98b6]">下一步更贴合你</p>
          <p className="mt-3 text-sm leading-7 text-white/76">{reply.followUp}</p>
        </div>
      </section>

      <details className="mt-5 rounded-[16px] border border-black/[.06] bg-white px-4 py-3 text-sm text-[#716a64]">
        <summary className="cursor-pointer font-medium text-[#4e4843]">本轮依据</summary>
        <ul className="mt-3 space-y-1.5 pl-5 text-[13px] leading-6">
          {reply.sources.map((source) => (
            <li key={source} className="list-disc">{source}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function EmptyChat({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <section className="grid min-h-full items-center gap-10 py-8 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="max-w-2xl">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#d8587e]/15 bg-[#fae8ee] px-3 py-1.5 text-xs font-medium text-[#a23d5d]">
          <Sparkles className="size-3.5" />
          你的私人妆容顾问
        </div>
        <h1 className="text-balance font-serif text-[clamp(2rem,5vw,4.25rem)] leading-[1.08] tracking-[-.035em] text-[#24211f]">
          我是你的妆容拆解小助手，今天想化个什么样的妆呢？
        </h1>
        <p className="mt-5 max-w-xl text-[15px] leading-7 text-[#817a74]">
          告诉我一个妆容名字。我会先拆出关键妆效，再与你的化妆品库逐件匹配，清楚标出哪些已有、哪些需要买。
        </p>
        <div className="mt-7 flex flex-wrap gap-2.5" aria-label="妆容示例">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => onPick(suggestion)}
              className="rounded-full border border-black/[.08] bg-white px-4 py-2.5 text-sm text-[#4e4945] shadow-[0_3px_12px_rgba(35,31,28,.04)] transition hover:-translate-y-0.5 hover:border-[#d8587e]/30 hover:text-[#a23d5d]"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={() => onPick("韩系氧气妆")}
        className="group relative mx-auto aspect-[4/5] w-full max-w-[280px] overflow-hidden rounded-[28px] bg-[#eadedc] text-left shadow-[0_28px_70px_rgba(55,45,42,.16)]"
      >
        <img
          src="./oxygen-makeup.png"
          alt="韩系氧气妆参考妆效"
          className="absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-[1.025]"
        />
        <span className="absolute inset-x-3 bottom-3 rounded-2xl bg-white/88 p-3.5 backdrop-blur-md">
          <span className="block text-[11px] font-medium tracking-[.12em] text-[#a45b71]">今日灵感</span>
          <span className="mt-1 flex items-center justify-between text-sm font-semibold text-[#2a2624]">
            韩系氧气妆
            <ArrowUp className="size-4 rotate-45" />
          </span>
        </span>
      </button>
    </section>
  );
}

export function MakeupAdvisorApp() {
  const [view, setView] = useState<View>("chat");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [messagesByConversation, setMessagesByConversation] = useState<Record<string, ChatMessage[]>>({});
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [isHydrated, setIsHydrated] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isLoadingConversation, setIsLoadingConversation] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("全部");
  const [form, setForm] = useState<ProductForm>(emptyProductForm);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [isProductDialogOpen, setIsProductDialogOpen] = useState(false);
  const [productToDelete, setProductToDelete] = useState<Product | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const productsRef = useRef<Product[]>([]);
  const conversationsRef = useRef<ConversationSummary[]>([]);
  const messagesByConversationRef = useRef<Record<string, ChatMessage[]>>({});
  const sendPromptRef = useRef<(prompt: string) => Promise<ChatMessage | null>>(
    async () => null,
  );

  const loadProducts = useCallback(async () => productsRef.current, []);

  useEffect(() => {
    const hydrationTimer = window.setTimeout(() => {
      const stored = readLocalState();
      setProducts(stored.products);
      setConversations(stored.conversations);
      setMessagesByConversation(stored.messages);
      setIsHydrated(true);
    }, 0);

    return () => window.clearTimeout(hydrationTimer);
  }, []);

  useEffect(() => {
    productsRef.current = products;
    conversationsRef.current = conversations;
    messagesByConversationRef.current = messagesByConversation;
  }, [conversations, messagesByConversation, products]);

  useEffect(() => {
    if (!isHydrated) return;
    try {
      window.localStorage.setItem(
        LOCAL_STATE_KEY,
        JSON.stringify({ products, conversations, messages: messagesByConversation }),
      );
    } catch {
      toast.error("浏览器暂时无法保存数据，请检查隐私或存储设置。");
    }
  }, [conversations, isHydrated, messagesByConversation, products]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [isSending, messages]);

  const filteredProducts = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    return products.filter((product) => {
      const matchesCategory = categoryFilter === "全部" || product.category === categoryFilter;
      const haystack = [
        product.brand,
        product.name,
        product.category,
        product.shade,
        product.finish,
        product.tags,
        product.notes,
      ]
        .join(" ")
        .toLowerCase();
      return matchesCategory && (!keyword || haystack.includes(keyword));
    });
  }, [categoryFilter, products, searchTerm]);

  const visibleCategories = useMemo(
    () => ["全部", ...Array.from(new Set([...categories, ...products.map((product) => product.category)]))],
    [products],
  );

  function startNewChat() {
    setView("chat");
    setActiveConversationId(null);
    setMessages([]);
    setDraft("");
  }

  function openConversation(id: string) {
    setView("chat");
    setActiveConversationId(id);
    setIsLoadingConversation(true);
    setMessages(messagesByConversationRef.current[id] || []);
    setIsLoadingConversation(false);
  }

  const sendPrompt = useCallback(
    async (prompt: string) => {
      const content = prompt.trim();
      if (!content || isSending) return null;

      const conversationId = activeConversationId || createLocalId("conversation");
      const now = new Date().toISOString();
      const existingMessages = messagesByConversationRef.current[conversationId] || [];
      const userMessage: ChatMessage = {
        id: createLocalId("message"),
        conversationId,
        role: "user",
        content,
        reply: null,
        createdAt: now,
      };

      setView("chat");
      setActiveConversationId(conversationId);
      setMessages([...existingMessages, userMessage]);
      setDraft("");
      setIsSending(true);

      try {
        await new Promise((resolve) => window.setTimeout(resolve, 260));
        const reply = buildAdvisorReply(content, productsRef.current);
        const assistantMessage: ChatMessage = {
          id: createLocalId("message"),
          conversationId,
          role: "assistant",
          content: reply.summary,
          reply,
          createdAt: new Date().toISOString(),
        };
        const nextMessages = [...existingMessages, userMessage, assistantMessage];
        const previousConversation = conversationsRef.current.find(
          (conversation) => conversation.id === conversationId,
        );
        const conversation: ConversationSummary = {
          id: conversationId,
          title: previousConversation?.title || content.slice(0, 28),
          createdAt: previousConversation?.createdAt || now,
          updatedAt: assistantMessage.createdAt,
        };

        setMessages(nextMessages);
        setMessagesByConversation((current) => ({ ...current, [conversationId]: nextMessages }));
        setConversations((current) => [
          conversation,
          ...current.filter((item) => item.id !== conversationId),
        ]);
        return assistantMessage;
      } catch (error) {
        setMessages(existingMessages);
        toast.error(error instanceof Error ? error.message : "生成妆容方案失败。");
        return null;
      } finally {
        setIsSending(false);
      }
    },
    [activeConversationId, isSending],
  );

  useEffect(() => {
    sendPromptRef.current = sendPrompt;
  }, [sendPrompt]);

  useEffect(() => {
    const context = (
      document as Document & { modelContext?: WebMcpContext }
    ).modelContext;
    if (!context?.registerTool) return;

    const lifecycle = new AbortController();
    const register = (tool: WebMcpTool) => {
      try {
        void Promise.resolve(
          context.registerTool(tool, { signal: lifecycle.signal }),
        ).catch(() => undefined);
      } catch {
        // WebMCP is an enhancement; the visible interface remains fully usable.
      }
    };

    register({
      name: "list_cosmetics",
      title: "查看我的化妆品",
      description: "读取当前化妆品库里的品牌、完整产品名、品类和版本或色号。",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute() {
        const current = await loadProducts();
        return {
          count: current.length,
          products: current.map((product) => ({
            id: product.id,
            brand: product.brand,
            name: product.name,
            category: product.category,
            shade: product.shade,
          })),
        };
      },
    });

    register({
      name: "create_cosmetic",
      title: "添加一件化妆品",
      description: "把一件用户明确已经拥有的化妆品添加到化妆品库。",
      inputSchema: {
        type: "object",
        properties: {
          brand: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          category: { type: "string", minLength: 1 },
          shade: { type: "string", minLength: 1 },
          finish: { type: "string" },
          tags: { type: "string" },
          notes: { type: "string" },
        },
        required: ["brand", "name", "category", "shade"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input) {
        const value = input as Partial<ProductForm>;
        const brand = value.brand?.trim();
        const name = value.name?.trim();
        const category = value.category?.trim();
        const shade = value.shade?.trim();
        if (!brand || !name || !category || !shade) {
          throw new Error("品牌、完整产品名、品类和版本/色号都需要填写。");
        }
        const now = new Date().toISOString();
        const product: Product = {
          id: Date.now() + Math.floor(Math.random() * 1000),
          brand,
          name,
          category,
          shade,
          finish: value.finish || "",
          tags: value.tags || "",
          notes: value.notes || "",
          createdAt: now,
          updatedAt: now,
        };
        setProducts((current) => [product, ...current]);
        return {
          created: true,
          product: {
            id: product.id,
            brand: product.brand,
            name: product.name,
            category: product.category,
            shade: product.shade,
          },
        };
      },
    });

    register({
      name: "start_makeup_consultation",
      title: "开始妆容咨询",
      description: "用一个明确的妆容名字开始对话，并让顾问核对当前化妆品库。",
      inputSchema: {
        type: "object",
        properties: {
          makeupName: { type: "string", minLength: 1 },
        },
        required: ["makeupName"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input) {
        const makeupName = (input as { makeupName?: string }).makeupName?.trim();
        if (!makeupName) throw new Error("请提供明确的妆容名字。");
        const result = await sendPromptRef.current(makeupName);
        if (!result) throw new Error("这次妆容咨询没有生成成功。");
        return {
          conversationId: result.conversationId,
          summary: result.content,
        };
      },
    });

    return () => lifecycle.abort();
  }, [loadProducts]);

  function submitPrompt(event: FormEvent) {
    event.preventDefault();
    void sendPrompt(draft);
  }

  function openCreateProduct() {
    setEditingProduct(null);
    setForm(emptyProductForm);
    setIsProductDialogOpen(true);
  }

  function openEditProduct(product: Product) {
    setEditingProduct(product);
    setForm(productToForm(product));
    setIsProductDialogOpen(true);
  }

  async function saveProduct(event: FormEvent) {
    event.preventDefault();
    try {
      const now = new Date().toISOString();
      if (editingProduct) {
        setProducts((current) =>
          current.map((product) =>
            product.id === editingProduct.id
              ? { ...product, ...form, updatedAt: now }
              : product,
          ),
        );
      } else {
        const product: Product = {
          id: Date.now() + Math.floor(Math.random() * 1000),
          ...form,
          createdAt: now,
          updatedAt: now,
        };
        setProducts((current) => [product, ...current]);
      }
      setIsProductDialogOpen(false);
      setEditingProduct(null);
      setForm(emptyProductForm);
      toast.success(editingProduct ? "化妆品信息已更新" : "已经加入你的化妆品库");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败。");
    }
  }

  async function deleteProduct() {
    if (!productToDelete) return;
    try {
      setProducts((current) => current.filter((product) => product.id !== productToDelete.id));
      setProductToDelete(null);
      toast.success("这件化妆品已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败。");
    }
  }

  return (
    <SidebarProvider style={{ "--sidebar-width": "17.5rem" } as React.CSSProperties}>
      <Sidebar className="border-r-0 bg-[#20211f] text-white">
        <SidebarHeader className="gap-5 px-4 pb-2 pt-5">
          <div className="flex items-center gap-3 px-1">
            <div className="grid size-10 place-items-center rounded-[14px] bg-[#ef7196] text-lg font-semibold text-white shadow-[0_8px_24px_rgba(239,113,150,.28)]">妆</div>
            <div>
              <p className="text-[15px] font-semibold tracking-[.08em]">妆迹</p>
              <p className="mt-0.5 text-[11px] tracking-[.2em] text-white/45">LOOKTRACE</p>
            </div>
          </div>
          <Button
            onClick={startNewChat}
            className="h-11 justify-start rounded-xl bg-white text-[#20211f] shadow-none hover:bg-[#f7f4f5]"
          >
            <Plus />
            新对话
          </Button>
        </SidebarHeader>

        <SidebarContent className="px-2">
          <SidebarGroup className="py-3">
            <SidebarGroupContent>
              <SidebarMenu className="gap-1.5">
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={view === "chat"}
                    onClick={() => setView("chat")}
                    className="h-10 rounded-xl px-3 text-white/72 hover:bg-white/10 hover:text-white data-[active=true]:bg-white/12 data-[active=true]:text-white"
                  >
                    <MessageCircleMore />
                    <span>妆容对话</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={view === "library"}
                    onClick={() => setView("library")}
                    className="h-10 rounded-xl px-3 text-white/72 hover:bg-white/10 hover:text-white data-[active=true]:bg-white/12 data-[active=true]:text-white"
                  >
                    <Library />
                    <span>我的化妆品</span>
                    <span className="ml-auto rounded-full bg-[#ef7196]/20 px-2 py-0.5 text-[11px] text-[#ff9eba]">{products.length}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup className="min-h-0 flex-1 py-2">
            <SidebarGroupLabel className="px-3 text-[11px] uppercase tracking-[.16em] text-white/35">对话记录</SidebarGroupLabel>
            <SidebarGroupContent className="mt-2">
              {conversations.length ? (
                <SidebarMenu className="gap-1">
                  {conversations.map((conversation) => (
                    <SidebarMenuItem key={conversation.id}>
                      <SidebarMenuButton
                        isActive={activeConversationId === conversation.id && view === "chat"}
                        onClick={() => openConversation(conversation.id)}
                        className="h-auto min-h-11 rounded-xl px-3 py-2 text-white/62 hover:bg-white/10 hover:text-white data-[active=true]:bg-white/12 data-[active=true]:text-white"
                      >
                        <Clock3 className="size-3.5" />
                        <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
                        <span className="text-[10px] text-white/28">{timeLabel(conversation.updatedAt)}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              ) : (
                <div className="mx-2 rounded-xl border border-white/8 bg-white/[.035] px-3 py-4 text-sm text-white/42">
                  <Archive className="mb-2 size-4" />
                  还没有对话记录
                </div>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="p-4">
          <div className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/[.035] p-3">
            <div className="grid size-8 place-items-center rounded-full bg-white/10 text-xs">MY</div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">我的私人妆台</p>
              <p className="text-[11px] text-white/40">数据仅存本浏览器</p>
            </div>
            <ChevronRight className="size-4 text-white/30" />
          </div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="h-svh min-w-0 overflow-hidden bg-[#f6f4f2]">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-black/[.055] bg-[#fbfaf8]/90 px-4 backdrop-blur-xl sm:px-7">
          <div className="flex items-center gap-3">
            <SidebarTrigger className="md:hidden" />
            <div>
              <p className="text-sm font-semibold text-[#282622]">{view === "chat" ? "妆容拆解" : "我的化妆品库"}</p>
              <p className="text-[11px] text-[#8e8881]">
                {view === "chat" ? "识别妆效 · 匹配妆品 · 生成路线" : `${products.length} 件已确认拥有的化妆品`}
              </p>
            </div>
          </div>
          {view === "chat" ? (
            <div className="flex items-center gap-2 rounded-full border border-black/[.065] bg-white px-3 py-1.5 text-xs text-[#77716b] shadow-sm">
              <span className="size-1.5 rounded-full bg-[#d8587e]" />
              顾问在线
            </div>
          ) : (
            <Button onClick={openCreateProduct} className="rounded-xl bg-[#242421] text-white hover:bg-[#393834]">
              <Plus />
              添加化妆品
            </Button>
          )}
        </header>

        {view === "chat" ? (
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="scrollbar-thin flex-1 overflow-y-auto px-4 pb-36 pt-7 sm:px-8 lg:px-12">
              <div className="mx-auto min-h-full w-full max-w-5xl">
                {isLoadingConversation ? (
                  <div className="grid min-h-[55vh] place-items-center text-sm text-[#8a837d]">
                    <LoaderCircle className="mb-3 size-6 animate-spin" />
                    正在打开这次妆容对话…
                  </div>
                ) : messages.length === 0 ? (
                  <EmptyChat onPick={setDraft} />
                ) : (
                  <div className="space-y-10 py-2">
                    {messages.map((message) =>
                      message.role === "user" ? (
                        <div key={message.id} className="ml-auto max-w-xl rounded-[22px] bg-[#242421] px-5 py-4 text-[15px] leading-7 text-white shadow-lg">
                          {message.content}
                        </div>
                      ) : (
                        <div key={message.id} className="flex min-w-0 gap-3 border-t border-black/[.06] pt-8 first:border-0 first:pt-0">
                          <div className="grid size-9 shrink-0 place-items-center rounded-full bg-[#ef7196] text-sm font-semibold text-white">妆</div>
                          {message.reply ? <AdvisorMessage reply={message.reply} /> : <p className="pt-2 text-[15px] leading-7 text-[#625c57]">{message.content}</p>}
                        </div>
                      ),
                    )}
                    {isSending ? (
                      <div className="flex items-center gap-3 border-t border-black/[.06] pt-8 text-sm text-[#77706a]">
                        <div className="grid size-9 place-items-center rounded-full bg-[#ef7196] text-white">妆</div>
                        <LoaderCircle className="size-4 animate-spin" />
                        正在拆解妆效并核对你的化妆品库…
                      </div>
                    ) : null}
                    <div ref={threadEndRef} />
                  </div>
                )}
              </div>
            </div>

            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#f6f4f2] via-[#f6f4f2] to-transparent px-4 pb-5 pt-12 sm:px-8">
              <form onSubmit={submitPrompt} className="pointer-events-auto mx-auto flex w-full max-w-3xl items-end gap-3 rounded-[24px] border border-black/[.08] bg-white p-2.5 pl-4 shadow-[0_18px_50px_rgba(40,35,32,.12)]">
                <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendPrompt(draft);
                    }
                  }}
                  placeholder="告诉我妆容名字，比如：韩系氧气妆"
                  aria-label="输入妆容名字"
                  rows={1}
                  className="max-h-32 min-h-11 resize-none border-0 bg-transparent px-0 py-3 text-[15px] shadow-none focus-visible:ring-0"
                />
                <Button type="submit" size="icon" disabled={isSending || !draft.trim()} className="size-11 shrink-0 rounded-[15px] bg-[#242421] text-white hover:bg-[#3a3935]" aria-label="发送">
                  {isSending ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}
                </Button>
              </form>
              <p className="pointer-events-auto mx-auto mt-2 max-w-3xl text-center text-[11px] text-[#a29c96]">建议仅用于妆容与选品，不替代皮肤科诊疗。</p>
            </div>
          </div>
        ) : (
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-7 sm:px-8 lg:px-12">
            <div className="mx-auto w-full max-w-6xl">
              <div className="flex flex-col gap-5 border-b border-black/[.07] pb-6 md:flex-row md:items-end md:justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[.16em] text-[#b24c6b]">My beauty kit</p>
                  <h1 className="mt-2 font-serif text-4xl tracking-[-.025em] text-[#282421]">已经拥有的每一件，都先用起来。</h1>
                  <p className="mt-3 text-sm leading-6 text-[#817a74]">录入品牌、完整产品名和色号，顾问才能把匹配单品准确标成 ✅。</p>
                </div>
                <label className="flex h-11 min-w-[260px] items-center gap-2 rounded-xl border border-black/[.08] bg-white px-3 shadow-sm">
                  <Search className="size-4 text-[#9b938c]" />
                  <Input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="搜索品牌、产品或色号" aria-label="搜索化妆品" className="h-auto border-0 p-0 shadow-none focus-visible:ring-0" />
                </label>
              </div>

              <div className="scrollbar-none mt-5 flex gap-2 overflow-x-auto pb-1" aria-label="按品类筛选">
                {visibleCategories.map((category) => (
                  <button key={category} type="button" onClick={() => setCategoryFilter(category)} className={categoryFilter === category ? "whitespace-nowrap rounded-full bg-[#242421] px-3.5 py-2 text-sm text-white" : "whitespace-nowrap rounded-full border border-black/[.07] bg-white px-3.5 py-2 text-sm text-[#746d67] hover:border-[#d8587e]/30"}>
                    {category}
                  </button>
                ))}
              </div>

              {filteredProducts.length ? (
                <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {filteredProducts.map((product, index) => (
                    <article key={product.id} className="group rounded-[20px] border border-black/[.07] bg-white p-5 shadow-[0_8px_28px_rgba(40,35,32,.05)] transition hover:-translate-y-0.5 hover:shadow-[0_14px_34px_rgba(40,35,32,.08)]">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex min-w-0 gap-3">
                          <div className={index % 3 === 0 ? "grid size-11 shrink-0 place-items-center rounded-[14px] bg-[#f7dfe6] text-sm font-semibold text-[#a84362]" : index % 3 === 1 ? "grid size-11 shrink-0 place-items-center rounded-[14px] bg-[#e8e3de] text-sm font-semibold text-[#6b5e55]" : "grid size-11 shrink-0 place-items-center rounded-[14px] bg-[#e4ece5] text-sm font-semibold text-[#4f6a54]"}>
                            {product.category.slice(0, 1)}
                          </div>
                          <div className="min-w-0">
                            <p className="text-[12px] font-medium uppercase tracking-[.08em] text-[#a19891]">{product.brand}</p>
                            <h2 className="mt-1 truncate text-base font-semibold text-[#322e2b]">{product.name}</h2>
                          </div>
                        </div>
                        <button type="button" className="grid size-8 place-items-center rounded-full text-[#9b948e] hover:bg-[#f2efed]" aria-label="更多操作" onClick={() => openEditProduct(product)}>
                          <MoreHorizontal className="size-4" />
                        </button>
                      </div>
                      <div className="mt-5 rounded-[14px] bg-[#f8f6f4] px-3.5 py-3">
                        <p className="text-[11px] text-[#9d958e]">版本 / 色号</p>
                        <p className="mt-1 text-sm font-semibold text-[#4a443f]">{product.shade}</p>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-1.5">
                        {[product.category, product.finish, ...product.tags.split(/[,，、]/)].filter(Boolean).slice(0, 4).map((tag) => (
                          <span key={tag} className="rounded-full border border-black/[.06] px-2.5 py-1 text-[11px] text-[#7e766f]">{tag}</span>
                        ))}
                      </div>
                      {product.notes ? <p className="mt-4 line-clamp-2 text-[13px] leading-6 text-[#817a74]">{product.notes}</p> : null}
                      <div className="mt-5 flex gap-2 border-t border-black/[.055] pt-4">
                        <Button variant="outline" size="sm" className="flex-1 rounded-xl" onClick={() => openEditProduct(product)}><PencilLine />编辑</Button>
                        <Button variant="ghost" size="sm" className="rounded-xl text-[#a7455f] hover:bg-[#fff0f3] hover:text-[#a7455f]" onClick={() => setProductToDelete(product)}><Trash2 />删除</Button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="mt-10 grid min-h-[360px] place-items-center rounded-[24px] border border-dashed border-black/[.12] bg-white/55 text-center">
                  <div className="max-w-sm px-6">
                    <div className="mx-auto grid size-14 place-items-center rounded-[18px] bg-[#f8e7ec] text-[#b64d6c]"><PackageOpen /></div>
                    <h2 className="mt-4 text-lg font-semibold text-[#37322f]">{products.length ? "没有找到匹配的产品" : "你的化妆品库还是空的"}</h2>
                    <p className="mt-2 text-sm leading-6 text-[#817a74]">{products.length ? "换个关键词或选择其他品类。" : "先录入一件你愿意继续使用的化妆品，下一次推荐就能自动判断为 ✅。"}</p>
                    {!products.length ? <Button onClick={openCreateProduct} className="mt-5 rounded-xl bg-[#242421] text-white hover:bg-[#393834]"><Plus />添加第一件</Button> : null}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </SidebarInset>

      <Dialog open={isProductDialogOpen} onOpenChange={setIsProductDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto rounded-[22px] border-black/[.08] bg-[#fbfaf8] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl tracking-[-.02em] text-[#2d2926]">{editingProduct ? "编辑这件化妆品" : "添加到我的化妆品库"}</DialogTitle>
            <DialogDescription className="leading-6">品牌、完整产品名和版本/色号会直接用于推荐里的 ✅ 结论。</DialogDescription>
          </DialogHeader>
          <form onSubmit={saveProduct} className="mt-2 grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium text-[#4d4742]">品牌<Input required value={form.brand} onChange={(event) => setForm((current) => ({ ...current, brand: event.target.value }))} placeholder="例如：rom&nd" className="h-11 rounded-xl bg-white" /></label>
            <label className="grid gap-1.5 text-sm font-medium text-[#4d4742]">品类<Select value={form.category} onValueChange={(category) => setForm((current) => ({ ...current, category }))}><SelectTrigger className="h-11 w-full rounded-xl bg-white"><SelectValue /></SelectTrigger><SelectContent>{categories.map((category) => <SelectItem key={category} value={category}>{category}</SelectItem>)}</SelectContent></Select></label>
            <label className="grid gap-1.5 text-sm font-medium text-[#4d4742] sm:col-span-2">完整产品名<Input required value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="例如：Better Than Cheek" className="h-11 rounded-xl bg-white" /></label>
            <label className="grid gap-1.5 text-sm font-medium text-[#4d4742]">版本 / 色号<Input required value={form.shade} onChange={(event) => setForm((current) => ({ ...current, shade: event.target.value }))} placeholder="例如：#N02 Vine Nude；没有可填“无”" className="h-11 rounded-xl bg-white" /></label>
            <label className="grid gap-1.5 text-sm font-medium text-[#4d4742]">妆效 / 质地<Input value={form.finish} onChange={(event) => setForm((current) => ({ ...current, finish: event.target.value }))} placeholder="例如：柔雾、低显色" className="h-11 rounded-xl bg-white" /></label>
            <label className="grid gap-1.5 text-sm font-medium text-[#4d4742] sm:col-span-2">标签<Input value={form.tags} onChange={(event) => setForm((current) => ({ ...current, tags: event.target.value }))} placeholder="例如：冷粉、低饱和、自然气色" className="h-11 rounded-xl bg-white" /></label>
            <label className="grid gap-1.5 text-sm font-medium text-[#4d4742] sm:col-span-2">备注<Textarea value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} placeholder="可以记录适合的场景、上脸感受或避雷点" className="min-h-24 rounded-xl bg-white" /></label>
            <DialogFooter className="mt-2 sm:col-span-2">
              <Button type="button" variant="outline" className="rounded-xl" onClick={() => setIsProductDialogOpen(false)}>取消</Button>
              <Button type="submit" className="rounded-xl bg-[#242421] text-white hover:bg-[#393834]">{editingProduct ? "保存修改" : "加入化妆品库"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(productToDelete)} onOpenChange={(open) => !open && setProductToDelete(null)}>
        <AlertDialogContent className="rounded-[20px] bg-[#fbfaf8]">
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除这件化妆品？</AlertDialogTitle>
            <AlertDialogDescription>{productToDelete ? `${productToDelete.brand}｜${productToDelete.name}｜${productToDelete.shade}` : ""} 将不再参与之后的 ✅ 匹配。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl">取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" className="rounded-xl" onClick={() => void deleteProduct()}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Toaster position="top-center" richColors />
    </SidebarProvider>
  );
}
