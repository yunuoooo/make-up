from __future__ import annotations

from typing import Protocol

from agents import Agent, RunContextWrapper, custom_span
from agents.decorators import tool

from .config import AgentSettings
from .model_provider import create_model
from .prompts import AGENT_SYSTEM_PROMPT
from .schemas import RunContext, XhsSearchResult


class XhsEvidenceSource(Protocol):
    async def search(self, query: str) -> XhsSearchResult: ...


def create_looktrace_agent(
    settings: AgentSettings,
    xhs: XhsEvidenceSource,
) -> Agent[RunContext]:
    @tool(name_override="search_xhs_evidence")
    async def search_xhs_evidence(
        ctx: RunContextWrapper[RunContext],
        query: str,
    ) -> dict:
        """Search read-only Xiaohongshu posts and comments for makeup evidence."""
        with custom_span("xhs_mcp.search") as span:
            result = await xhs.search(query)
            span.span_data.data.update(
                {
                    "query_length": len(query),
                    "status": result.status,
                    "post_count": len(result.posts),
                    "detail_failure_count": result.detail_failure_count,
                    "truncated": result.truncated,
                }
            )
        ctx.context.xhs_result = result
        return result.model_dump(mode="json")

    return Agent(
        name="Looktrace",
        instructions=AGENT_SYSTEM_PROMPT,
        model=create_model(settings),
        tools=[search_xhs_evidence],
    )
