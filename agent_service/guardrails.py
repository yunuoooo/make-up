from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from .schemas import AgentAnswer, ToolResult


@dataclass
class GuardrailDecision:
    allowed: bool
    code: str | None = None
    message: str | None = None


_INJECTION_PATTERNS = (
    r"system\s*prompt",
    r"系统提示",
    r"隐藏规则",
    r"api[_ -]?key",
    r"凭据",
    r"忽略.*指令",
)
_MEDICAL_PATTERNS = (r"诊断", r"治疗", r"处方", r"皮肤破损", r"过敏反应")


def validate_input(message: str) -> GuardrailDecision:
    value = (message or "").strip()
    if not value:
        return GuardrailDecision(False, "INPUT_EMPTY", "请输入一个文字妆容目标。")
    if len(value) > 4000:
        return GuardrailDecision(False, "INPUT_TOO_LONG", "这条消息太长了，请缩短后重试。")
    if any(re.search(pattern, value, re.IGNORECASE) for pattern in _INJECTION_PATTERNS):
        return GuardrailDecision(False, "INPUT_POLICY", "我不能提供系统规则、凭据或隐藏推理。")
    if any(re.search(pattern, value, re.IGNORECASE) for pattern in _MEDICAL_PATTERNS):
        return GuardrailDecision(True, "MEDICAL_BOUNDARY", "这类问题会保留安全边界，不进入商品推荐工具。")
    return GuardrailDecision(True)


def validate_tool_result(tool_name: str, result: Any, user_id: str) -> GuardrailDecision:
    if isinstance(result, ToolResult):
        value = result.model_dump()
    elif isinstance(result, dict):
        value = result
    else:
        return GuardrailDecision(False, "TOOL_SCHEMA_INVALID", "%s 返回结果格式无效。" % tool_name)
    if value.get("status") not in {"succeeded", "degraded", "failed"}:
        return GuardrailDecision(False, "TOOL_SCHEMA_INVALID", "%s 缺少有效状态。" % tool_name)
    if not isinstance(value.get("data", {}), dict):
        return GuardrailDecision(False, "TOOL_SCHEMA_INVALID", "%s 的 data 格式无效。" % tool_name)
    serialized = json.dumps(value, ensure_ascii=False, default=str)
    if any(secret in serialized.lower() for secret in ("openai_api_key", "deepseek_api_key", "api_key", "cookie", "authorization")):
        return GuardrailDecision(False, "TOOL_SENSITIVE_DATA", "%s 返回了禁止传播的数据。" % tool_name)
    if tool_name in {"get_user_products", "match_user_products"}:
        if value.get("data", {}).get("user_id") != user_id:
            return GuardrailDecision(False, "TOOL_SCOPE_MISMATCH", "妆匣结果不属于当前用户。")
    return GuardrailDecision(True)


def validate_output(answer: AgentAnswer) -> GuardrailDecision:
    try:
        validated = AgentAnswer.model_validate(answer)
    except Exception:
        return GuardrailDecision(False, "OUTPUT_SCHEMA_INVALID", "模型结果不符合业务结构。")
    if validated.status == "succeeded" and not validated.sources:
        return GuardrailDecision(False, "OUTPUT_SOURCE_REQUIRED", "推荐结果缺少可验证来源。")
    if "api_key" in validated.answer_text.lower() or "系统提示" in validated.answer_text:
        return GuardrailDecision(False, "OUTPUT_POLICY", "结果包含不应展示的内部信息。")
    return GuardrailDecision(True)
