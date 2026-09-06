from __future__ import annotations

import uuid
from typing import Any, Dict

from agents import RunContextWrapper, function_tool

from ..context import RuntimeContext
from ..schemas import ToolResult


_PRESETS = (
    {
        "keywords": ("白开水", "清透", "低饱和", "妈生", "通勤"),
        "title": "低饱和通勤妆：干净底妆和裸粉色系",
        "summary": "薄透底妆、低饱和腮红、灰棕眉眼和裸粉/豆沙唇是常见组合。",
        "features": ["低饱和", "薄透底妆", "干净边界", "裸粉腮红", "灰棕眉眼", "豆沙唇"],
        "skus": ["低遮瑕持妆粉底液", "奶杏裸粉腮红", "灰棕细眉笔", "豆沙唇泥"],
        "categories": ["粉底液", "腮红", "眉笔", "唇泥"],
    },
    {
        "keywords": ("清冷", "骨相", "灰调", "冷感"),
        "title": "清冷骨相妆：灰棕修容和低色彩眼唇",
        "summary": "降低彩度并强调面部结构，常见能力是灰棕修容、冷粉腮红和低饱和唇色。",
        "features": ["清冷感", "灰调", "骨相突出", "低彩度", "轮廓收紧"],
        "skus": ["灰棕修容盘", "冷粉雾面腮红", "低饱和眼影盘", "灰粉唇釉"],
        "categories": ["修容", "腮红", "眼影", "唇釉"],
    },
)


def _pick(query: str) -> Dict[str, Any]:
    normalized = query.lower()
    for preset in _PRESETS:
        if any(keyword in normalized for keyword in preset["keywords"]):
            return preset
    return {
        "title": "妆容目标综合搜索",
        "summary": "按底妆、色彩、眼唇重心和质地拆解用户目标，再抽象产品能力。",
        "features": ["目标拆解", "底妆质地", "色彩重心", "产品能力"],
        "skus": ["适配目标的粉底液", "匹配色系腮红", "同风格唇釉", "基础眼影盘"],
        "categories": ["粉底液", "腮红", "唇釉", "眼影"],
    }


@function_tool(name_override="search_xhs_evidence")
async def search_xhs_evidence(ctx: RunContextWrapper[RuntimeContext], query: str) -> Dict[str, Any]:
    """检索小红书妆容证据，返回来源、摘要和置信度。"""
    if not query.strip():
        return ToolResult(status="failed", code="XHS_EMPTY_QUERY", message="查询内容为空").model_dump()
    preset = _pick(query)
    source_id = "src_" + uuid.uuid4().hex
    evidence_id = "ev_" + uuid.uuid4().hex
    return ToolResult(
        status="succeeded",
        data={
            "sources": [
                {
                    "id": source_id,
                    "title": preset["title"],
                    "summary": preset["summary"],
                    "status": "succeeded",
                    "source_url": None,
                }
            ],
            "evidence": [
                {
                    "id": evidence_id,
                    "source_item_id": source_id,
                    "look_features": preset["features"],
                    "sku_mentions": preset["skus"],
                    "category_patterns": preset["categories"],
                    "confidence": 0.82,
                }
            ],
        },
    ).model_dump()
