"use client";

import {
  CheckCircle2,
  CircleAlert,
  ClipboardList,
  Loader2,
  PackageCheck,
  Plus,
  RefreshCcw,
  Search,
  Send,
  ShoppingBag,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type { AgentAnswer, SkuCandidate, ToolRun, UserProduct } from "@/lib/types/domain";

const userId = "local-user";

type Turn = {
  id: string;
  role: "user" | "assistant";
  text: string;
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

type EvalResult = {
  passed: boolean;
  results: Array<{
    id: string;
    name: string;
    passed: boolean;
    missing: string[];
    candidateCount: number;
    sourceCount: number;
  }>;
};

const samplePrompts = [
  "我想要白开水妆，但是不要太甜，要干净低饱和一点",
  "小红书搜清冷骨相妆，我应该买什么化妆品",
  "低饱和雾面通勤妆需要准备哪些产品，直接给候选 SKU",
  "我有裸粉腮红，但想做清冷骨相妆，还缺什么"
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
      text: "告诉我一个文字妆容目标，或者直接输入你想在小红书搜什么。我会先拆妆容特点，再看你的妆匣，最后给 SKU 候选。"
    }
  ]);
  const [conversationId, setConversationId] = useState<string>();
  const [isSending, setIsSending] = useState(false);
  const [products, setProducts] = useState<UserProduct[]>([]);
  const [productForm, setProductForm] = useState<ProductFormState>(emptyForm);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AgentAnswer | null>(null);
  const [toolRuns, setToolRuns] = useState<ToolRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [evalResult, setEvalResult] = useState<EvalResult | null>(null);
  const [isRunningEvals, setIsRunningEvals] = useState(false);

  const missingCapabilities = answer?.ownedProductMatch.missingCapabilities ?? [];
  const topCandidates = answer?.skuCandidates.slice(0, 6) ?? [];
  const reviewedLibrary = answer?.ownedProductMatch.reviewed ?? false;

  const statusCopy = useMemo(() => {
    if (isSending) return "正在查资料和拆解";
    if (!answer) return "等待文字目标";
    if (reviewedLibrary) return `已核对 ${products.length} 个妆匣产品`;
    return "本轮按无妆匣分支推荐";
  }, [answer, isSending, products.length, reviewedLibrary]);

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
    setAnswer(null);
    setToolRuns([]);
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

          if (parsed.event === "tool") {
            setToolRuns((current) => [...current, parsed.data as ToolRun]);
          }

          if (parsed.event === "result") {
            const nextAnswer = parsed.data as AgentAnswer;
            setAnswer(nextAnswer);
            setConversationId(nextAnswer.conversationId);
            setToolRuns(nextAnswer.toolRuns);
            setTurns((current) =>
              current.map((turn) =>
                turn.id === assistantTurnId ? { ...turn, text: nextAnswer.answerText } : turn
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

  async function runEvals() {
    setIsRunningEvals(true);
    setEvalResult(null);
    try {
      const response = await fetch("/api/evals/run", { method: "POST" });
      setEvalResult(await response.json());
    } finally {
      setIsRunningEvals(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">妆</div>
          <div>
            <p className="eyebrow">LOOKTRACE MVP</p>
            <h1>妆迹文字工作台</h1>
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

      <div className="workspace-grid">
        <section className="chat-pane" aria-label="妆容对话">
          <div className="pane-heading">
            <div>
              <p className="eyebrow">文字目标</p>
              <h2>问这个妆要用什么</h2>
            </div>
            <Search size={20} aria-hidden="true" />
          </div>

          <div className="prompt-strip" aria-label="示例问题">
            {samplePrompts.map((prompt) => (
              <button key={prompt} type="button" onClick={() => setMessage(prompt)}>
                {prompt}
              </button>
            ))}
          </div>

          <div className="messages" aria-live="polite">
            {turns.map((turn) => (
              <article key={turn.id} className={`message ${turn.role}`}>
                <span>{turn.role === "user" ? "你" : "妆迹"}</span>
                <p>{turn.text || "正在整理..."}</p>
              </article>
            ))}
          </div>

          <form className="composer" onSubmit={submitMessage}>
            <textarea
              aria-label="输入文字妆容目标"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="例如：清冷骨相妆，小红书搜到很多清单，我到底该买哪些化妆品？"
              rows={3}
            />
            <button className="primary-button" type="submit" disabled={isSending || !message.trim()}>
              {isSending ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
              发送
            </button>
          </form>
        </section>

        <section className="result-pane" aria-label="结构化推荐结果">
          <div className="pane-heading">
            <div>
              <p className="eyebrow">拆解与推荐</p>
              <h2>{answer?.lookFeatures.overallStyle ?? "等待第一轮结果"}</h2>
            </div>
            <Sparkles size={20} aria-hidden="true" />
          </div>

          <div className="result-scroll">
            <section className="pane-block">
              <div className="block-title">
                <Search size={17} />
                <h3>本轮检索</h3>
              </div>
              {answer?.searchPlan.isClearEnough ? (
                <div className="search-plan">
                  <div>
                    <span>小红书</span>
                    <p>{answer.searchPlan.xhsQuery}</p>
                  </div>
                  <div>
                    <span>淘宝</span>
                    <p>{answer.searchPlan.taobaoQueries.join(" / ")}</p>
                  </div>
                </div>
              ) : (
                <p className="muted">我会按用户当轮的具体诉求生成小红书和淘宝检索词；目标太泛时会先追问。</p>
              )}
            </section>

            <section className="pane-block">
              <div className="block-title">
                <ClipboardList size={17} />
                <h3>妆容特点</h3>
              </div>
              {answer ? (
                <div className="feature-grid">
                  <Feature label="底妆" values={answer.lookFeatures.base} />
                  <Feature label="眉眼" values={[...answer.lookFeatures.eyes, ...answer.lookFeatures.brows]} />
                  <Feature label="腮红唇部" values={[...answer.lookFeatures.cheeks, ...answer.lookFeatures.lips]} />
                  <Feature label="质地重心" values={[...answer.lookFeatures.texture, ...answer.lookFeatures.focus]} />
                </div>
              ) : (
                <p className="muted">发送文字目标后，这里会展示底妆、眉眼、腮红唇部和质地重心。</p>
              )}
            </section>

            <section className="pane-block">
              <div className="block-title">
                <PackageCheck size={17} />
                <h3>妆匣核对</h3>
              </div>
              {answer ? (
                <div className="match-summary">
                  <Metric label="可直接用" value={answer.ownedProductMatch.usableItems.length} tone="sage" />
                  <Metric label="可替代" value={answer.ownedProductMatch.partialMatches.length} tone="amber" />
                  <Metric label="缺口" value={missingCapabilities.length} tone="rose" />
                </div>
              ) : (
                <p className="muted">有妆匣时会先核对已有产品；没有录入也能直接推荐 SKU。</p>
              )}
              {missingCapabilities.length > 0 ? (
                <ul className="capability-list">
                  {missingCapabilities.map((capability) => (
                    <li key={`${capability.category}-${capability.capability}`}>
                      <strong>{capability.category}</strong>
                      <span>{capability.capability}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>

            <section className="pane-block">
              <div className="block-title">
                <ShoppingBag size={17} />
                <h3>SKU 候选</h3>
              </div>
              <div className="candidate-list">
                {topCandidates.length > 0 ? topCandidates.map((candidate) => (
                  <article className="candidate-card" key={candidate.id}>
                    <div className="candidate-top">
                      <div>
                        <p>{candidate.category}</p>
                        <h4>{candidate.brand} {candidate.name}</h4>
                      </div>
                      <span>{candidate.priority === "necessary" ? "必需" : candidate.priority === "helpful" ? "建议" : "可选"}</span>
                    </div>
                    <div className="swatch-row" aria-label="色系和质地">
                      <span className={`swatch ${candidate.colorFamily?.includes("粉") ? "rose" : ""}`} />
                      <span>{candidate.shade ?? candidate.colorFamily ?? "按目标色系选"}</span>
                      <span>{candidate.finish ?? "质地待确认"}</span>
                    </div>
                    <p>{candidate.reason}</p>
                    <div className="candidate-footer">
                      <span>{candidate.price ?? "待淘宝 API 接入"} · {candidate.channel ?? "渠道占位"}</span>
                      <div className="candidate-actions">
                        {candidate.purchaseUrl ? (
                          <a className="link-button" href={candidate.purchaseUrl} target="_blank" rel="noreferrer">
                            <Search size={15} />
                            淘宝
                          </a>
                        ) : null}
                        <button
                          type="button"
                          title="加入妆匣表单"
                          onClick={() => {
                            setProductForm(candidateToForm(candidate));
                            setEditingProductId(null);
                          }}
                        >
                          <Plus size={15} />
                          加入妆匣
                        </button>
                      </div>
                    </div>
                  </article>
                )) : (
                  <p className="muted">SKU 结果会包含品牌、商品名、色号/规格、推荐理由和淘宝占位信息。</p>
                )}
              </div>
            </section>

            <section className="pane-block">
              <div className="block-title">
                <RefreshCcw size={17} />
                <h3>工具日志与评测</h3>
              </div>
              <div className="tool-log">
                {toolRuns.length > 0 ? toolRuns.map((run) => (
                  <div key={run.id} className="tool-row">
                    <CheckCircle2 size={15} />
                    <span>{run.toolName}</span>
                    <small>{run.outputSummary}</small>
                  </div>
                )) : (
                  <p className="muted">每次回答会记录小红书、拆解、SKU、淘宝和妆匣匹配日志。</p>
                )}
              </div>
              <button className="secondary-button" type="button" onClick={runEvals} disabled={isRunningEvals}>
                {isRunningEvals ? <Loader2 className="spin" size={16} /> : <CheckCircle2 size={16} />}
                运行离线 eval
              </button>
              {evalResult ? (
                <p className={evalResult.passed ? "eval-pass" : "eval-fail"}>
                  {evalResult.results.filter((item) => item.passed).length}/{evalResult.results.length} 通过
                </p>
              ) : null}
            </section>
          </div>
        </section>

        <aside className="library-pane" aria-label="手动妆匣">
          <div className="pane-heading">
            <div>
              <p className="eyebrow">手动妆匣</p>
              <h2>{products.length} 个已有产品</h2>
            </div>
            <ShoppingBag size={20} aria-hidden="true" />
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
                <Plus size={17} />
                {editingProductId ? "保存修改" : "加入妆匣"}
              </button>
              {editingProductId ? (
                <button
                  className="ghost-button"
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
                <ShoppingBag size={22} />
                <p>先不录也可以问；录入后，下一轮会先 review 你的妆匣。</p>
              </div>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}

function Feature({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="feature-card">
      <span>{label}</span>
      <p>{values.slice(0, 4).join("、")}</p>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: "sage" | "amber" | "rose" }) {
  return (
    <div className={`metric ${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
