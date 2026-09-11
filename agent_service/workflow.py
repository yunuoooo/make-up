from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, AsyncIterator

from agents import Agent, RunConfig, Runner, gen_trace_id, trace

from .config import AgentSettings
from .events import WorkflowEvent, map_sdk_event
from .looktrace_agent import XhsEvidenceSource, create_looktrace_agent
from .schemas import AgentAnswer, Phase1AgentOutput, RunContext, SourceReference


logger = logging.getLogger(__name__)


class LooktraceWorkflow:
    def __init__(
        self,
        settings: AgentSettings,
        xhs: XhsEvidenceSource,
        *,
        runner: type[Runner] = Runner,
        agent: Agent[RunContext] | None = None,
    ) -> None:
        self.settings = settings
        self.xhs = xhs
        self.runner = runner
        self.agent = agent or create_looktrace_agent(settings, xhs)

    async def stream(
        self,
        *,
        message: str,
        user_id: str,
        conversation_id: str | None = None,
    ) -> AsyncIterator[WorkflowEvent]:
        context = RunContext(
            user_id=user_id,
            conversation_id=conversation_id or _id("conv"),
            message_id=_id("msg"),
            agent_run_id=_id("run"),
            trace_id=gen_trace_id(),
        )
        run = context.run_metadata()
        yield WorkflowEvent(
            "run_started",
            {"run": run, "conversation": {"id": context.conversation_id}},
        )
        yield WorkflowEvent(
            "status",
            {"phase": "model", "message": "正在理解你的需求"},
        )

        stream = None
        safe_metadata = {
            "user_id": user_id,
            "conversation_id": context.conversation_id,
            "message_id": context.message_id,
            "agent_run_id": context.agent_run_id,
            "xhs_mode": getattr(self.xhs, "mode", "unknown"),
        }
        try:
            with trace(
                workflow_name="looktrace.phase1",
                trace_id=context.trace_id,
                group_id=context.conversation_id,
                metadata=safe_metadata,
                tracing={"api_key": self.settings.tracing_api_key},
            ):
                stream = self.runner.run_streamed(
                    self.agent,
                    message,
                    context=context,
                    max_turns=self.settings.max_turns,
                    run_config=RunConfig(
                        workflow_name="looktrace.phase1",
                        trace_id=context.trace_id,
                        group_id=context.conversation_id,
                        trace_metadata=safe_metadata,
                        trace_include_sensitive_data=(
                            self.settings.trace_include_sensitive_data
                        ),
                        tracing={"api_key": self.settings.tracing_api_key},
                    ),
                )
                tool_names: dict[str, str] = {}
                async with asyncio.timeout(self.settings.timeout_seconds):
                    async for sdk_event in stream.stream_events():
                        event = map_sdk_event(sdk_event, context, tool_names)
                        if event is not None:
                            yield event

            output = stream.final_output
            if not isinstance(output, str) or not output.strip():
                raise ValueError("Agent returned an invalid Phase 1 output")
            answer = _build_answer(
                Phase1AgentOutput(answer_text=output.strip(), uncertainty=[]),
                context,
            )
            yield WorkflowEvent("result", _result_data(answer, run))
        except asyncio.CancelledError:
            _cancel_stream(stream)
            answer = AgentAnswer(
                status="cancelled",
                answer_text="本次运行已取消。",
                uncertainty=["RUN_CANCELLED"],
            )
            yield WorkflowEvent("result", _result_data(answer, run))
            return
        except TimeoutError:
            _cancel_stream(stream)
            yield WorkflowEvent(
                "error",
                {"code": "RUNTIME_TIMEOUT", "message": "本次运行超时，请稍后重试。"},
            )
            answer = AgentAnswer(
                status="failed",
                answer_text="本次运行超时，请稍后重试。",
                uncertainty=["RUNTIME_TIMEOUT"],
            )
            yield WorkflowEvent("result", _result_data(answer, run))
        except Exception:
            _cancel_stream(stream)
            logger.exception(
                "Agent run failed",
                extra={
                    "provider": self.settings.provider,
                    "model": self.settings.model,
                    "conversation_id": context.conversation_id,
                    "agent_run_id": context.agent_run_id,
                    "trace_id": context.trace_id,
                },
            )
            yield WorkflowEvent(
                "error",
                {"code": "AGENT_RUN_FAILED", "message": "本次运行未能完成，请稍后重试。"},
            )
            answer = AgentAnswer(
                status="failed",
                answer_text="本次运行未能完成，请稍后重试。",
                uncertainty=["AGENT_RUN_FAILED"],
            )
            yield WorkflowEvent("result", _result_data(answer, run))

    async def run(
        self,
        *,
        message: str,
        user_id: str,
        conversation_id: str | None = None,
    ) -> list[WorkflowEvent]:
        return [
            event
            async for event in self.stream(
                message=message,
                user_id=user_id,
                conversation_id=conversation_id,
            )
        ]

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "service": "agent-runtime",
            "model": self.settings.model,
            "tracing": "openai",
            "xhs": {
                "mode": getattr(self.xhs, "mode", self.settings.xhs.mode),
                "connected": getattr(self.xhs, "connected", False),
                "loggedIn": getattr(self.xhs, "logged_in", None),
                "lastErrorCode": getattr(self.xhs, "last_error_code", None),
            },
        }


def _build_answer(output: Phase1AgentOutput, context: RunContext) -> AgentAnswer:
    result = context.xhs_result
    sources = []
    if result:
        sources = [
            SourceReference(
                id=post.post_id,
                title=post.title,
                summary=post.text[:240],
                status="succeeded" if result.mode == "mcp" else "degraded",
                source_url=post.source_url,
            )
            for post in result.posts
        ]
    status = "succeeded"
    uncertainty = list(output.uncertainty)
    if result and (result.status != "succeeded" or result.mode == "mock"):
        status = "degraded"
    if result and result.error_code:
        uncertainty.append(result.error_code)
    if result and result.mode == "mock":
        uncertainty.append("当前使用本地模拟小红书内容，不代表真实来源。")
    return AgentAnswer(
        status=status,
        answer_text=output.answer_text,
        sources=sources,
        uncertainty=list(dict.fromkeys(uncertainty)),
    )


def _result_data(answer: AgentAnswer, run: dict[str, str]) -> dict[str, Any]:
    return {
        "answer": answer.model_dump(mode="json"),
        "answerText": answer.answer_text,
        "status": answer.status,
        "run": run,
    }


def _cancel_stream(stream: Any) -> None:
    if stream is not None and not getattr(stream, "is_complete", True):
        stream.cancel()


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"
