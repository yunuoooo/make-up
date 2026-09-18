import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { conversations, messages, products } from "@/db/schema";
import { buildAdvisorReply } from "@/lib/advisor";

type ChatPayload = {
  message?: string;
  conversationId?: string;
};

function makeTitle(message: string) {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 18 ? `${compact.slice(0, 18)}…` : compact;
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as ChatPayload;
    const content = payload.message?.trim() ?? "";
    if (!content) {
      return Response.json({ error: "请先告诉我一个妆容名字。" }, { status: 400 });
    }

    const db = getDb();
    const allProducts = await db.select().from(products);
    const reply = buildAdvisorReply(content, allProducts);
    const conversationId = payload.conversationId || crypto.randomUUID();
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const now = new Date().toISOString();

    if (payload.conversationId) {
      const [existing] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      if (!existing) {
        return Response.json({ error: "这条对话记录不存在。" }, { status: 404 });
      }

      await db.batch([
        db.insert(messages).values({
          id: userMessageId,
          conversationId,
          role: "user",
          content,
          createdAt: now,
        }),
        db.insert(messages).values({
          id: assistantMessageId,
          conversationId,
          role: "assistant",
          content: reply.summary,
          payload: JSON.stringify(reply),
          createdAt: now,
        }),
        db
          .update(conversations)
          .set({ updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(conversations.id, conversationId)),
      ]);
    } else {
      await db.batch([
        db.insert(conversations).values({
          id: conversationId,
          title: makeTitle(content),
          createdAt: now,
          updatedAt: now,
        }),
        db.insert(messages).values({
          id: userMessageId,
          conversationId,
          role: "user",
          content,
          createdAt: now,
        }),
        db.insert(messages).values({
          id: assistantMessageId,
          conversationId,
          role: "assistant",
          content: reply.summary,
          payload: JSON.stringify(reply),
          createdAt: now,
        }),
      ]);
    }

    return Response.json({
      conversation: {
        id: conversationId,
        title: makeTitle(content),
        createdAt: now,
        updatedAt: now,
      },
      userMessage: {
        id: userMessageId,
        conversationId,
        role: "user",
        content,
        reply: null,
        createdAt: now,
      },
      assistantMessage: {
        id: assistantMessageId,
        conversationId,
        role: "assistant",
        content: reply.summary,
        reply,
        createdAt: now,
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "生成妆容方案失败。" },
      { status: 500 },
    );
  }
}
