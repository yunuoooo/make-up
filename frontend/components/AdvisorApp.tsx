"use client";

import { useCallback, useState, type FormEvent } from "react";
import {
  Archive,
  ChevronRight,
  Clock3,
  Library,
  MessageCircleMore,
  Plus,
  Trash2
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/frontend/components/ui/button";
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
  SidebarTrigger
} from "@/frontend/components/ui/sidebar";
import { Toaster } from "@/frontend/components/ui/sonner";
import { ChatView } from "@/frontend/components/chat/ChatView";
import { LibraryComingSoon } from "@/frontend/components/beauty-kit/LibraryComingSoon";
import { LibraryView } from "@/frontend/components/beauty-kit/LibraryView";
import { ProductDialog } from "@/frontend/components/beauty-kit/ProductDialog";
import { useBeautyKit } from "@/frontend/hooks/useBeautyKit";
import { useChat } from "@/frontend/hooks/useChat";
import { useConversations } from "@/frontend/hooks/useConversations";
import { CURRENT_USER_ID, IS_LIBRARY_OPEN } from "@/frontend/lib/constants";
import { timeLabel } from "@/frontend/lib/formatters";
import type { UserProduct } from "@/lib/types/domain";

type View = "chat" | "library";

export function AdvisorApp() {
  const [view, setView] = useState<View>("chat");
  const [isProductDialogOpen, setIsProductDialogOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<UserProduct | null>(null);
  const [productToDelete, setProductToDelete] = useState<UserProduct | null>(null);

  const onError = useCallback((message: string) => toast.error(message), []);
  const conversations = useConversations(onError);
  const beautyKit = useBeautyKit({ userId: CURRENT_USER_ID, onError });
  const chat = useChat({ userId: CURRENT_USER_ID, onError, onPersist: conversations.save });

  // 化妆品库关闭期间，标题栏只交代状态，不再提供「添加化妆品」的入口。
  const libraryTitle = IS_LIBRARY_OPEN ? "我的化妆品库" : "我的化妆品";
  const librarySummary = IS_LIBRARY_OPEN
    ? `${beautyKit.products.length} 件已确认拥有的化妆品`
    : "暂未开放";

  function startNewChat() {
    setView("chat");
    chat.startNewChat();
  }

  function openConversation(id: string) {
    setView("chat");
    chat.loadConversation(id, conversations.load(id));
  }

  async function deleteConversation(id: string) {
    conversations.remove(id);
    if (chat.conversationId === id) chat.startNewChat();
    // 服务端会话也要删：只删本地的话，磁盘上还留着完整上下文（spec 09-23 第 4.6 节）。
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`sessions delete ${response.status}`);
      toast.success("这条对话记录已删除");
    } catch {
      toast.error("本地记录已删除，但服务端会话没有删掉。");
    }
  }

  function openCreateProduct() {
    setEditingProduct(null);
    beautyKit.resetProductForm();
    setIsProductDialogOpen(true);
  }

  function openEditProduct(product: UserProduct) {
    setEditingProduct(product);
    beautyKit.editProduct(product);
    setIsProductDialogOpen(true);
  }

  async function submitProduct(event: FormEvent) {
    const saved = await beautyKit.saveProduct(event);
    if (saved) {
      setIsProductDialogOpen(false);
      setEditingProduct(null);
    }
  }

  async function confirmDeleteProduct() {
    if (!productToDelete) return;
    await beautyKit.deleteProduct(productToDelete.id);
    setProductToDelete(null);
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
                    {IS_LIBRARY_OPEN ? (
                      <span className="ml-auto rounded-full bg-[#ef7196]/20 px-2 py-0.5 text-[11px] text-[#ff9eba]">
                        {beautyKit.products.length}
                      </span>
                    ) : (
                      <span className="ml-auto rounded-full bg-white/8 px-2 py-0.5 text-[11px] text-white/40">
                        暂未开放
                      </span>
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup className="min-h-0 flex-1 py-2">
            <SidebarGroupLabel className="px-3 text-[11px] uppercase tracking-[.16em] text-white/35">
              对话记录
            </SidebarGroupLabel>
            <SidebarGroupContent className="mt-2">
              {conversations.conversations.length ? (
                <SidebarMenu className="gap-1">
                  {conversations.conversations.map((conversation) => (
                    <SidebarMenuItem key={conversation.id} className="group/conversation relative">
                      <SidebarMenuButton
                        isActive={chat.conversationId === conversation.id && view === "chat"}
                        onClick={() => openConversation(conversation.id)}
                        className="h-auto min-h-11 rounded-xl px-3 py-2 pr-9 text-white/62 hover:bg-white/10 hover:text-white data-[active=true]:bg-white/12 data-[active=true]:text-white"
                      >
                        <Clock3 className="size-3.5" />
                        <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
                        <span className="text-[10px] text-white/28">{timeLabel(conversation.updatedAt)}</span>
                      </SidebarMenuButton>
                      <button
                        type="button"
                        aria-label={`删除对话 ${conversation.title}`}
                        onClick={() => deleteConversation(conversation.id)}
                        className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded-lg p-1.5 text-white/40 hover:bg-white/10 hover:text-white group-hover/conversation:block"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
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
              <p className="truncate text-[11px] text-white/40">妆匣与对话上下文都在服务端</p>
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
              <p className="text-sm font-semibold text-[#282622]">
                {view === "chat" ? "妆容拆解" : libraryTitle}
              </p>
              <p className="text-[11px] text-[#8e8881]">
                {view === "chat" ? "小红书研究 · 匹配妆品 · 生成路线" : librarySummary}
              </p>
            </div>
          </div>
          {view === "chat" ? (
            <div className="flex items-center gap-2 rounded-full border border-black/[.065] bg-white px-3 py-1.5 text-xs text-[#77716b] shadow-sm">
              <span className={chat.isSending ? "size-1.5 animate-pulse rounded-full bg-[#d8587e]" : "size-1.5 rounded-full bg-[#d8587e]"} />
              {chat.isSending ? chat.runtimePhase ?? "顾问工作中" : "顾问在线"}
            </div>
          ) : IS_LIBRARY_OPEN ? (
            <Button onClick={openCreateProduct} className="rounded-xl bg-[#242421] text-white hover:bg-[#393834]">
              <Plus />
              添加化妆品
            </Button>
          ) : null}
        </header>

        {view === "chat" ? (
          <ChatView
            turns={chat.turns}
            draft={chat.message}
            isSending={chat.isSending}
            runtimePhase={chat.runtimePhase}
            isHistorical={chat.isHistorical}
            isSessionMissing={chat.isSessionMissing}
            onDraftChange={chat.setMessage}
            onSubmit={chat.submitMessage}
          />
        ) : IS_LIBRARY_OPEN ? (
          <LibraryView
            products={beautyKit.filteredProducts}
            totalCount={beautyKit.products.length}
            searchTerm={beautyKit.searchTerm}
            categoryFilter={beautyKit.categoryFilter}
            categories={beautyKit.categories}
            onSearchChange={beautyKit.setSearchTerm}
            onCategoryChange={beautyKit.setCategoryFilter}
            onCreate={openCreateProduct}
            onEdit={openEditProduct}
            onDelete={setProductToDelete}
          />
        ) : (
          <LibraryComingSoon />
        )}
      </SidebarInset>

      <ProductDialog
        open={isProductDialogOpen}
        onOpenChange={(next) => {
          setIsProductDialogOpen(next);
          if (!next) setEditingProduct(null);
        }}
        editingProduct={editingProduct}
        form={beautyKit.productForm}
        onFieldChange={beautyKit.updateProductField}
        onSubmit={submitProduct}
        productToDelete={productToDelete}
        onCancelDelete={() => setProductToDelete(null)}
        onConfirmDelete={confirmDeleteProduct}
      />

      <Toaster position="top-center" richColors />
    </SidebarProvider>
  );
}
