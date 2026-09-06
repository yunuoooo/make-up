from __future__ import annotations

from typing import Any, Dict

from agents import RunContextWrapper, function_tool

from ..audit import record_runtime
from ..context import RuntimeContext
from ..schemas import ToolResult


@function_tool(name_override="save_evidence")
async def save_evidence(ctx: RunContextWrapper[RuntimeContext], evidence_id: str, summary: str) -> Dict[str, Any]:
    """保存本轮已确认的来源摘要；用户作用域由服务端上下文提供。"""
    if not evidence_id.strip() or not summary.strip():
        return ToolResult(status="failed", code="EVIDENCE_INVALID", message="来源摘要不完整").model_dump()
    return ToolResult(status="succeeded", data={"evidence_id": evidence_id, "conversation_id": ctx.context.conversation_id}).model_dump()


@function_tool(name_override="save_tool_run")
async def save_tool_run(ctx: RunContextWrapper[RuntimeContext], tool_name: str, status: str, output_summary: str) -> Dict[str, Any]:
    """记录本轮工具摘要；只保存脱敏摘要，不接受原始响应或凭据。"""
    if not tool_name.strip() or status not in {"succeeded", "degraded", "failed"}:
        return ToolResult(status="failed", code="TOOL_RUN_INVALID", message="工具记录格式无效").model_dump()
    tool_run_id = "toolrun_" + ctx.context.message_id
    record_runtime({**ctx.context.as_run(), "toolRunId": tool_run_id, "toolName": tool_name, "status": status, "outputSummary": output_summary[:240]})
    return ToolResult(status="succeeded", data={"tool_run_id": tool_run_id}).model_dump()
