from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class XhsComment(BaseModel):
    author_name: str = ""
    text: str


class XhsPost(BaseModel):
    post_id: str
    title: str = ""
    author_name: str = ""
    text: str = ""
    tags: list[str] = Field(default_factory=list)
    comments: list[XhsComment] = Field(default_factory=list)
    source_url: str | None = None


class XhsSearchResult(BaseModel):
    status: Literal["succeeded", "degraded", "failed"]
    mode: Literal["mcp", "mock"] | None = None
    posts: list[XhsPost] = Field(default_factory=list)
    error_code: str | None = None
    message: str | None = None
    detail_failure_count: int = 0
    truncated: bool = False


class Phase1AgentOutput(BaseModel):
    answer_text: str
    uncertainty: list[str] = Field(default_factory=list)


class SourceReference(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    title: str = ""
    summary: str = ""
    status: Literal["succeeded", "degraded", "failed"] = "succeeded"
    source_url: str | None = None


class AgentAnswer(BaseModel):
    model_config = ConfigDict(extra="ignore")

    schema_version: Literal["looktrace.answer.v1"] = "looktrace.answer.v1"
    status: Literal["succeeded", "degraded", "failed", "cancelled"]
    answer_text: str
    sources: list[SourceReference] = Field(default_factory=list)
    uncertainty: list[str] = Field(default_factory=list)


@dataclass
class RunContext:
    user_id: str
    conversation_id: str
    message_id: str
    agent_run_id: str
    trace_id: str
    xhs_result: XhsSearchResult | None = None

    def run_metadata(self) -> dict[str, str]:
        return {
            "traceId": self.trace_id,
            "agentRunId": self.agent_run_id,
            "conversationId": self.conversation_id,
            "messageId": self.message_id,
        }
