import asyncio
import json
import unittest

from mcp.types import CallToolResult, TextContent

from agent_service.config import XhsMcpSettings
from agent_service.xhs_integration import XhsMcpClient


class FakeMcpServer:
    def __init__(self) -> None:
        self.connected = False
        self.closed = False
        self.calls: list[tuple[str, dict]] = []

    async def connect(self) -> None:
        self.connected = True

    async def cleanup(self) -> None:
        self.closed = True

    async def call_tool(self, name: str, arguments: dict) -> CallToolResult:
        self.calls.append((name, arguments))
        if name == "check_login_status":
            return CallToolResult(content=[TextContent(text='{"logged_in": true}')])
        if name == "search_feeds":
            return CallToolResult(
                content=[
                    TextContent(
                        text=json.dumps(
                            {
                                "feeds": [
                                    {
                                        "id": "feed_1",
                                        "xsecToken": "top-secret-token",
                                        "noteCard": {"displayTitle": "低饱和通勤妆"},
                                    },
                                    {
                                        "id": "feed_1",
                                        "xsecToken": "top-secret-token",
                                    },
                                ]
                            },
                            ensure_ascii=False,
                        )
                    )
                ]
            )
        if name == "get_feed_detail":
            return CallToolResult(
                content=[
                    TextContent(
                        text=json.dumps(
                            {
                                "data": {
                                    "note": {
                                        "xsecToken": "must-not-leak",
                                        "title": "低饱和通勤妆",
                                        "desc": "薄透底妆，灰棕眉眼，豆沙唇。",
                                        "user": {"nickname": "作者甲"},
                                    },
                                    "comments": {
                                        "list": [
                                            {
                                                "content": "油皮可以换成控油底妆。",
                                                "userInfo": {"nickname": "评论者乙"},
                                            }
                                        ]
                                    },
                                },
                                "cookie": "must-not-leak",
                            },
                            ensure_ascii=False,
                        )
                    )
                ]
            )
        raise AssertionError(f"unexpected MCP tool: {name}")


class XhsMcpClientTests(unittest.TestCase):
    def test_search_returns_typed_sanitized_posts_and_reuses_the_connection(self):
        server = FakeMcpServer()
        client = XhsMcpClient(
            XhsMcpSettings(mode="mcp", search_limit=5, detail_limit=3),
            server=server,
        )

        async def scenario():
            await client.start()
            first = await client.search("低饱和通勤妆")
            second = await client.search("低饱和通勤妆")
            await client.close()
            return first, second

        first, second = asyncio.run(scenario())

        self.assertEqual(first.status, "succeeded")
        self.assertEqual(first.mode, "mcp")
        self.assertEqual(len(first.posts), 1)
        self.assertEqual(first.posts[0].comments[0].author_name, "评论者乙")
        serialized = first.model_dump_json()
        self.assertNotIn("top-secret-token", serialized)
        self.assertNotIn("must-not-leak", serialized)
        self.assertEqual(second.status, "succeeded")
        self.assertEqual([name for name, _ in server.calls].count("check_login_status"), 1)
        self.assertTrue(server.closed)

    def test_connection_failure_is_degraded_and_never_uses_mock_data(self):
        class BrokenServer(FakeMcpServer):
            async def connect(self) -> None:
                raise RuntimeError("connection failed with token=secret")

        client = XhsMcpClient(XhsMcpSettings(mode="mcp"), server=BrokenServer())

        result = asyncio.run(client.search("通勤妆"))

        self.assertEqual(result.status, "degraded")
        self.assertEqual(result.error_code, "XHS_MCP_UNAVAILABLE")
        self.assertEqual(result.posts, [])
        self.assertNotIn("secret", result.model_dump_json())

    def test_connection_errors_keep_actionable_safe_error_codes(self):
        cases = [
            (asyncio.TimeoutError(), "XHS_MCP_TIMEOUT"),
            (RuntimeError("401 Unauthorized bearer secret"), "XHS_MCP_UNAUTHORIZED"),
        ]
        for error, expected_code in cases:
            with self.subTest(expected_code=expected_code):
                class ErrorServer(FakeMcpServer):
                    async def connect(self) -> None:
                        raise error

                client = XhsMcpClient(
                    XhsMcpSettings(mode="mcp"),
                    server=ErrorServer(),
                )

                result = asyncio.run(client.search("通勤妆"))

                self.assertEqual(result.error_code, expected_code)
                self.assertNotIn("secret", result.model_dump_json())

    def test_one_broken_detail_keeps_other_successful_posts(self):
        class PartialServer(FakeMcpServer):
            async def call_tool(self, name: str, arguments: dict) -> CallToolResult:
                if name == "check_login_status":
                    return await super().call_tool(name, arguments)
                if name == "search_feeds":
                    return CallToolResult(
                        content=[
                            TextContent(
                                text=json.dumps(
                                    {
                                        "feeds": [
                                            {"id": "broken", "xsecToken": "token_1"},
                                            {"id": "working", "xsecToken": "token_2"},
                                        ]
                                    }
                                )
                            )
                        ]
                    )
                if name == "get_feed_detail" and arguments["feed_id"] == "broken":
                    return CallToolResult(
                        isError=True,
                        content=[TextContent(text="detail unavailable")],
                    )
                if name == "get_feed_detail":
                    return CallToolResult(
                        content=[
                            TextContent(
                                text=json.dumps(
                                    {
                                        "data": {
                                            "note": {
                                                "title": "可用笔记",
                                                "desc": "有效内容",
                                                "user": {"nickname": "作者"},
                                            },
                                            "comments": {"list": []},
                                        }
                                    },
                                    ensure_ascii=False,
                                )
                            )
                        ]
                    )
                raise AssertionError(f"unexpected MCP tool: {name}")

        client = XhsMcpClient(XhsMcpSettings(mode="mcp"), server=PartialServer())

        result = asyncio.run(client.search("通勤妆"))

        self.assertEqual(result.status, "succeeded")
        self.assertEqual([post.post_id for post in result.posts], ["working"])
        self.assertEqual(result.detail_failure_count, 1)

    def test_unstructured_search_response_is_not_reported_as_an_empty_result(self):
        class InvalidSearchServer(FakeMcpServer):
            async def call_tool(self, name: str, arguments: dict) -> CallToolResult:
                if name == "check_login_status":
                    return await super().call_tool(name, arguments)
                if name == "search_feeds":
                    return CallToolResult(
                        content=[TextContent(text="upstream returned plain text")]
                    )
                raise AssertionError(f"unexpected MCP tool: {name}")

        client = XhsMcpClient(
            XhsMcpSettings(mode="mcp"),
            server=InvalidSearchServer(),
        )

        result = asyncio.run(client.search("通勤妆"))

        self.assertEqual(result.status, "degraded")
        self.assertEqual(result.error_code, "XHS_MCP_INVALID_RESPONSE")

    def test_tool_failure_retries_once_without_reconnecting(self):
        class RecoveringServer(FakeMcpServer):
            def __init__(self) -> None:
                super().__init__()
                self.search_attempts = 0

            async def call_tool(self, name: str, arguments: dict) -> CallToolResult:
                if name == "search_feeds":
                    self.calls.append((name, arguments))
                    self.search_attempts += 1
                    if self.search_attempts == 1:
                        return CallToolResult(
                            isError=True,
                            content=[TextContent(text="upstream page timed out")],
                        )
                return await super().call_tool(name, arguments)

        server = RecoveringServer()
        client = XhsMcpClient(XhsMcpSettings(mode="mcp"), server=server)

        result = asyncio.run(client.search("低饱和通勤妆"))

        self.assertEqual(result.status, "succeeded")
        self.assertEqual(server.search_attempts, 2)
        self.assertEqual([name for name, _ in server.calls].count("check_login_status"), 1)
        self.assertTrue(client.connected)
        self.assertFalse(server.closed)

    def test_transport_timeout_clears_stale_login_state(self):
        class TimeoutServer(FakeMcpServer):
            async def call_tool(self, name: str, arguments: dict) -> CallToolResult:
                if name == "search_feeds":
                    await asyncio.sleep(0.05)
                return await super().call_tool(name, arguments)

        client = XhsMcpClient(
            XhsMcpSettings(mode="mcp", request_timeout_seconds=0.001),
            server=TimeoutServer(),
        )

        result = asyncio.run(client.search("低饱和通勤妆"))

        self.assertEqual(result.error_code, "XHS_MCP_TIMEOUT")
        self.assertFalse(client.connected)
        self.assertIsNone(client.logged_in)


if __name__ == "__main__":
    unittest.main()
