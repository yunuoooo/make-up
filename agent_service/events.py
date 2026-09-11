from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .schemas import RunContext


@dataclass(frozen=True)
class WorkflowEvent:
    event: str
    data: dict[str, Any]


def to_sse(event: WorkflowEvent) -> str:
    payload = json.dumps(event.data, ensure_ascii=False)
    return f"event: {event.event}\ndata: {payload}\n\n"


def map_sdk_event(
    sdk_event: Any,
    context: RunContext,
    tool_names: dict[str, str],
) -> WorkflowEvent | None:
    if sdk_event.type == "raw_response_event":
        if getattr(sdk_event.data, "type", "") != "response.output_text.delta":
            return None
        delta = getattr(sdk_event.data, "delta", "")
        return WorkflowEvent("text_delta", {"text": str(delta)}) if delta else None

    if sdk_event.type != "run_item_stream_event":
        return None

    if sdk_event.name == "tool_called":
        call_id = _call_id(sdk_event.item)
        tool_name = _tool_name(sdk_event.item)
        tool_names[call_id] = tool_name
        return WorkflowEvent(
            "tool_started",
            {
                "toolName": tool_name,
                "callId": call_id,
                "inputSummary": _tool_input_summary(sdk_event.item),
            },
        )

    if sdk_event.name == "tool_output":
        call_id = _call_id(sdk_event.item)
        result = context.xhs_result
        return WorkflowEvent(
            "tool_finished",
            {
                "toolName": tool_names.get(call_id, "search_xhs_evidence"),
                "callId": call_id,
                "status": result.status if result else "unknown",
                "outputSummary": (
                    f"status={result.status}; posts={len(result.posts)}"
                    if result
                    else "status=unknown; posts=0"
                ),
                "errorCode": result.error_code if result else None,
            },
        )

    return None


def _raw_item(item: Any) -> Any:
    return getattr(item, "raw_item", item)


def _call_id(item: Any) -> str:
    raw = _raw_item(item)
    value = (
        getattr(item, "call_id", None)
        or getattr(raw, "call_id", None)
        or (raw.get("call_id") if isinstance(raw, dict) else None)
    )
    return str(value or "unknown_call")


def _tool_name(item: Any) -> str:
    raw = _raw_item(item)
    value = getattr(raw, "name", None) or (
        raw.get("name") if isinstance(raw, dict) else None
    )
    return str(value or "unknown_tool")


def _tool_input_summary(item: Any) -> str:
    raw = _raw_item(item)
    value = getattr(raw, "arguments", None)
    if value is None and isinstance(raw, dict):
        value = raw.get("arguments")
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return "invalid arguments"
    if isinstance(value, dict) and isinstance(value.get("query"), str):
        return f"queryLength={len(value['query'])}"
    return ""
