import os
import unittest
from unittest.mock import patch

from agent_service.config import AgentSettings


class AgentSettingsTests(unittest.TestCase):
    def test_default_agent_timeout_exceeds_a_real_xhs_tool_request(self):
        with patch.dict(
            os.environ,
            {
                "AGENT_TIMEOUT_SECONDS": "",
                "XHS_MCP_REQUEST_TIMEOUT_SECONDS": "",
                "XHS_MCP_DETAIL_LIMIT": "",
            },
            clear=False,
        ):
            for name in (
                "AGENT_TIMEOUT_SECONDS",
                "XHS_MCP_REQUEST_TIMEOUT_SECONDS",
                "XHS_MCP_DETAIL_LIMIT",
            ):
                os.environ.pop(name, None)
            settings = AgentSettings.from_env()

        self.assertGreater(
            settings.timeout_seconds,
            settings.xhs.request_timeout_seconds,
        )
        self.assertGreater(
            settings.xhs.sse_read_timeout_seconds,
            settings.xhs.request_timeout_seconds,
        )
        self.assertEqual(settings.xhs.detail_limit, 2)


if __name__ == "__main__":
    unittest.main()
