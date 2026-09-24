import test from "node:test";
import assert from "node:assert/strict";
import {
  activeConversationCount,
  isConversationActive,
  releaseConversation,
  tryAcquireConversation
} from "../../lib/pi/conversation-lock.ts";

test("lets only one round run per conversation at a time", () => {
  const first = "conversation_lock_test_a";
  const second = "conversation_lock_test_b";

  assert.equal(tryAcquireConversation(first), true);
  // 第二次请求要么排队要么被拒：放进去就会有两个 pi 进程写同一份会话文件。
  assert.equal(tryAcquireConversation(first), false);
  assert.equal(isConversationActive(first), true);

  // 别的会话不受影响：并行开新对话是正常的。
  assert.equal(tryAcquireConversation(second), true);
  assert.equal(activeConversationCount(), 2);

  releaseConversation(first);
  assert.equal(isConversationActive(first), false);
  assert.equal(tryAcquireConversation(first), true, "上一轮结束后可以继续追问");

  // 幂等：正常收尾和请求中断都会各调一次，不能把别人的锁放掉。
  releaseConversation(first);
  releaseConversation(first);
  assert.equal(isConversationActive(second), true);

  releaseConversation(first);
  releaseConversation(second);
  assert.equal(activeConversationCount(), 0);
});
