from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict

from .prompts import prompt_metadata


def _agent_trace_id() -> str:
    return "trace_" + uuid.uuid4().hex


def _id(prefix: str) -> str:
    return "%s_%s" % (prefix, uuid.uuid4().hex)


@dataclass
class RuntimeContext:
    """Server-owned context injected into SDK tools.

    Models can request tools, but they never receive credentials or choose the
    user/conversation scope represented here.
    """

    user_id: str
    conversation_id: str
    message_id: str
    trace_id: str
    agent_run_id: str
    started_at: str
    max_turns: int = 6
    timeout_seconds: float = 30.0
    tool_budget: Dict[str, int] = field(default_factory=dict)

    @classmethod
    def create(
        cls,
        user_id: str,
        conversation_id: str,
        max_turns: int = 6,
        timeout_seconds: float = 30.0,
        tool_budget: Dict[str, int] | None = None,
    ) -> "RuntimeContext":
        return cls(
            user_id=user_id,
            conversation_id=conversation_id,
            message_id=_id("msg"),
            trace_id=_agent_trace_id(),
            agent_run_id=_id("run"),
            started_at=datetime.now(timezone.utc).isoformat(),
            max_turns=max_turns,
            timeout_seconds=timeout_seconds,
            tool_budget=dict(tool_budget or {}),
        )

    @property
    def session_key(self) -> str:
        return "%s:%s" % (self.user_id, self.conversation_id)

    @property
    def langfuse_trace_id(self) -> str:
        return self.trace_id.removeprefix("trace_")

    def as_run(self) -> Dict[str, Any]:
        return {
            "userId": self.user_id,
            "conversationId": self.conversation_id,
            "messageId": self.message_id,
            "traceId": self.trace_id,
            "langfuseTraceId": self.langfuse_trace_id,
            "agentRunId": self.agent_run_id,
            "startedAt": self.started_at,
            "maxTurns": self.max_turns,
            "timeoutMs": int(self.timeout_seconds * 1000),
        }

    def trace_metadata(self, _input_text: str = "") -> Dict[str, Any]:
        return {
            "userId": self.user_id,
            "conversationId": self.conversation_id,
            "messageId": self.message_id,
            "agentRunId": self.agent_run_id,
            "schemaVersion": "looktrace.answer.v1",
            **prompt_metadata(),
        }
