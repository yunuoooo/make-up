from __future__ import annotations

import os
from dataclasses import dataclass, field
from urllib.parse import urlparse


@dataclass(frozen=True)
class XhsMcpSettings:
    mode: str = "mcp"
    url: str = "http://127.0.0.1:18060/mcp"
    auth_token: str = ""
    request_timeout_seconds: float = 75.0
    sse_read_timeout_seconds: float = 120.0
    search_limit: int = 5
    detail_limit: int = 2
    post_character_limit: int = 8_000
    comment_limit: int = 20
    comment_character_limit: int = 500
    total_character_limit: int = 30_000

    def __post_init__(self) -> None:
        mode = self.mode.strip().lower()
        if mode not in {"mock", "mcp"}:
            raise ValueError("XHS_SOURCE_MODE must be 'mock' or 'mcp'")
        object.__setattr__(self, "mode", mode)
        object.__setattr__(self, "search_limit", min(max(self.search_limit, 1), 10))
        object.__setattr__(self, "detail_limit", min(max(self.detail_limit, 1), 5))
        if mode == "mcp":
            parsed = urlparse(self.url)
            is_loopback = parsed.hostname in {"127.0.0.1", "localhost", "::1"}
            if parsed.scheme != "https" and not (
                parsed.scheme == "http" and is_loopback
            ):
                raise ValueError(
                    "XHS_MCP_URL must use HTTPS or a loopback HTTP address"
                )

    @classmethod
    def from_env(cls) -> "XhsMcpSettings":
        return cls(
            mode=os.getenv("XHS_SOURCE_MODE", "mcp"),
            url=os.getenv("XHS_MCP_URL", "http://127.0.0.1:18060/mcp"),
            auth_token=os.getenv("XHS_MCP_AUTH_TOKEN", ""),
            request_timeout_seconds=float(
                os.getenv("XHS_MCP_REQUEST_TIMEOUT_SECONDS", "75")
            ),
            sse_read_timeout_seconds=float(
                os.getenv("XHS_MCP_SSE_READ_TIMEOUT_SECONDS", "120")
            ),
            search_limit=int(os.getenv("XHS_MCP_SEARCH_LIMIT", "5")),
            detail_limit=int(os.getenv("XHS_MCP_DETAIL_LIMIT", "2")),
        )


@dataclass(frozen=True)
class AgentSettings:
    provider: str = "deepseek"
    model: str = "deepseek-chat"
    model_base_url: str = "https://api.deepseek.com"
    model_api_key: str = ""
    tracing_api_key: str = ""
    trace_include_sensitive_data: bool = False
    max_turns: int = 6
    timeout_seconds: float = 180.0
    xhs: XhsMcpSettings = field(default_factory=XhsMcpSettings)

    def __post_init__(self) -> None:
        provider = self.provider.strip().lower()
        if provider != "deepseek":
            raise ValueError("AGENT_MODEL_PROVIDER must be 'deepseek' in Phase 1")
        object.__setattr__(self, "provider", provider)

    @classmethod
    def from_env(cls) -> "AgentSettings":
        tracing_api_key = os.getenv("OPENAI_TRACING_API_KEY")
        tracing_key_name = "OPENAI_TRACING_API_KEY"
        if tracing_api_key is None:
            tracing_api_key = os.getenv("OPENAI_API_KEY", "")
            tracing_key_name = "OPENAI_API_KEY"
        if any(character.isspace() for character in tracing_api_key):
            raise ValueError(f"{tracing_key_name} must not contain whitespace")

        return cls(
            provider=os.getenv("AGENT_MODEL_PROVIDER", "deepseek"),
            model=os.getenv("AGENT_MODEL", "deepseek-chat"),
            model_base_url=os.getenv(
                "AGENT_MODEL_BASE_URL",
                "https://api.deepseek.com",
            ),
            model_api_key=os.getenv("DEEPSEEK_API_KEY", ""),
            tracing_api_key=tracing_api_key,
            trace_include_sensitive_data=os.getenv(
                "OPENAI_AGENTS_TRACE_INCLUDE_SENSITIVE_DATA",
                "false",
            ).strip().lower()
            in {"1", "true"},
            max_turns=int(os.getenv("AGENT_MAX_TURNS", "6")),
            timeout_seconds=float(os.getenv("AGENT_TIMEOUT_SECONDS", "180")),
            xhs=XhsMcpSettings.from_env(),
        )
