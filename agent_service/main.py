import asyncio
import os
from pathlib import Path
from typing import Any, AsyncIterator, Dict

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .observability import langfuse_observability
from .runtime import RuntimeEngine, sse_block
from .sessions import ConversationOwnershipError

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

app = FastAPI(title="Looktrace Agent Runtime")
engine = RuntimeEngine()


@app.on_event("startup")
async def setup_observability() -> None:
    langfuse_observability.setup()


@app.get("/health")
async def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "service": "agent-runtime",
        "provider": "python-openai-agents",
        "observability": {
            "enabled": langfuse_observability.enabled,
            "authenticated": langfuse_observability.authenticated,
            "lastError": langfuse_observability.last_error,
        },
    }


async def _run_runtime(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "请求体不是有效 JSON。"}, status_code=400)
    if not isinstance(body, dict) or not isinstance(body.get("message"), str) or not body["message"].strip():
        return JSONResponse({"error": "请输入有效的消息。"}, status_code=400)

    # Identity is server-owned. The body userId is intentionally ignored.
    user_id = request.headers.get("x-user-id") or os.getenv("AGENT_DEFAULT_USER_ID", "local-user")
    if not isinstance(user_id, str) or not user_id.strip():
        return JSONResponse({"error": "无法确认当前用户。"}, status_code=401)
    conversation_id = body.get("conversationId")
    if conversation_id is not None and (not isinstance(conversation_id, str) or len(conversation_id) > 200):
        return JSONResponse({"error": "conversationId 无效。"}, status_code=400)
    if conversation_id:
        try:
            engine.sessions.ensure_conversation(user_id.strip(), conversation_id)
        except ConversationOwnershipError:
            return JSONResponse({"error": "无权访问该会话。"}, status_code=403)

    async def stream() -> AsyncIterator[str]:
        try:
            async for event in engine.stream(
                body["message"].strip(),
                conversation_id=conversation_id,
                user_id=user_id.strip(),
            ):
                yield sse_block(event)
        except asyncio.CancelledError:
            raise
        finally:
            langfuse_observability.flush()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/chat")
async def run_chat(request: Request):
    return await _run_runtime(request)


@app.post("/api/agent-runtime/spike")
async def run_runtime_compat(request: Request):
    """Temporary compatibility alias; the frontend uses /api/chat."""
    return await _run_runtime(request)
