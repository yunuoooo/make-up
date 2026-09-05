"use client";

import { CircleAlert, Loader2, PanelRightOpen, Send, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { SkuCandidate } from "@/lib/types/domain";
import { BeautyKitDrawer } from "@/frontend/components/beauty-kit/BeautyKitDrawer";
import { ChatTurn } from "@/frontend/components/chat/ChatTurn";
import { useBeautyKit } from "@/frontend/hooks/useBeautyKit";
import { useChat } from "@/frontend/hooks/useChat";
import { CURRENT_USER_ID, SAMPLE_PROMPTS } from "@/frontend/lib/constants";

export function LooktraceApp() {
  const [error, setError] = useState<string | null>(null);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const chat = useChat({ userId: CURRENT_USER_ID, onError: setError });
  const beautyKit = useBeautyKit({ userId: CURRENT_USER_ID, onError: setError });

  const statusCopy = useMemo(() => {
    if (chat.isSending) return "正在检索和整理";
    if (chat.latestAnswer?.ownedProductMatch.reviewed) {
      return `已核对 ${beautyKit.products.length} 个妆匣产品`;
    }
    if (chat.latestAnswer) return "已生成本轮建议";
    return "等待文字目标";
  }, [beautyKit.products.length, chat.isSending, chat.latestAnswer]);

  function addCandidateToLibrary(candidate: SkuCandidate) {
    beautyKit.fillFromCandidate(candidate);
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
          <span className={chat.isSending ? "live-dot active" : "live-dot"} />
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
              {SAMPLE_PROMPTS.map((prompt) => (
                <button key={prompt} type="button" onClick={() => chat.setMessage(prompt)}>
                  {prompt}
                </button>
              ))}
            </div>
          </div>

          {chat.turns.map((turn) => (
            <ChatTurn key={turn.id} turn={turn} onCandidateToLibrary={addCandidateToLibrary} />
          ))}
        </div>

        <form className="composer" onSubmit={chat.submitMessage}>
          <textarea
            aria-label="输入文字妆容目标"
            value={chat.message}
            onChange={(event) => chat.setMessage(event.target.value)}
            placeholder="例如：清冷骨相妆，小红书搜到很多清单，我到底该买哪些化妆品？"
            rows={1}
          />
          <button className="send-button" type="submit" title="发送" disabled={chat.isSending || !chat.message.trim()}>
            {chat.isSending ? <Loader2 className="spin" size={19} /> : <Send size={19} />}
          </button>
        </form>
      </section>

      <button className="library-fab" type="button" onClick={() => setIsLibraryOpen(true)}>
        <PanelRightOpen size={18} />
        <span>妆匣</span>
        <strong>{beautyKit.products.length}</strong>
      </button>

      <BeautyKitDrawer
        isOpen={isLibraryOpen}
        products={beautyKit.products}
        form={beautyKit.productForm}
        editingProductId={beautyKit.editingProductId}
        onClose={() => setIsLibraryOpen(false)}
        onEdit={beautyKit.editProduct}
        onDelete={beautyKit.deleteProduct}
        onFieldChange={beautyKit.updateProductField}
        onSave={beautyKit.saveProduct}
        onCancelEdit={beautyKit.resetProductForm}
      />
    </main>
  );
}
