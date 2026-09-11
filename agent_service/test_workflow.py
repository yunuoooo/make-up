import asyncio
import unittest
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import patch

from agents.tool_context import ToolContext

from agent_service.config import AgentSettings
from agent_service.looktrace_agent import create_looktrace_agent
from agent_service.schemas import (
    RunContext,
    XhsPost,
    XhsSearchResult,
)
from agent_service.workflow import LooktraceWorkflow


class FakeXhsEvidence:
    mode = "mcp"
    connected = True
    logged_in = True
    last_error_code = None

    async def search(self, _query: str) -> XhsSearchResult:
        return XhsSearchResult(
            status="succeeded",
            mode="mcp",
            posts=[
                XhsPost(
                    post_id="feed_1",
                    title="低饱和通勤妆",
                    text="薄透底妆，灰棕眉眼，豆沙唇。",
                    source_url="https://www.xiaohongshu.com/explore/feed_1",
                )
            ],
        )


class FakeSpan:
    def __init__(self) -> None:
        self.span_data = SimpleNamespace(data={})

    def __enter__(self):
        return self

    def __exit__(self, *_exc_info: object) -> None:
        return None


class FakeStream:
    def __init__(self, context, *, xhs_mode: str = "mcp") -> None:
        context.xhs_result = XhsSearchResult(
            status="succeeded",
            mode=xhs_mode,
            posts=[
                XhsPost(
                    post_id="feed_1",
                    title="低饱和通勤妆",
                    text="薄透底妆，灰棕眉眼，豆沙唇。",
                    source_url="https://www.xiaohongshu.com/explore/feed_1",
                )
            ],
        )
        self.final_output = "可以使用薄透底妆、灰棕眉眼和豆沙唇。"
        self.is_complete = False
        self.cancelled = False

    async def stream_events(self):
        yield SimpleNamespace(
            type="run_item_stream_event",
            name="tool_called",
            item=SimpleNamespace(
                type="tool_call_item",
                raw_item=SimpleNamespace(
                    name="search_xhs_evidence",
                    call_id="call_1",
                    arguments='{"query":"低饱和通勤妆"}',
                ),
            ),
        )
        yield SimpleNamespace(
            type="run_item_stream_event",
            name="tool_output",
            item=SimpleNamespace(
                type="tool_call_output_item",
                raw_item=SimpleNamespace(call_id="call_1"),
                output={"status": "succeeded"},
            ),
        )
        yield SimpleNamespace(
            type="raw_response_event",
            data=SimpleNamespace(
                type="response.output_text.delta",
                delta="可以使用薄透底妆",
            ),
        )
        self.is_complete = True

    def cancel(self) -> None:
        self.cancelled = True


class FakeRunner:
    kwargs = None

    @classmethod
    def run_streamed(cls, _agent, _message, **kwargs):
        cls.kwargs = kwargs
        return FakeStream(kwargs["context"])


class MockModeRunner(FakeRunner):
    @classmethod
    def run_streamed(cls, _agent, _message, **kwargs):
        cls.kwargs = kwargs
        return FakeStream(kwargs["context"], xhs_mode="mock")


class CancelledStream:
    final_output = None
    is_complete = False

    def __init__(self) -> None:
        self.cancelled = False

    async def stream_events(self):
        if False:
            yield None
        raise asyncio.CancelledError()

    def cancel(self) -> None:
        self.cancelled = True


class CancelledRunner:
    stream = CancelledStream()

    @classmethod
    def run_streamed(cls, _agent, _message, **_kwargs):
        return cls.stream


class FailingRunner:
    @classmethod
    def run_streamed(cls, _agent, _message, **_kwargs):
        raise RuntimeError("provider request failed")


class AgentDefinitionTests(unittest.TestCase):
    def test_agent_definition_contains_only_agent_concerns(self):
        agent = create_looktrace_agent(
            AgentSettings(model_api_key="test-deepseek-key"),
            FakeXhsEvidence(),
        )

        self.assertEqual(agent.name, "Looktrace")
        self.assertEqual([tool.name for tool in agent.tools], ["search_xhs_evidence"])
        self.assertEqual(agent.mcp_servers, [])
        self.assertIsNone(agent.output_type)
        self.assertIn("最终只输出给用户阅读的自然语言回答", agent.instructions)
        self.assertNotIn("结构化输出", agent.instructions)

    def test_settings_default_to_deepseek_and_use_mcp_by_default(self):
        with patch.dict(
            "os.environ",
            {
                "DEEPSEEK_API_KEY": "deepseek-key",
                "OPENAI_TRACING_API_KEY": "tracing-key",
            },
            clear=True,
        ):
            settings = AgentSettings.from_env()

        self.assertEqual(settings.provider, "deepseek")
        self.assertEqual(settings.model, "deepseek-chat")
        self.assertEqual(settings.model_api_key, "deepseek-key")
        self.assertEqual(settings.tracing_api_key, "tracing-key")
        self.assertEqual(settings.xhs.mode, "mcp")

    def test_xhs_tool_records_only_safe_operational_span_data(self):
        span = FakeSpan()
        context = RunContext(
            user_id="user_a",
            conversation_id="conv_1",
            message_id="msg_1",
            agent_run_id="run_1",
            trace_id="trace_1",
        )
        agent = create_looktrace_agent(
            AgentSettings(model_api_key="test-deepseek-key"),
            FakeXhsEvidence(),
        )
        tool_context = ToolContext(
            context=context,
            tool_name="search_xhs_evidence",
            tool_call_id="call_1",
            tool_arguments='{"query":"低饱和通勤妆"}',
        )

        with patch("agent_service.looktrace_agent.custom_span", return_value=span):
            asyncio.run(
                agent.tools[0].on_invoke_tool(
                    tool_context,
                    '{"query":"低饱和通勤妆"}',
                )
            )

        self.assertEqual(
            span.span_data.data,
            {
                "query_length": 6,
                "status": "succeeded",
                "post_count": 1,
                "detail_failure_count": 0,
                "truncated": False,
            },
        )
        self.assertNotIn("低饱和通勤妆", str(span.span_data.data))


class WorkflowTests(unittest.TestCase):
    def test_workflow_exposes_the_full_run_as_stable_application_events(self):
        settings = AgentSettings(
            model_api_key="test-deepseek-key",
            tracing_api_key="test-openai-key",
            trace_include_sensitive_data=True,
            max_turns=4,
            timeout_seconds=10,
        )
        workflow = LooktraceWorkflow(
            settings=settings,
            xhs=FakeXhsEvidence(),
            runner=FakeRunner,
            agent=object(),
        )

        with patch(
            "agent_service.workflow.trace",
            return_value=nullcontext(),
        ) as trace_mock:
            events = asyncio.run(
                workflow.run(
                    message="帮我找低饱和通勤妆",
                    user_id="user_a",
                    conversation_id="conv_1",
                )
            )

        self.assertEqual(
            [event.event for event in events],
            [
                "run_started",
                "status",
                "tool_started",
                "tool_finished",
                "text_delta",
                "result",
            ],
        )
        result = events[-1].data
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["answer"]["sources"][0]["id"], "feed_1")

        run_config = FakeRunner.kwargs["run_config"]
        self.assertTrue(run_config.trace_include_sensitive_data)
        self.assertEqual(
            run_config.tracing,
            {"api_key": settings.tracing_api_key},
        )
        trace_mock.assert_called_once_with(
            workflow_name="looktrace.phase1",
            trace_id=events[0].data["run"]["traceId"],
            group_id="conv_1",
            metadata=run_config.trace_metadata,
            tracing={"api_key": settings.tracing_api_key},
        )
        self.assertNotIn("session", FakeRunner.kwargs)
        self.assertNotIn(
            "帮我找低饱和通勤妆",
            str(run_config.trace_metadata),
        )

    def test_cancelled_run_stops_the_sdk_stream_and_has_one_terminal_result(self):
        workflow = LooktraceWorkflow(
            settings=AgentSettings(),
            xhs=FakeXhsEvidence(),
            runner=CancelledRunner,
            agent=object(),
        )

        with patch("agent_service.workflow.trace", return_value=nullcontext()):
            events = asyncio.run(
                workflow.run(
                    message="通勤妆",
                    user_id="user_a",
                    conversation_id="conv_1",
                )
            )

        self.assertTrue(CancelledRunner.stream.cancelled)
        results = [event for event in events if event.event == "result"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].data["status"], "cancelled")

    def test_mock_evidence_is_never_reported_as_real_success(self):
        workflow = LooktraceWorkflow(
            settings=AgentSettings(),
            xhs=FakeXhsEvidence(),
            runner=MockModeRunner,
            agent=object(),
        )

        with patch("agent_service.workflow.trace", return_value=nullcontext()):
            events = asyncio.run(
                workflow.run(
                    message="通勤妆",
                    user_id="user_a",
                    conversation_id="conv_1",
                )
            )

        self.assertEqual(events[-1].data["status"], "degraded")
        self.assertIn("模拟", events[-1].data["answer"]["uncertainty"][-1])

    def test_failed_run_logs_safe_correlation_fields(self):
        settings = AgentSettings(
            model_api_key="deepseek-secret",
            tracing_api_key="openai-secret",
        )
        workflow = LooktraceWorkflow(
            settings=settings,
            xhs=FakeXhsEvidence(),
            runner=FailingRunner,
            agent=object(),
        )

        with (
            patch("agent_service.workflow.trace", return_value=nullcontext()),
            patch("agent_service.workflow.logger.exception") as log_exception,
        ):
            events = asyncio.run(
                workflow.run(
                    message="不要记录这段用户正文",
                    user_id="user_a",
                    conversation_id="conv_1",
                )
            )

        self.assertEqual(events[-1].data["status"], "failed")
        log_exception.assert_called_once()
        log_extra = log_exception.call_args.kwargs["extra"]
        self.assertEqual(log_extra["provider"], "deepseek")
        self.assertEqual(log_extra["model"], "deepseek-chat")
        self.assertEqual(log_extra["conversation_id"], "conv_1")
        self.assertEqual(log_extra["agent_run_id"], events[0].data["run"]["agentRunId"])
        self.assertEqual(log_extra["trace_id"], events[0].data["run"]["traceId"])
        self.assertNotIn("不要记录这段用户正文", str(log_exception.call_args))
        self.assertNotIn("deepseek-secret", str(log_exception.call_args))
        self.assertNotIn("openai-secret", str(log_exception.call_args))


if __name__ == "__main__":
    unittest.main()
