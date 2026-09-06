import os
import unittest
from unittest.mock import patch

from agent_service.runtime import RuntimeConfig


class RuntimeConfigTests(unittest.TestCase):
    def test_openai_api_key_can_be_used_for_explicit_deepseek_provider(self):
        with patch.dict(
            os.environ,
            {
                "AGENT_MODEL_PROVIDER": "deepseek",
                "AGENT_MODEL_BASE_URL": "https://api.deepseek.com",
                "AGENT_MODEL": "deepseek-chat",
                "OPENAI_API_KEY": "deepseek-key",
                "DEEPSEEK_API_KEY": "",
            },
            clear=False,
        ):
            config = RuntimeConfig.from_env()
        self.assertEqual(config.api_key, "deepseek-key")
        self.assertEqual(config.base_url, "https://api.deepseek.com")
        self.assertEqual(config.model, "deepseek-chat")

    def test_openai_provider_does_not_reinterpret_openai_key_as_deepseek(self):
        with patch.dict(
            os.environ,
            {
                "AGENT_MODEL_PROVIDER": "openai",
                "AGENT_MODEL_BASE_URL": "",
                "AGENT_MODEL": "gpt-4o-mini",
                "OPENAI_API_KEY": "openai-key",
                "DEEPSEEK_API_KEY": "",
            },
            clear=False,
        ):
            config = RuntimeConfig.from_env()
        self.assertEqual(config.api_key, "openai-key")
        self.assertIsNone(config.base_url)
        self.assertEqual(config.model, "gpt-4o-mini")


if __name__ == "__main__":
    unittest.main()
