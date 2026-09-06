# Looktrace Python Agent Service

Python 3.10+ is recommended. Python 3.9 is supported through the
`eval-type-backport` compatibility dependency.

Run locally from the repository root:

```bash
python3 -m venv .venv-agent
. .venv-agent/bin/activate
pip install -r agent_service/requirements.txt
python3 -m uvicorn agent_service.main:app --host 127.0.0.1 --port 8000
```

The service loads the repository `.env` automatically. The Next.js route proxies
`/api/chat` to `AGENT_SERVICE_URL` (default `http://127.0.0.1:8000`).
`/api/agent-runtime/spike` remains a compatibility alias during migration.
Set `DEEPSEEK_API_KEY` (or `OPENAI_API_KEY` if that is where your DeepSeek key is
stored) with `AGENT_MODEL_PROVIDER=deepseek`. For OpenAI, set
`AGENT_MODEL_PROVIDER=openai` and use `OPENAI_API_KEY`.

Langfuse tracing is enabled when `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`,
and optionally `LANGFUSE_BASE_URL` are configured. Missing or failed observability
configuration never blocks an Agent request.

Set `LANGFUSE_TRACING_ENVIRONMENT` (for example, `development` or `production`)
to filter traces by deployment environment. Each live Agent run exports an Agent
trace with the workflow name `looktrace.chat.turn`, the model generation/tool
children from OpenInference, and user/session/tags/metadata context. By default,
the root observation retains only safe counts and status fields, and the Agents
SDK trace excludes sensitive content. Set `LANGFUSE_TRACE_INCLUDE_SENSITIVE_DATA=1`
only in a controlled environment when full inputs and outputs are required for
debugging. This setting does not disable tracing or observation visibility.
The run payload includes `langfuseTraceId`, which can be used directly with the
Langfuse CLI or UI; `traceId` retains the Agents SDK `trace_` prefix.

The runtime uses `Runner.run_streamed()` and an SDK `SQLiteSession` database at
`.local-data/agent-sessions.sqlite` by default. The session key is scoped as
`userId:conversationId`; production deployments should set
`AGENT_SESSION_DB_PATH` to a shared, backed-up store. OpenAI uses native
structured output. DeepSeek currently does not support the SDK JSON Schema
response format, so it uses a JSON contract prompt and application-layer
Pydantic validation; unverifiable results are marked `degraded`.
