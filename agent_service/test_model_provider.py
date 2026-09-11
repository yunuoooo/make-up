import unittest
from unittest.mock import patch

from agent_service.config import AgentSettings
from agent_service.model_provider import create_model


class ModelProviderTests(unittest.TestCase):
    def test_settings_separate_deepseek_model_key_from_openai_tracing_key(self):
        env = {
            "AGENT_MODEL_PROVIDER": "deepseek",
            "AGENT_MODEL": "deepseek-chat",
            "AGENT_MODEL_BASE_URL": "https://api.deepseek.com",
            "DEEPSEEK_API_KEY": "deepseek-secret",
            "OPENAI_API_KEY": "relay-secret",
            "OPENAI_BASE_URL": "https://get-codex.com/v1",
            "OPENAI_TRACING_API_KEY": "openai-tracing-secret",
            "OPENAI_AGENTS_TRACE_INCLUDE_SENSITIVE_DATA": "true",
        }

        with patch.dict("os.environ", env, clear=True):
            settings = AgentSettings.from_env()

        self.assertEqual(settings.provider, "deepseek")
        self.assertEqual(settings.model, "deepseek-chat")
        self.assertEqual(settings.model_base_url, "https://api.deepseek.com")
        self.assertEqual(settings.model_api_key, "deepseek-secret")
        self.assertEqual(settings.tracing_api_key, "openai-tracing-secret")
        self.assertTrue(settings.trace_include_sensitive_data)

    def test_tracing_key_falls_back_to_openai_key_for_compatibility(self):
        with patch.dict(
            "os.environ",
            {"OPENAI_API_KEY": "legacy-tracing-secret"},
            clear=True,
        ):
            settings = AgentSettings.from_env()

        self.assertEqual(settings.tracing_api_key, "legacy-tracing-secret")

    def test_tracing_key_rejects_embedded_whitespace(self):
        with patch.dict(
            "os.environ",
            {"OPENAI_TRACING_API_KEY": "sk-part-one\n  sk-part-two"},
            clear=True,
        ):
            with self.assertRaisesRegex(
                ValueError,
                "OPENAI_TRACING_API_KEY must not contain whitespace",
            ):
                AgentSettings.from_env()

    @patch("agent_service.model_provider.AsyncOpenAI")
    @patch("agent_service.model_provider.OpenAIChatCompletionsModel")
    def test_deepseek_model_uses_only_the_deepseek_key(
        self,
        model_class,
        client_class,
    ):
        settings = AgentSettings(
            provider="deepseek",
            model="deepseek-chat",
            model_base_url="https://api.deepseek.com",
            model_api_key="deepseek-secret",
            tracing_api_key="openai-tracing-secret",
        )

        create_model(settings)

        client_class.assert_called_once_with(
            api_key="deepseek-secret",
            base_url="https://api.deepseek.com",
        )
        model_class.assert_called_once_with(
            model="deepseek-chat",
            openai_client=client_class.return_value,
        )
        self.assertNotIn(
            "openai-tracing-secret",
            str(client_class.call_args),
        )


if __name__ == "__main__":
    unittest.main()
