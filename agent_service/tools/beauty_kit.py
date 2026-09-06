from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

from agents import RunContextWrapper, function_tool

from ..context import RuntimeContext
from ..schemas import ToolResult


def _products_for(user_id: str) -> List[Dict[str, Any]]:
    path = Path(".local-data/user-products.json")
    try:
        products = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [item for item in products if item.get("userId") == user_id and item.get("status") != "retired"]


@function_tool(name_override="get_user_products")
async def get_user_products(ctx: RunContextWrapper[RuntimeContext]) -> Dict[str, Any]:
    """读取当前授权用户妆匣；用户作用域来自服务端运行上下文。"""
    products = _products_for(ctx.context.user_id)
    return ToolResult(status="succeeded", data={"user_id": ctx.context.user_id, "products": products}).model_dump()


@function_tool(name_override="match_user_products")
async def match_user_products(
    ctx: RunContextWrapper[RuntimeContext], target: str
) -> Dict[str, Any]:
    """将当前用户妆匣与目标妆效做能力匹配。"""
    products = _products_for(ctx.context.user_id)
    usable = [product for product in products if any(tag in target for tag in product.get("effectTags", []))]
    return ToolResult(
        status="succeeded",
        data={
            "user_id": ctx.context.user_id,
            "target": target,
            "usable_items": usable,
            "missing_capabilities": [] if usable else [{"category": "待确认", "capability": target}],
        },
    ).model_dump()
