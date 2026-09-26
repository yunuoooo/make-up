export const runtime = "nodejs";

import { resolvePiStateDir } from "@/lib/pi/bridge";
import { findXhsReads, listXhsReads } from "@/lib/pi/session-reads";
import { isValidSessionId } from "@/lib/pi/session";

/**
 * 可观测性接口：把 agent 从**小红书**读到的东西原样读回来（见 `lib/pi/session-reads.ts`）。
 *
 * 数据源是 pi 的会话文件，不是另建的存储：工具返回的原始 payload 本来就存在那里，
 * 所以这个接口**不写任何东西**，也就能给出历史记录。
 *
 * - 不带参数：最近若干份会话的概要（不含 payload，免得为看一眼列表把字幕全传一遍）
 * - `?conversationId=…`：那一份会话的完整记录
 */
export async function GET(request: Request): Promise<Response> {
  const stateDir = resolvePiStateDir();
  const cwd = process.cwd();
  const conversationId = new URL(request.url).searchParams.get("conversationId")?.trim() ?? "";

  try {
    if (!conversationId) {
      return Response.json({ sessions: await listXhsReads(cwd, stateDir) });
    }
    // 会话 id 会参与拼路径，先按和聊天接口同一套规则判掉。
    if (!isValidSessionId(conversationId)) {
      return Response.json({ error: "会话标识无效。" }, { status: 400 });
    }
    const session = await findXhsReads(cwd, stateDir, conversationId);
    if (!session) {
      return Response.json({ error: "这份会话里没有小红书取数记录。" }, { status: 404 });
    }
    return Response.json({ session });
  } catch {
    // 会话目录不可读、文件坏掉等等：这是只读的排查工具，报一句人话就够了，不要 500 堆栈。
    return Response.json({ error: "读取会话文件失败。" }, { status: 500 });
  }
}
