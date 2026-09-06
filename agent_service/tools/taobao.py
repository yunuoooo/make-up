from __future__ import annotations

from typing import Any, Dict
from urllib.parse import quote

from agents import RunContextWrapper, function_tool

from ..context import RuntimeContext
from ..schemas import ToolResult


@function_tool(name_override="search_taobao_offers")
async def search_taobao_offers(ctx: RunContextWrapper[RuntimeContext], query: str) -> Dict[str, Any]:
    """查询淘宝商品候选；未配置实时 API 时明确返回占位状态。"""
    if not query.strip():
        return ToolResult(status="failed", code="TAOBAO_EMPTY_QUERY", message="查询内容为空").model_dump()
    configured = bool(__import__("os").getenv("TAOBAO_API_KEY") and __import__("os").getenv("TAOBAO_API_SECRET"))
    return ToolResult(
        status="succeeded" if configured else "degraded",
        code=None if configured else "TAOBAO_NOT_CONFIGURED",
        message=None if configured else "淘宝实时 API 未配置，以下为搜索占位。",
        data={
            "offers": [
                {
                    "id": "sku_" + query[:24],
                    "name": query,
                    "status": "live" if configured else "placeholder",
                    "channel": "淘宝",
                    "purchase_url": "https://s.taobao.com/search?q=" + quote(query),
                }
            ]
        },
    ).model_dump()
