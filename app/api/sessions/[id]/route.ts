import { resolvePiStateDir } from "@/lib/pi/bridge";
import { deleteSession } from "@/lib/pi/session";

export const runtime = "nodejs";

/**
 * 删除一份服务端会话。界面删对话时同步调用——不删的话"删除对话"只是界面上的，
 * 磁盘上还留着完整上下文（spec `09-23-conversation-sessions.md` 第 4.6 节）。
 * 会话不按用户分区，单机单用户下的边界见同一节。
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await context.params;
  const deleted = await deleteSession(process.cwd(), id, resolvePiStateDir());

  if (!deleted) {
    return Response.json({ error: "没有找到这条服务端会话。" }, { status: 404 });
  }

  return Response.json({ ok: true });
}
