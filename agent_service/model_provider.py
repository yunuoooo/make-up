from __future__ import annotations

from agents import OpenAIChatCompletionsModel
from openai import AsyncOpenAI

from .config import AgentSettings


def create_model(settings: AgentSettings) -> OpenAIChatCompletionsModel:
    if settings.provider != "deepseek":
        raise ValueError(f"Unsupported Phase 1 model provider: {settings.provider}")

    client = AsyncOpenAI(
        api_key=settings.model_api_key or _missing_deepseek_api_key,
        base_url=settings.model_base_url,
    )
    return OpenAIChatCompletionsModel(
        model=settings.model,
        openai_client=client,
    )


async def _missing_deepseek_api_key() -> str:
    raise RuntimeError("DEEPSEEK_API_KEY is required to run the Agent")
