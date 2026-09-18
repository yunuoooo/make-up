import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import { conversations } from "@/db/schema";

export async function GET() {
  try {
    const rows = await getDb()
      .select()
      .from(conversations)
      .orderBy(desc(conversations.updatedAt))
      .limit(40);
    return Response.json({ conversations: rows });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "读取对话记录失败。" },
      { status: 500 },
    );
  }
}

export async function POST() {
  try {
    const id = crypto.randomUUID();
    const [conversation] = await getDb()
      .insert(conversations)
      .values({ id, title: "新对话" })
      .returning();
    return Response.json({ conversation }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "新建对话失败。" },
      { status: 500 },
    );
  }
}
