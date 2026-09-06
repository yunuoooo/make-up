from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Any, Callable, Iterator, Optional

from opentelemetry.sdk.trace import SpanProcessor

from .prompts import prompt_metadata


def _env_flag(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _safe_input(value: str, include_sensitive_data: bool) -> Any:
    if include_sensitive_data:
        return value
    return {"redacted": True, "characterCount": len(value)}


def _safe_output(value: Any, include_sensitive_data: bool) -> Any:
    if include_sensitive_data:
        return value
    if not isinstance(value, dict):
        return {"redacted": True}
    return {
        "redacted": True,
        "status": value.get("status"),
        "schemaVersion": value.get("schema_version"),
        "sourceCount": len(value.get("sources") or []),
        "candidateCount": len(value.get("sku_candidates") or []),
        "toolRunCount": len(value.get("tool_run_ids") or []),
    }


class PromptLinkProcessor(SpanProcessor):
    """Attach the active application prompt to every Langfuse observation."""

    def __init__(self, name: str, version: str) -> None:
        self.name = name
        self.version = version

    def on_start(self, span: Any, parent_context: Any = None) -> None:
        span.set_attribute("langfuse.prompt.name", self.name)
        span.set_attribute("langfuse.prompt.version", self.version)

    def on_end(self, span: Any) -> None:
        return None

    def shutdown(self) -> None:
        return None

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return True


class ObservationHandle:
    def __init__(self, observation: Any = None, output_transform: Optional[Callable[[Any], Any]] = None):
        self.observation = observation
        self.output: Any = None
        self._output_transform = output_transform or (lambda value: value)
        self._ended = False

    def set_output(self, output: Any) -> None:
        self.output = self._output_transform(output)
        if self.observation is not None:
            try:
                self.observation.update(output=self.output)
            except Exception:
                pass

    def end(self) -> None:
        if self._ended or self.observation is None:
            return
        try:
            self.observation.end()
        except Exception:
            pass
        self._ended = True


class LangfuseObservability:
    """Public Langfuse + OpenInference setup for the Agents SDK."""

    def __init__(self) -> None:
        self.client: Optional[Any] = None
        self.instrumentor: Optional[Any] = None
        self.propagate_attributes: Optional[Callable[..., Any]] = None
        self.prompt_processor: Optional[PromptLinkProcessor] = None
        self.authenticated = False
        self.enabled = False
        self.last_error: Optional[str] = None

    @property
    def include_sensitive_data(self) -> bool:
        return _env_flag("LANGFUSE_TRACE_INCLUDE_SENSITIVE_DATA")

    def setup(self) -> bool:
        public_key = os.getenv("LANGFUSE_PUBLIC_KEY")
        secret_key = os.getenv("LANGFUSE_SECRET_KEY")
        if not public_key or not secret_key:
            return False
        if self.enabled:
            return True
        try:
            from langfuse import get_client, propagate_attributes
            from openinference.instrumentation.openai_agents import OpenAIAgentsInstrumentor

            base_url = os.getenv("LANGFUSE_BASE_URL")
            if base_url and not os.getenv("LANGFUSE_HOST"):
                os.environ["LANGFUSE_HOST"] = base_url.rstrip("/")
            self.instrumentor = OpenAIAgentsInstrumentor()
            self.instrumentor.instrument()
            self.client = get_client()
            self.propagate_attributes = propagate_attributes
            identity = prompt_metadata()
            self.prompt_processor = PromptLinkProcessor(identity["promptName"], identity["promptVersion"])
            from opentelemetry import trace

            provider = trace.get_tracer_provider()
            add_span_processor = getattr(provider, "add_span_processor", None)
            if callable(add_span_processor):
                add_span_processor(self.prompt_processor)
            self.authenticated = bool(self.client.auth_check())
            self.enabled = True
            self.last_error = None
            return True
        except Exception as exc:
            self.client = None
            self.instrumentor = None
            self.propagate_attributes = None
            self.prompt_processor = None
            self.authenticated = False
            self.enabled = False
            self.last_error = type(exc).__name__ + ": " + str(exc)[:240]
            return False

    @contextmanager
    def _propagate(self, context: Any, metadata: dict[str, str]) -> Iterator[None]:
        if self.propagate_attributes is None:
            yield
            return
        environment = os.getenv("LANGFUSE_TRACING_ENVIRONMENT") or os.getenv("LANGFUSE_ENVIRONMENT", "development")
        with self.propagate_attributes(
            trace_name="looktrace.chat.turn",
            user_id=context.user_id,
            session_id=context.conversation_id,
            metadata=metadata,
            tags=["looktrace", "agent-runtime", os.getenv("AGENT_MODEL_PROVIDER", "agent").lower()],
            environment=environment,
        ):
            yield

    @contextmanager
    def start_run(self, context: Any, input_text: str) -> Iterator[ObservationHandle]:
        if not self.enabled or self.client is None:
            yield ObservationHandle()
            return
        raw_trace_id = str(context.trace_id).removeprefix("trace_")
        metadata = context.trace_metadata(input_text)
        include_sensitive_data = self.include_sensitive_data
        try:
            with self.client.start_as_current_observation(
                trace_context={"trace_id": raw_trace_id},
                name="looktrace.chat.turn",
                as_type="agent",
                input=_safe_input(input_text, include_sensitive_data),
                metadata=metadata,
                end_on_exit=False,
            ) as observation:
                with self._propagate(context, metadata):
                    handle = ObservationHandle(
                        observation,
                        output_transform=lambda value: _safe_output(value, include_sensitive_data),
                    )
                    try:
                        yield handle
                    except BaseException:
                        # Preserve a root output for failed runs without recording exception text.
                        handle.set_output({"status": "failed", "errorType": "runtime_error"})
                        raise
                    finally:
                        if handle.output is not None:
                            observation.update(output=handle.output)
                        handle.end()
        except Exception as exc:
            # Observability must never block the product request.
            self.last_error = type(exc).__name__ + ": " + str(exc)[:240]
            yield ObservationHandle()

    def flush(self) -> None:
        if self.client is not None:
            try:
                self.client.flush()
            except Exception as exc:
                self.last_error = type(exc).__name__ + ": " + str(exc)[:240]


langfuse_observability = LangfuseObservability()
