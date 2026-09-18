import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { conversations, messages } from "@/db/schema";
import type { AdvisorReply } from "@/lib/makeup-types";

function parseReply(payload: string | null): AdvisorReply | null {
  if (!payload) return null;
  try {
    return JSON.parse(payload) as AdvisorReply;
  } catch {
    return null;
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const db = getDb();
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);

    if (!conversation) {
      return Response.json({ error: "对话不存在。" }, { status: 404 });
    }

    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.createdAt));

    return Response.json({
      conversation,
      messages: rows.map((message) => ({
        ...message,
        reply: parseReply(message.payload),
      })),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "读取对话失败。" },
      { status: 500 },
    );
  }
}
