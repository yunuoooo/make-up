from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class SourceReference(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    title: str = ""
    summary: str = ""
    status: Literal["succeeded", "degraded", "failed"] = "succeeded"
    source_url: Optional[str] = None


class SkuCandidate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    category: str
    status: Literal["live", "placeholder", "unavailable"] = "placeholder"
    reason: str = ""
    price: Optional[str] = None
    channel: Optional[str] = None
    purchase_url: Optional[str] = None


class OwnedProductMatch(BaseModel):
    model_config = ConfigDict(extra="ignore")

    reviewed: bool = False
    usable_items: List[Dict[str, Any]] = Field(default_factory=list)
    partial_matches: List[Dict[str, Any]] = Field(default_factory=list)
    not_suitable: List[Dict[str, Any]] = Field(default_factory=list)
    missing_capabilities: List[Dict[str, Any]] = Field(default_factory=list)


class LookFeatureSet(BaseModel):
    model_config = ConfigDict(extra="ignore")

    overall_style: str = "待确认的妆容目标"
    base: List[str] = Field(default_factory=list)
    eyes: List[str] = Field(default_factory=list)
    brows: List[str] = Field(default_factory=list)
    cheeks: List[str] = Field(default_factory=list)
    lips: List[str] = Field(default_factory=list)
    colors: List[str] = Field(default_factory=list)
    texture: List[str] = Field(default_factory=list)
    focus: List[str] = Field(default_factory=list)
    uncertainty: List[str] = Field(default_factory=list)


class AgentAnswer(BaseModel):
    """Versioned business contract returned by the Agent, never raw model text."""

    model_config = ConfigDict(extra="ignore")

    schema_version: Literal["looktrace.answer.v1"] = "looktrace.answer.v1"
    status: Literal["succeeded", "clarification", "degraded", "failed", "cancelled"]
    answer_text: str
    clarification_question: Optional[str] = None
    look_features: LookFeatureSet = Field(default_factory=LookFeatureSet)
    sources: List[SourceReference] = Field(default_factory=list)
    sku_candidates: List[SkuCandidate] = Field(default_factory=list)
    owned_product_match: OwnedProductMatch = Field(default_factory=OwnedProductMatch)
    uncertainty: List[str] = Field(default_factory=list)
    tool_run_ids: List[str] = Field(default_factory=list)


class ToolResult(BaseModel):
    model_config = ConfigDict(extra="ignore")

    status: Literal["succeeded", "degraded", "failed"]
    code: Optional[str] = None
    message: Optional[str] = None
    data: Dict[str, Any] = Field(default_factory=dict)
