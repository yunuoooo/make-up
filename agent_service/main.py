from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .config import AgentSettings
from .events import to_sse
from .workflow import LooktraceWorkflow
from .xhs_integration import XhsMcpClient


load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def create_app(
    *,
    workflow: LooktraceWorkflow | None = None,
    lifecycle: XhsMcpClient | None = None,
) -> FastAPI:
    if workflow is None:
        settings = AgentSettings.from_env()
        xhs = XhsMcpClient(settings.xhs)
        workflow = LooktraceWorkflow(settings, xhs)
        lifecycle = xhs

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if lifecycle is None:
            yield
            return
        async with lifecycle:
            yield

    app = FastAPI(title="Looktrace Agent Runtime", lifespan=lifespan)

    @app.get("/health")
    async def health():
        return workflow.health()

    async def run_chat(request: Request):
        body = await _read_request_body(request)
        if isinstance(body, JSONResponse):
            return body

        message = body.get("message")
        if not isinstance(message, str) or not message.strip():
            return JSONResponse({"error": "请输入有效的消息。"}, status_code=400)
        conversation_id = body.get("conversationId")
        if conversation_id is not None and (
            not isinstance(conversation_id, str)
            or not conversation_id
            or len(conversation_id) > 200
        ):
            return JSONResponse({"error": "conversationId 无效。"}, status_code=400)

        user_id = request.headers.get("x-user-id") or os.getenv(
            "AGENT_DEFAULT_USER_ID",
            "local-user",
        )

        async def events() -> AsyncIterator[str]:
            async for event in workflow.stream(
                message=message.strip(),
                user_id=user_id,
                conversation_id=conversation_id,
            ):
                yield to_sse(event)

        return StreamingResponse(
            events(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    app.post("/api/chat")(run_chat)
    app.post("/api/agent-runtime/spike")(run_chat)
    return app


async def _read_request_body(request: Request) -> dict[str, Any] | JSONResponse:
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "请求体不是有效 JSON。"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "请求体不是有效 JSON。"}, status_code=400)
    return body


app = create_app()
