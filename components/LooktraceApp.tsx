"use client";

import {
  CheckCircle2,
  CircleAlert,
  ClipboardList,
  ExternalLink,
  Loader2,
  PackageCheck,
  PanelRightOpen,
  Plus,
  Search,
  Send,
  ShoppingBag,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type { AgentAnswer, SkuCandidate, UserProduct } from "@/lib/types/domain";

const userId = "local-user";

type Turn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  answer?: AgentAnswer;
};

type ProductFormState = {
  brand: string;
  name: string;
  category: string;
  shade: string;
  colorFamily: string;
  finish: string;
  texture: string;
  effectTags: string;
  notes: string;
};

const samplePrompts = [
  "我想要白开水妆，但是不要太甜，要干净低饱和一点",
  "小红书搜清冷骨相妆，我应该买什么化妆品",
  "低饱和雾面通勤妆需要准备哪些产品，直接给候选 SKU"
];

const categoryOptions = ["粉底液", "腮红", "眉笔", "唇泥", "唇釉", "修容", "眼影", "卧蚕笔"];

const emptyForm: ProductFormState = {
  brand: "",
  name: "",
  category: "腮红",
  shade: "",
  colorFamily: "",
  finish: "",
  texture: "",
  effectTags: "",
  notes: ""
};

function makeClientId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function parseTags(value: string): string[] {
  return value
    .split(/[,，、\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parseSseBlock(block: string): { event: string; data: unknown } | null {
  const lines = block.split("\n").filter(Boolean);
  const event = lines.find((line) => line.startsWith("event: "))?.replace("event: ", "");
  const data = lines
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.replace("data: ", ""))
    .join("\n");

  if (!event || !data) return null;

  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

function candidateToForm(candidate: SkuCandidate): ProductFormState {
  return {
    brand: candidate.brand,
    name: candidate.name,
    category: candidate.category,
    shade: candidate.shade ?? "",
    colorFamily: candidate.colorFamily ?? "",
    finish: candidate.finish ?? "",
    texture: candidate.texture ?? "",
    effectTags: candidate.effectTags.join("、"),
    notes: candidate.reason
  };
}

export function LooktraceApp() {
  const [message, setMessage] = useState("");
  const [turns, setTurns] = useState<Turn[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "告诉我一个文字妆容目标，或者直接输入你想搜索的妆容方向。我会参考互联网信息拆出妆容特点，再看你的妆匣，最后给 SKU 候选。"
    }
  ]);
  const [conversationId, setConversationId] = useState<string>();
  const [isSending, setIsSending] = useState(false);
  const [products, setProducts] = useState<UserProduct[]>([]);
  const [productForm, setProductForm] = useState<ProductFormState>(emptyForm);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [latestAnswer, setLatestAnswer] = useState<AgentAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);

  const statusCopy = useMemo(() => {
    if (isSending) return "正在检索和整理";
    if (latestAnswer?.ownedProductMatch.reviewed) return `已核对 ${products.length} 个妆匣产品`;
    if (latestAnswer) return "已生成本轮建议";
    return "等待文字目标";
  }, [isSending, latestAnswer, products.length]);

  async function loadProducts() {
    const response = await fetch(`/api/user-products?userId=${userId}`, { cache: "no-store" });
    const data = await response.json();
    setProducts(data.products ?? []);
  }

  useEffect(() => {
    loadProducts();
  }, []);

  async function submitMessage(event?: FormEvent) {
    event?.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || isSending) return;

    const assistantTurnId = makeClientId("assistant");
    setError(null);
    setLatestAnswer(null);
    setIsSending(true);
    setTurns((current) => [
      ...current,
      { id: makeClientId("user"), role: "user", text: trimmed },
      { id: assistantTurnId, role: "assistant", text: "" }
    ]);
    setMessage("");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, conversationId, userId })
      });

      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error ?? "对话接口没有返回流式结果。");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          const parsed = parseSseBlock(block);
          if (!parsed) continue;

          if (parsed.event === "chunk") {
            const text = (parsed.data as { text?: string }).text ?? "";
            setTurns((current) =>
              current.map((turn) =>
                turn.id === assistantTurnId ? { ...turn, text: `${turn.text}${text}` } : turn
              )
            );
          }

          if (parsed.event === "result") {
            const nextAnswer = parsed.data as AgentAnswer;
            setLatestAnswer(nextAnswer);
            setConversationId(nextAnswer.conversationId);
            setTurns((current) =>
              current.map((turn) =>
                turn.id === assistantTurnId
                  ? { ...turn, text: nextAnswer.answerText, answer: nextAnswer }
                  : turn
              )
            );
          }

          if (parsed.event === "error") {
            throw new Error((parsed.data as { message?: string }).message ?? "生成推荐失败。");
          }
        }
      }
    } catch (caught) {
      const messageText = caught instanceof Error ? caught.message : "生成推荐失败。";
      setError(messageText);
      setTurns((current) =>
        current.map((turn) =>
          turn.id === assistantTurnId ? { ...turn, text: `这轮没有跑通：${messageText}` } : turn
        )
      );
    } finally {
      setIsSending(false);
    }
  }

  async function saveProduct(event: FormEvent) {
    event.preventDefault();
    if (!productForm.brand.trim() || !productForm.name.trim() || !productForm.category.trim()) return;

    const payload = {
      userId,
      brand: productForm.brand,
      name: productForm.name,
      category: productForm.category,
      shade: productForm.shade,
      colorFamily: productForm.colorFamily,
      finish: productForm.finish,
      texture: productForm.texture,
      effectTags: parseTags(productForm.effectTags),
      notes: productForm.notes
    };

    const url = editingProductId ? `/api/user-products/${editingProductId}` : "/api/user-products";
    const method = editingProductId ? "PATCH" : "POST";
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const data = await response.json().catch(() => null);
      setError(data?.error ?? "保存妆匣产品失败。");
      return;
    }

    setProductForm(emptyForm);
    setEditingProductId(null);
    await loadProducts();
  }

  async function deleteProduct(productId: string) {
    const response = await fetch(`/api/user-products/${productId}?userId=${userId}`, { method: "DELETE" });
    if (!response.ok) {
      setError("删除妆匣产品失败。");
      return;
    }
    await loadProducts();
  }

  function addCandidateToLibrary(candidate: SkuCandidate) {
    setProductForm(candidateToForm(candidate));
    setEditingProductId(null);
    setIsLibraryOpen(true);
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">妆</div>
          <div>
            <h1>妆迹</h1>
            <p>LOOKTRACE</p>
          </div>
        </div>
        <div className="header-status" aria-live="polite">
          <span className={isSending ? "live-dot active" : "live-dot"} />
          {statusCopy}
        </div>
      </header>

      {error ? (
        <div className="error-banner" role="alert">
          <CircleAlert size={18} />
          <span>{error}</span>
          <button className="icon-button" type="button" title="关闭提示" onClick={() => setError(null)}>
            <X size={16} />
          </button>
        </div>
      ) : null}

      <section className="chat-shell" aria-label="实时妆容聊天">
        <div className="thread" aria-live="polite">
          <div className="intro-panel">
            <p>REAL-TIME BEAUTY CHAT</p>
            <h2>说出你想完成的妆，我来帮你拆成产品选择。</h2>
            <div className="prompt-strip" aria-label="示例问题">
              {samplePrompts.map((prompt) => (
                <button key={prompt} type="button" onClick={() => setMessage(prompt)}>
                  {prompt}
                </button>
              ))}
            </div>
          </div>

          {turns.map((turn) => (
            <ChatTurn key={turn.id} turn={turn} onCandidateToLibrary={addCandidateToLibrary} />
          ))}
        </div>

        <form className="composer" onSubmit={submitMessage}>
          <textarea
            aria-label="输入文字妆容目标"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="例如：清冷骨相妆，小红书搜到很多清单，我到底该买哪些化妆品？"
            rows={1}
          />
          <button className="send-button" type="submit" title="发送" disabled={isSending || !message.trim()}>
            {isSending ? <Loader2 className="spin" size={19} /> : <Send size={19} />}
          </button>
        </form>
      </section>

      <button className="library-fab" type="button" onClick={() => setIsLibraryOpen(true)}>
        <PanelRightOpen size={18} />
        <span>妆匣</span>
        <strong>{products.length}</strong>
      </button>

      <div
        className={`drawer-backdrop ${isLibraryOpen ? "show" : ""}`}
        aria-hidden="true"
        onClick={() => setIsLibraryOpen(false)}
      />
      <aside className={`library-drawer ${isLibraryOpen ? "open" : ""}`} aria-label="我的妆匣">
        <div className="drawer-header">
          <div>
            <p>MY BEAUTY KIT</p>
            <h2>我的妆匣</h2>
            <span>一期只做手动录入，下一轮聊天会优先核对这些化妆品。</span>
          </div>
          <button className="icon-button" type="button" title="关闭妆匣" onClick={() => setIsLibraryOpen(false)}>
            <X size={18} />
          </button>
        </div>

        <div className="drawer-body">
          <section className="drawer-section">
            <div className="section-heading">
              <ShoppingBag size={17} />
              <h3>已有产品</h3>
            </div>
            <div className="product-list">
              {products.length > 0 ? products.map((product) => (
                <article className="product-card" key={product.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setProductForm({
                        brand: product.brand,
                        name: product.name,
                        category: product.category,
                        shade: product.shade ?? "",
                        colorFamily: product.colorFamily ?? "",
                        finish: product.finish ?? "",
                        texture: product.texture ?? "",
                        effectTags: product.effectTags.join("、"),
                        notes: product.notes ?? ""
                      });
                      setEditingProductId(product.id);
                    }}
                  >
                    <strong>{product.brand} {product.name}</strong>
                    <span>{product.category} · {product.shade ?? product.colorFamily ?? "未填色号"}</span>
                  </button>
                  <button className="icon-button" type="button" title="删除产品" onClick={() => deleteProduct(product.id)}>
                    <Trash2 size={16} />
                  </button>
                </article>
              )) : (
                <div className="empty-library">
                  <ShoppingBag size={20} />
                  <p>先不录也可以问；录入后，我会先看你的妆匣再推荐新的 SKU。</p>
                </div>
              )}
            </div>
          </section>

          <section className="drawer-section">
            <div className="section-heading">
              <Plus size={17} />
              <h3>{editingProductId ? "编辑产品" : "新增化妆品"}</h3>
            </div>
            <form className="product-form" onSubmit={saveProduct}>
              <div className="form-row">
                <label>
                  品牌
                  <input value={productForm.brand} onChange={(event) => setProductForm({ ...productForm, brand: event.target.value })} />
                </label>
                <label>
                  品类
                  <select value={productForm.category} onChange={(event) => setProductForm({ ...productForm, category: event.target.value })}>
                    {categoryOptions.map((category) => (
                      <option key={category} value={category}>{category}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                产品名
                <input value={productForm.name} onChange={(event) => setProductForm({ ...productForm, name: event.target.value })} />
              </label>
              <div className="form-row">
                <label>
                  色号
                  <input value={productForm.shade} onChange={(event) => setProductForm({ ...productForm, shade: event.target.value })} />
                </label>
                <label>
                  色系
                  <input value={productForm.colorFamily} onChange={(event) => setProductForm({ ...productForm, colorFamily: event.target.value })} />
                </label>
              </div>
              <div className="form-row">
                <label>
                  妆效
                  <input value={productForm.finish} onChange={(event) => setProductForm({ ...productForm, finish: event.target.value })} />
                </label>
                <label>
                  质地
                  <input value={productForm.texture} onChange={(event) => setProductForm({ ...productForm, texture: event.target.value })} />
                </label>
              </div>
              <label>
                标签
                <input
                  value={productForm.effectTags}
                  onChange={(event) => setProductForm({ ...productForm, effectTags: event.target.value })}
                  placeholder="低饱和、雾面、灰棕"
                />
              </label>
              <label>
                备注
                <textarea
                  value={productForm.notes}
                  onChange={(event) => setProductForm({ ...productForm, notes: event.target.value })}
                  rows={2}
                />
              </label>
              <div className="form-actions">
                <button className="primary-button" type="submit">
                  <CheckCircle2 size={17} />
                  {editingProductId ? "保存修改" : "保存"}
                </button>
                {editingProductId ? (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => {
                      setProductForm(emptyForm);
                      setEditingProductId(null);
                    }}
                  >
                    取消
                  </button>
                ) : null}
              </div>
            </form>
          </section>
        </div>
      </aside>
    </main>
  );
}

function ChatTurn({
  turn,
  onCandidateToLibrary
}: {
  turn: Turn;
  onCandidateToLibrary: (candidate: SkuCandidate) => void;
}) {
  const label = turn.role === "user" ? "你" : "妆迹";

  return (
    <article className={`chat-turn ${turn.role}`}>
      <div className="avatar" aria-hidden="true">{turn.role === "user" ? "你" : "妆"}</div>
      <div className="turn-content">
        <span className="turn-label">{label}</span>
        {turn.answer ? (
          <StructuredAnswer answer={turn.answer} onCandidateToLibrary={onCandidateToLibrary} />
        ) : (
          <p className="message-text">{turn.text || "正在整理..."}</p>
        )}
      </div>
    </article>
  );
}

function StructuredAnswer({
  answer,
  onCandidateToLibrary
}: {
  answer: AgentAnswer;
  onCandidateToLibrary: (candidate: SkuCandidate) => void;
}) {
  if (!answer.searchPlan.isClearEnough) {
    return <p className="message-text">{answer.answerText}</p>;
  }

  const topCandidates = answer.skuCandidates.slice(0, 5);
  const missingCapabilities = answer.ownedProductMatch.missingCapabilities;

  return (
    <div className="answer-card">
      <p className="answer-lead">
        我先按「{answer.lookFeatures.overallStyle}」来拆。参考来源于互联网；先看妆容共同点，再落到化妆品品类和 SKU。
      </p>

      <section className="answer-section">
        <div className="section-heading">
          <Search size={16} />
          <h3>本轮参考</h3>
        </div>
        <p className="source-copy">
          参考来源于互联网。淘宝用于补全候选 SKU 的价格、渠道和购买入口。
        </p>
      </section>

      <section className="answer-section">
        <div className="section-heading">
          <ClipboardList size={16} />
          <h3>妆容特点</h3>
        </div>
        <div className="feature-grid">
          <Feature label="底妆" values={answer.lookFeatures.base} />
          <Feature label="眉眼" values={[...answer.lookFeatures.eyes, ...answer.lookFeatures.brows]} />
          <Feature label="腮红唇部" values={[...answer.lookFeatures.cheeks, ...answer.lookFeatures.lips]} />
          <Feature label="质地重心" values={[...answer.lookFeatures.texture, ...answer.lookFeatures.focus]} />
        </div>
      </section>

      <section className="answer-section">
        <div className="section-heading">
          <PackageCheck size={16} />
          <h3>妆匣核对</h3>
        </div>
        <div className="match-row">
          <Metric label="可用" value={answer.ownedProductMatch.usableItems.length} />
          <Metric label="可替" value={answer.ownedProductMatch.partialMatches.length} />
          <Metric label="缺口" value={missingCapabilities.length} />
        </div>
        <p className="source-copy">
          {answer.ownedProductMatch.reviewed
            ? `我看了你的妆匣，当前还缺 ${missingCapabilities.length} 类能力。`
            : "你还没有录入妆匣，所以本轮直接按目标妆效给 SKU 候选。"}
        </p>
      </section>

      <section className="answer-section">
        <div className="section-heading">
          <Sparkles size={16} />
          <h3>SKU 候选</h3>
        </div>
        <div className="candidate-list">
          {topCandidates.map((candidate) => (
            <article className="candidate-card" key={candidate.id}>
              <div className="candidate-main">
                <span className={`swatch ${candidate.colorFamily?.includes("粉") ? "rose" : ""}`} />
                <div>
                  <strong>{candidate.brand} {candidate.name}</strong>
                  <span>{candidate.category} · {candidate.shade ?? candidate.colorFamily ?? "按目标色系选"}</span>
                </div>
              </div>
              <p>{candidate.reason}</p>
              <div className="candidate-actions">
                {candidate.purchaseUrl ? (
                  <a className="link-button" href={candidate.purchaseUrl} target="_blank" rel="noreferrer">
                    <ExternalLink size={14} />
                    淘宝
                  </a>
                ) : null}
                <button type="button" onClick={() => onCandidateToLibrary(candidate)}>
                  <Plus size={14} />
                  妆匣
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function Feature({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="feature-card">
      <span>{label}</span>
      <p>{values.slice(0, 4).join("、") || "待确认"}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
