/**
 * 同一会话同时只允许一个 pi 进程。
 *
 * 两个进程拿同一个 session id 跑起来，会各自从同一份 JSONL 读叶子、再各自追加，
 * 后写的那个把前一个的结果盖成孤儿分支——用户看到的是「回答丢了」。
 * 前端 `isSendingRef` 只挡得住同一个标签页，两个标签页或两个浏览器就绕过去了。
 *
 * 这是进程内锁，够单实例部署用；多实例部署需要外部锁（spec 09-23 第 4.4 节）。
 */
const active = new Set<string>();

export function tryAcquireConversation(conversationId: string): boolean {
  if (active.has(conversationId)) return false;
  active.add(conversationId);
  return true;
}

/** 幂等：正常收尾和请求中断都会调一次，重复调用不该把别人的锁放掉。 */
export function releaseConversation(conversationId: string): void {
  active.delete(conversationId);
}

export function isConversationActive(conversationId: string): boolean {
  return active.has(conversationId);
}

export function activeConversationCount(): number {
  return active.size;
}
