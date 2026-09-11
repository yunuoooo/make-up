from __future__ import annotations

import asyncio
from typing import Any, Callable

from agents.mcp import MCPServerStreamableHttp

from .config import XhsMcpSettings
from .schemas import XhsPost, XhsSearchResult
from .xhs_content import (
    XhsMcpToolError,
    clean_text,
    extract_feed_candidates,
    mock_result,
    parse_login_status,
    parse_mcp_payload,
    parse_post,
    post_size,
)


READ_ONLY_TOOLS = frozenset(
    {"check_login_status", "search_feeds", "get_feed_detail"}
)


class XhsMcpClient:
    """Read-only Xiaohongshu MCP integration used by the Agent tool."""

    def __init__(
        self,
        settings: XhsMcpSettings | None = None,
        *,
        server: Any | None = None,
        server_factory: Callable[[XhsMcpSettings], Any] | None = None,
    ) -> None:
        self.settings = settings or XhsMcpSettings.from_env()
        self.mode = self.settings.mode
        self._server = server
        self._server_factory = server_factory or _create_server
        self._connect_lock = asyncio.Lock()
        self.connected = False
        self.logged_in: bool | None = None
        self.last_error_code: str | None = None

    async def __aenter__(self) -> "XhsMcpClient":
        await self.start()
        return self

    async def __aexit__(self, *_exc_info: object) -> None:
        await self.close()

    async def start(self) -> None:
        if self.mode == "mock" or self.connected:
            return
        async with self._connect_lock:
            if self.connected:
                return
            if self._server is None:
                self._server = self._server_factory(self.settings)
            try:
                await self._server.connect()
                self.connected = True
                login = await self._server.call_tool("check_login_status", {})
                self.logged_in = parse_login_status(parse_mcp_payload(login))
                self.last_error_code = (
                    None if self.logged_in is not False else "XHS_NOT_LOGGED_IN"
                )
            except Exception as exc:
                self.last_error_code = _connection_error_code(exc)
                self.logged_in = None
                await self._disconnect()

    async def close(self) -> None:
        await self._disconnect()

    async def search(self, query: str) -> XhsSearchResult:
        query = clean_text(query, 200)
        if not query:
            return _failure(
                "XHS_EMPTY_QUERY",
                "小红书搜索词不能为空。",
                status="failed",
            )
        if self.mode == "mock":
            return mock_result(query)

        await self.start()
        if not self.connected:
            code = self.last_error_code or "XHS_MCP_UNAVAILABLE"
            return _failure(code, _error_message(code))
        if self.logged_in is False:
            return _failure("XHS_NOT_LOGGED_IN", "小红书服务尚未登录。")

        try:
            search_payload = await self._search_payload(query)
            if not isinstance(search_payload, (dict, list)):
                return _failure(
                    "XHS_MCP_INVALID_RESPONSE",
                    "小红书搜索结果无法读取。",
                )
            candidates = extract_feed_candidates(
                search_payload,
                self.settings.search_limit,
            )
            if not candidates:
                return _failure("XHS_EMPTY_RESULT", "没有找到相关的小红书笔记。")

            posts: list[XhsPost] = []
            detail_failure_count = 0
            remaining = self.settings.total_character_limit
            for candidate in candidates[: self.settings.detail_limit]:
                try:
                    detail = await self._call(
                        "get_feed_detail",
                        {
                            "feed_id": candidate["feed_id"],
                            "xsec_token": candidate["xsec_token"],
                        },
                    )
                    post = parse_post(
                        parse_mcp_payload(detail),
                        candidate,
                        self.settings,
                        remaining,
                    )
                except Exception:
                    detail_failure_count += 1
                    continue
                if post is None:
                    detail_failure_count += 1
                    continue
                posts.append(post)
                remaining -= post_size(post)
                if remaining <= 0:
                    break
            if not posts:
                return _failure(
                    "XHS_MCP_INVALID_RESPONSE",
                    "小红书详情结果无法读取。",
                )
            return XhsSearchResult(
                status="succeeded",
                mode="mcp",
                posts=posts,
                detail_failure_count=detail_failure_count,
                truncated=remaining <= 0 or len(candidates) > len(posts),
            )
        except XhsMcpToolError:
            self.last_error_code = "XHS_MCP_TOOL_FAILED"
            return _failure(
                "XHS_MCP_TOOL_FAILED",
                _error_message("XHS_MCP_TOOL_FAILED"),
            )
        except Exception as exc:
            code = _connection_error_code(exc)
            self.last_error_code = code
            await self._disconnect()
            return _failure(code, _error_message(code))

    async def _search_payload(self, query: str) -> Any:
        for attempt in range(2):
            result = await self._call("search_feeds", {"keyword": query})
            try:
                return parse_mcp_payload(result)
            except XhsMcpToolError:
                if attempt == 1:
                    raise
        raise AssertionError("unreachable")

    async def _call(self, name: str, arguments: dict[str, Any]) -> Any:
        if name not in READ_ONLY_TOOLS:
            raise ValueError(f"MCP tool is not allowed: {name}")
        return await asyncio.wait_for(
            self._server.call_tool(name, arguments),
            timeout=self.settings.request_timeout_seconds,
        )

    async def _disconnect(self) -> None:
        if self._server is None:
            return
        try:
            await self._server.cleanup()
        except Exception:
            pass
        finally:
            self.connected = False
            self.logged_in = None


def _create_server(settings: XhsMcpSettings) -> MCPServerStreamableHttp:
    headers = (
        {"Authorization": f"Bearer {settings.auth_token}"}
        if settings.auth_token
        else None
    )
    return MCPServerStreamableHttp(
        name="xiaohongshu-mcp",
        params={
            "url": settings.url,
            "headers": headers,
            "timeout": settings.request_timeout_seconds,
            "sse_read_timeout": settings.sse_read_timeout_seconds,
        },
        cache_tools_list=True,
        client_session_timeout_seconds=settings.request_timeout_seconds,
        max_retry_attempts=1,
    )


def _failure(
    code: str,
    message: str,
    *,
    status: str = "degraded",
) -> XhsSearchResult:
    return XhsSearchResult(
        status=status,
        mode="mcp",
        error_code=code,
        message=message,
    )


def _connection_error_code(error: BaseException) -> str:
    if isinstance(error, (TimeoutError, asyncio.TimeoutError)):
        return "XHS_MCP_TIMEOUT"
    message = str(error).lower()
    if any(value in message for value in ("401", "403", "unauthorized", "forbidden")):
        return "XHS_MCP_UNAUTHORIZED"
    return "XHS_MCP_UNAVAILABLE"


def _error_message(code: str) -> str:
    return {
        "XHS_MCP_TIMEOUT": "小红书服务请求超时。",
        "XHS_MCP_UNAUTHORIZED": "小红书服务鉴权失败。",
        "XHS_NOT_LOGGED_IN": "小红书服务尚未登录。",
        "XHS_MCP_TOOL_FAILED": "小红书页面暂时无法读取，请稍后重试。",
        "XHS_MCP_UNAVAILABLE": "小红书服务暂时不可用。",
    }.get(code, "小红书服务暂时不可用。")
