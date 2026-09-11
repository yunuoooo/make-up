import unittest

from fastapi.testclient import TestClient

from agent_service.events import WorkflowEvent
from agent_service.main import create_app


class FakeLifecycle:
    def __init__(self) -> None:
        self.started = False
        self.closed = False

    async def __aenter__(self):
        self.started = True
        return self

    async def __aexit__(self, *_exc_info: object) -> None:
        self.closed = True


class FakeWorkflow:
    def health(self) -> dict:
        return {"ok": True, "tracing": "openai", "xhs": {"mode": "mock"}}

    async def stream(self, *, message: str, user_id: str, conversation_id: str | None):
        self.request = {
            "message": message,
            "user_id": user_id,
            "conversation_id": conversation_id,
        }
        run = {
            "traceId": "trace_1",
            "agentRunId": "run_1",
            "conversationId": conversation_id or "conv_1",
            "messageId": "msg_1",
        }
        yield WorkflowEvent("run_started", {"run": run})
        yield WorkflowEvent(
            "result",
            {
                "answer": {
                    "schema_version": "looktrace.answer.v1",
                    "status": "succeeded",
                    "answer_text": "完成",
                },
                "answerText": "完成",
                "status": "succeeded",
                "run": run,
            },
        )


class ApiTests(unittest.TestCase):
    def test_chat_endpoint_only_adapts_http_to_workflow_events(self):
        workflow = FakeWorkflow()
        lifecycle = FakeLifecycle()
        app = create_app(workflow=workflow, lifecycle=lifecycle)

        with TestClient(app) as client:
            health = client.get("/health")
            response = client.post(
                "/api/chat",
                headers={"x-user-id": "user_a"},
                json={"message": "  通勤妆  ", "conversationId": "conv_1"},
            )

        self.assertTrue(lifecycle.started)
        self.assertTrue(lifecycle.closed)
        self.assertEqual(health.json()["tracing"], "openai")
        self.assertEqual(workflow.request["message"], "通勤妆")
        self.assertEqual(workflow.request["user_id"], "user_a")
        self.assertIn("event: run_started", response.text)
        self.assertIn("event: result", response.text)

    def test_chat_endpoint_rejects_invalid_input_before_workflow(self):
        app = create_app(workflow=FakeWorkflow(), lifecycle=FakeLifecycle())

        with TestClient(app) as client:
            response = client.post("/api/chat", json={"message": " "})

        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
