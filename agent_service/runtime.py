from __future__ import annotations

import asyncio
import json
import os
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable, Dict, List, Optional

from .audit import record_runtime
from .context import RuntimeContext
from .guardrails import GuardrailDecision, validate_input, validate_output, validate_tool_result
from .observability import langfuse_observability
from .prompts import AGENT_SYSTEM_PROMPT
from .schemas import AgentAnswer, SourceReference
from .sessions import SQLiteSessionStore
from .tools import get_user_products, match_user_products, save_evidence, save_tool_run, search_taobao_offers, search_xhs_evidence


class RuntimeLimitError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass
class RuntimeConfig:
    max_turns: int = 6
    timeout_seconds: float = 30.0
    model: str = "deepseek-chat"
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    provider: str = "deepseek"
    use_live_model: bool = True
    session_db_path: str = ".local-data/agent-sessions.sqlite"
    session_max_items: int = 32
    max_tool_calls: int = 12

    @classmethod
    def from_env(cls) -> "RuntimeConfig":
        provider = (os.getenv("AGENT_MODEL_PROVIDER") or "openai").lower()
        use_live = os.getenv("AGENT_USE_LIVE_MODEL", "1") != "0"
        if provider == "deepseek":
            return cls(
                max_turns=int(os.getenv("AGENT_MAX_TURNS", "6")),
                timeout_seconds=float(os.getenv("AGENT_TIMEOUT_SECONDS", "30")),
                model=os.getenv("AGENT_MODEL", "deepseek-chat"),
                api_key=os.getenv("DEEPSEEK_API_KEY") or os.getenv("OPENAI_API_KEY"),
                base_url=os.getenv("AGENT_MODEL_BASE_URL", "https://api.deepseek.com"),
                provider=provider,
                use_live_model=use_live,
                session_db_path=os.getenv("AGENT_SESSION_DB_PATH", ".local-data/agent-sessions.sqlite"),
                session_max_items=int(os.getenv("AGENT_SESSION_MAX_ITEMS", "32")),
                max_tool_calls=int(os.getenv("AGENT_MAX_TOOL_CALLS", "12")),
            )
        return cls(
            max_turns=int(os.getenv("AGENT_MAX_TURNS", "6")),
            timeout_seconds=float(os.getenv("AGENT_TIMEOUT_SECONDS", "30")),
            model=os.getenv("AGENT_MODEL", "gpt-4o-mini"),
            api_key=os.getenv("OPENAI_API_KEY"),
            base_url=os.getenv("AGENT_MODEL_BASE_URL") or None,
            provider="openai",
            use_live_model=use_live,
            session_db_path=os.getenv("AGENT_SESSION_DB_PATH", ".local-data/agent-sessions.sqlite"),
            session_max_items=int(os.getenv("AGENT_SESSION_MAX_ITEMS", "32")),
            max_tool_calls=int(os.getenv("AGENT_MAX_TOOL_CALLS", "12")),
        )


def _id(prefix: str) -> str:
    return "%s_%s" % (prefix, uuid.uuid4().hex)


def _summary(value: Any, limit: int = 240) -> str:
    if isinstance(value, str):
        text = value
    else:
        text = json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":"))
    return text[:limit]


def _failure_answer(message: str, status: str = "failed", code: Optional[str] = None) -> AgentAnswer:
    uncertainty = [message]
    if code:
        uncertainty.insert(0, code)
    return AgentAnswer(status=status, answer_text=message, sources=[], uncertainty=uncertainty)


def _field(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def _last_answer_object(text: str) -> Dict[str, Any]:
    """Find the last complete answer object in provider prose or fenced JSON."""
    decoder = json.JSONDecoder()
    candidates: List[Dict[str, Any]] = []
    for index, character in enumerate(text):
        if character != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and (
            "answer_text" in value or "schema_version" in value
        ):
            candidates.append(value)
    if not candidates:
        raise ValueError("Agent output is not a looktrace.answer.v1 object")
    return candidates[-1]


def _coerce_answer(value: Any) -> AgentAnswer:
    if isinstance(value, AgentAnswer):
        return value
    if isinstance(value, str):
        text = value.strip()
        value = _last_answer_object(text)
    if isinstance(value, dict):
        normalized = dict(value)
        normalized["schema_version"] = "looktrace.answer.v1"
        status_map = {
            "ok": "succeeded",
            "success": "succeeded",
            "completed": "succeeded",
            "clarify": "clarification",
        }
        normalized["status"] = status_map.get(normalized.get("status"), normalized.get("status", "degraded"))
        uncertainty = normalized.get("uncertainty")
        normalized["uncertainty"] = uncertainty if isinstance(uncertainty, list) else ([] if uncertainty in (None, 0.0) else [str(uncertainty)])
        tool_run_ids = normalized.get("tool_run_ids")
        normalized["tool_run_ids"] = tool_run_ids if isinstance(tool_run_ids, list) else []
        normalized["look_features"] = normalized.get("look_features") if isinstance(normalized.get("look_features"), dict) else {}
        source_items = []
        for index, source in enumerate(normalized.get("sources") or []):
            if not isinstance(source, dict):
                continue
            source_items.append({
                "id": source.get("id") or "source_%s" % index,
                "title": source.get("title") or source.get("name") or "模型来源",
                "summary": source.get("summary") or source.get("description") or "",
                "status": source.get("status") if source.get("status") in {"succeeded", "degraded", "failed"} else "degraded",
                "source_url": source.get("source_url") or source.get("url"),
            })
        normalized["sources"] = source_items
        candidates = []
        for index, candidate in enumerate(normalized.get("sku_candidates") or []):
            if not isinstance(candidate, dict):
                continue
            candidates.append({
                "id": candidate.get("id") or "sku_%s" % index,
                "name": candidate.get("name") or candidate.get("note") or "未命名候选",
                "category": candidate.get("category") or candidate.get("source") or "未分类",
                "status": candidate.get("status") if candidate.get("status") in {"live", "placeholder", "unavailable"} else "placeholder",
                "reason": candidate.get("reason") or candidate.get("note") or "模型候选",
                "price": candidate.get("price"),
                "channel": candidate.get("channel"),
                "purchase_url": candidate.get("purchase_url"),
            })
        normalized["sku_candidates"] = candidates
        owned = normalized.get("owned_product_match")
        if not isinstance(owned, dict):
            owned = {}
        normalized["owned_product_match"] = {
            "reviewed": bool(owned.get("reviewed", owned.get("matched", False))),
            "usable_items": owned.get("usable_items", owned.get("products", [])) or [],
            "partial_matches": owned.get("partial_matches", []) or [],
            "not_suitable": owned.get("not_suitable", []) or [],
            "missing_capabilities": owned.get("missing_capabilities", []) or [],
        }
        if normalized.get("status") == "succeeded" and not normalized["sources"]:
            normalized["status"] = "degraded"
            normalized["uncertainty"].append("当前 provider 没有返回可验证来源，结果仅作参考。")
        return AgentAnswer.model_validate(normalized)
    raise ValueError("Agent output is not a looktrace.answer.v1 object")


class RuntimeEngine:
    """The only Agent execution entry point for the application."""

    def __init__(
        self,
        config: Optional[RuntimeConfig] = None,
        runner: Any = None,
        agent_factory: Optional[Callable[[RuntimeContext], Any]] = None,
        session_store: Optional[SQLiteSessionStore] = None,
    ):
        self.config = config or RuntimeConfig.from_env()
        if runner is None:
            from agents import Runner

            runner = Runner
        self.runner = runner
        self.agent_factory = agent_factory
        self.sessions = session_store or SQLiteSessionStore(
            self.config.session_db_path,
            max_items=self.config.session_max_items,
        )

    def _create_agent(self, context: RuntimeContext) -> Any:
        if self.agent_factory is not None:
            return self.agent_factory(context)
        from agents import Agent, AgentOutputSchema, GuardrailFunctionOutput, InputGuardrail, OutputGuardrail

        async def input_guardrail(_ctx: Any, _agent: Any, value: Any) -> GuardrailFunctionOutput:
            decision = validate_input(value if isinstance(value, str) else _summary(value))
            return GuardrailFunctionOutput(
                output_info={"code": decision.code, "message": decision.message},
                tripwire_triggered=not decision.allowed,
            )

        async def output_guardrail(_ctx: Any, _agent: Any, value: Any) -> GuardrailFunctionOutput:
            try:
                answer = _coerce_answer(value)
                decision = validate_output(answer)
            except Exception:
                decision = GuardrailDecision(False, "OUTPUT_SCHEMA_INVALID", "模型结果不符合业务结构。")
            return GuardrailFunctionOutput(
                output_info={"code": decision.code, "message": decision.message},
                tripwire_triggered=not decision.allowed,
            )

        model: Any = None
        if self.config.api_key:
            from agents import OpenAIChatCompletionsModel
            from openai import AsyncOpenAI

            client = AsyncOpenAI(api_key=self.config.api_key, base_url=self.config.base_url)
            model = OpenAIChatCompletionsModel(model=self.config.model, openai_client=client)

        structured_output = AgentOutputSchema(AgentAnswer, strict_json_schema=False) if self.config.provider == "openai" else None
        output_guardrails = [OutputGuardrail(output_guardrail, name="answer-policy")] if structured_output is not None else []
        return Agent(
            name="Looktrace Agent",
            instructions=AGENT_SYSTEM_PROMPT,
            model=model,
            tools=[search_xhs_evidence, get_user_products, match_user_products, search_taobao_offers, save_evidence, save_tool_run],
            output_type=structured_output,
            input_guardrails=[InputGuardrail(input_guardrail, name="input-policy")],
            output_guardrails=output_guardrails,
        )

    @staticmethod
    def _tool_name(item: Any) -> str:
        raw = _field(item, "raw_item", item)
        return str(_field(raw, "name") or _field(raw, "function") or _field(raw, "tool_name") or "unknown_tool")

    @staticmethod
    def _call_id(item: Any) -> str:
        raw = _field(item, "raw_item", item)
        return str(_field(raw, "call_id") or _field(raw, "id") or _id("call"))

    @staticmethod
    def _tool_input(item: Any) -> Any:
        raw = _field(item, "raw_item", item)
        return _field(raw, "arguments") or _field(raw, "input") or {}

    async def _stream_live(self, message: str, context: RuntimeContext) -> AsyncIterator[Dict[str, Any]]:
        from agents import RunConfig

        agent = self._create_agent(context)
        session = self.sessions.for_conversation(context.user_id, context.conversation_id)
        run_config = RunConfig(
            workflow_name="looktrace.chat.turn",
            trace_id=context.trace_id,
            group_id=context.conversation_id,
            trace_metadata=context.trace_metadata(message),
            trace_include_sensitive_data=langfuse_observability.include_sensitive_data,
            tracing_disabled=not langfuse_observability.enabled,
        )
        stream = self.runner.run_streamed(
            agent,
            message,
            context=context,
            max_turns=context.max_turns,
            run_config=run_config,
            session=session,
        )
        iterator = stream.stream_events().__aiter__()
        deadline = asyncio.get_event_loop().time() + context.timeout_seconds
        tool_names: Dict[str, str] = {}
        seen_tool_calls = set()
        tool_call_count = 0
        try:
            while True:
                remaining = deadline - asyncio.get_event_loop().time()
                if remaining <= 0:
                    raise asyncio.TimeoutError()
                try:
                    sdk_event = await asyncio.wait_for(iterator.__anext__(), timeout=remaining)
                except StopAsyncIteration:
                    break
                event_type = getattr(sdk_event, "type", "")
                if event_type == "raw_response_event":
                    delta = getattr(getattr(sdk_event, "data", None), "delta", None)
                    if delta:
                        yield {"event": "text_delta", "data": {"text": str(delta)}}
                elif event_type == "run_item_stream_event":
                    item = getattr(sdk_event, "item", None)
                    name = getattr(sdk_event, "name", "")
                    if name == "tool_called":
                        call_id = self._call_id(item)
                        tool_name = self._tool_name(item)
                        input_summary = _summary(self._tool_input(item))
                        signature = (tool_name, input_summary)
                        if tool_call_count >= self.config.max_tool_calls:
                            raise RuntimeLimitError("TOOL_CALL_LIMIT")
                        if signature in seen_tool_calls:
                            raise RuntimeLimitError("TOOL_CALL_DUPLICATE")
                        tool_call_count += 1
                        seen_tool_calls.add(signature)
                        tool_names[call_id] = tool_name
                        yield {"event": "tool_started", "data": {"toolName": tool_name, "callId": call_id, "inputSummary": input_summary}}
                    elif name == "tool_output":
                        output = getattr(item, "output", None)
                        call_id = self._call_id(item)
                        tool_name = tool_names.get(call_id, self._tool_name(item))
                        decision = validate_tool_result(tool_name, output, context.user_id)
                        yield {"event": "tool_finished", "data": {"toolName": tool_name, "callId": call_id, "status": "succeeded" if decision.allowed else "failed", "outputSummary": _summary(output), "errorCode": decision.code}}
        finally:
            if not getattr(stream, "is_complete", True):
                cancel = getattr(stream, "cancel", None)
                if callable(cancel):
                    cancel()
        final_output = getattr(stream, "final_output", None)
        if final_output is None:
            raise RuntimeError("Agent streamed run ended without a final output")
        yield {"event": "_final_output", "data": {"value": final_output}}

    def _local_answer(self, message: str) -> AgentAnswer:
        return AgentAnswer(
            status="degraded",
            answer_text="我理解你的问题是：%s（当前使用离线降级模式，未调用外部模型。）" % message,
            sources=[SourceReference(id="local_mock", title="本地降级模式", summary="未调用外部来源", status="degraded")],
            uncertainty=["模型服务未启用，结果仅用于本地联调。"],
        )

    @contextmanager
    def _observation(self, context: RuntimeContext, message: str) -> Any:
        with langfuse_observability.start_run(context, message) as handle:
            yield handle

    async def stream(self, message: str, conversation_id: Optional[str] = None, user_id: str = "local-user") -> AsyncIterator[Dict[str, Any]]:
        decision = validate_input(message)
        context = RuntimeContext.create(user_id, conversation_id or _id("conv"), max_turns=self.config.max_turns, timeout_seconds=self.config.timeout_seconds)
        started = asyncio.get_event_loop().time()
        tool_events: List[Dict[str, Any]] = []

        def audit_terminal(status: str, error_code: Optional[str] = None) -> None:
            record_runtime({
                **context.as_run(),
                "turns": 1,
                "toolCalls": len([item for item in tool_events if "inputSummary" in item]),
                "toolNames": [item.get("toolName") for item in tool_events if "inputSummary" in item],
                "status": status,
                "errorCode": error_code,
                "durationMs": int((asyncio.get_event_loop().time() - started) * 1000),
            })

        yield {"event": "run_started", "data": {"run": context.as_run(), "conversation": {"id": context.conversation_id}}}
        if not decision.allowed:
            answer = _failure_answer(decision.message or "输入未通过安全检查。", code=decision.code)
            audit_terminal(answer.status, decision.code)
            yield {"event": "error", "data": {"code": decision.code, "message": decision.message}}
            yield {"event": "result", "data": {"answer": answer.model_dump(mode="json"), "status": answer.status, "run": context.as_run(), "answerText": answer.answer_text}}
            return
        if decision.code == "MEDICAL_BOUNDARY":
            answer = AgentAnswer(
                status="clarification",
                answer_text="我可以提供妆容遮盖和产品选择建议，但不能诊断或治疗皮肤问题。持续泛红、刺痛、过敏或破损请优先咨询皮肤科。",
                clarification_question="如果你只需要妆容层面的遮盖建议，请告诉我希望的妆效和可接受的遮盖程度。",
                uncertainty=["医疗边界输入未进入商品工具。"],
            )
            audit_terminal(answer.status, "MEDICAL_BOUNDARY")
            yield {"event": "result", "data": {"answer": answer.model_dump(mode="json"), "status": answer.status, "run": context.as_run(), "answerText": answer.answer_text}}
            return

        yield {"event": "status", "data": {"phase": "model", "message": "正在理解你的需求"}}
        try:
            result_event: Optional[Dict[str, Any]] = None
            with self._observation(context, message) as handle:
                if not self.config.use_live_model or not self.config.api_key:
                    answer = self._local_answer(message)
                else:
                    answer = None
                    async for event in self._stream_live(message, context):
                        if event["event"] == "_final_output":
                            answer = _coerce_answer(event["data"]["value"])
                        else:
                            if event["event"] in {"tool_started", "tool_finished"}:
                                tool_events.append(event["data"])
                            yield event
                    if answer is None:
                        raise RuntimeError("Agent did not return a structured answer")
                output_decision = validate_output(answer)
                if not output_decision.allowed:
                    answer = _failure_answer(output_decision.message or "结果未通过安全校验。", code=output_decision.code)
                handle.set_output(answer.model_dump(mode="json"))
                result_event = {"event": "result", "data": {"answer": answer.model_dump(mode="json"), "answerText": answer.answer_text, "status": answer.status, "run": context.as_run()}}
                record_runtime({
                    **context.as_run(),
                    "turns": 1,
                    "toolCalls": len([item for item in tool_events if "inputSummary" in item]),
                    "toolNames": [item.get("toolName") for item in tool_events if "inputSummary" in item],
                    "status": answer.status,
                    "durationMs": int((asyncio.get_event_loop().time() - started) * 1000),
                })
            if result_event is not None:
                langfuse_observability.flush()
                yield result_event
        except asyncio.CancelledError:
            answer = _failure_answer("本次运行已取消。", status="cancelled", code="RUNTIME_CANCELLED")
            audit_terminal(answer.status, "RUNTIME_CANCELLED")
            yield {"event": "error", "data": {"code": "RUNTIME_CANCELLED", "message": answer.answer_text}}
            yield {"event": "result", "data": {"answer": answer.model_dump(mode="json"), "answerText": answer.answer_text, "status": answer.status, "run": context.as_run()}}
        except asyncio.TimeoutError:
            answer = _failure_answer("本次运行超时，请稍后重试。", code="RUNTIME_TIMEOUT")
            audit_terminal(answer.status, "RUNTIME_TIMEOUT")
            yield {"event": "error", "data": {"code": "RUNTIME_TIMEOUT", "message": answer.answer_text}}
            yield {"event": "result", "data": {"answer": answer.model_dump(mode="json"), "answerText": answer.answer_text, "status": answer.status, "run": context.as_run()}}
        except RuntimeLimitError as exc:
            answer = _failure_answer("本次运行达到安全限制，请稍后重试。", status="degraded", code=exc.code)
            audit_terminal(answer.status, exc.code)
            yield {"event": "error", "data": {"code": exc.code, "message": answer.answer_text}}
            yield {"event": "result", "data": {"answer": answer.model_dump(mode="json"), "answerText": answer.answer_text, "status": answer.status, "run": context.as_run()}}
        except ValueError:
            answer = _failure_answer("模型返回的结构化结果无法校验，请稍后重试。", code="OUTPUT_SCHEMA_INVALID")
            audit_terminal(answer.status, "OUTPUT_SCHEMA_INVALID")
            yield {"event": "error", "data": {"code": "OUTPUT_SCHEMA_INVALID", "message": answer.answer_text}}
            yield {"event": "result", "data": {"answer": answer.model_dump(mode="json"), "answerText": answer.answer_text, "status": answer.status, "run": context.as_run()}}
        except Exception:
            answer = _failure_answer("本次运行未能完成，请稍后重试。", code="MODEL_ERROR")
            audit_terminal(answer.status, "MODEL_ERROR")
            yield {"event": "error", "data": {"code": "MODEL_ERROR", "message": answer.answer_text}}
            yield {"event": "result", "data": {"answer": answer.model_dump(mode="json"), "answerText": answer.answer_text, "status": answer.status, "run": context.as_run()}}
        finally:
            langfuse_observability.flush()

    async def run(self, message: str, conversation_id: Optional[str] = None, user_id: str = "local-user", delay_seconds: float = 0.0) -> List[Dict[str, Any]]:
        if delay_seconds:
            await asyncio.sleep(delay_seconds)
        return [event async for event in self.stream(message, conversation_id=conversation_id, user_id=user_id)]


def sse_block(event: Dict[str, Any]) -> str:
    return "event: %s\ndata: %s\n\n" % (event["event"], json.dumps(event["data"], ensure_ascii=False, default=str))


def collect_sse_events(events: List[Dict[str, Any]]) -> List[str]:
    return [sse_block(event) for event in events]
