# Looktrace Agent Service

Phase 1 is a single-agent OpenAI Agents SDK service. It searches read-only
Xiaohongshu evidence through MCP, streams the real SDK run, and uses OpenAI
Tracing for observability. DeepSeek performs model inference; OpenAI only
receives trace exports.

Last updated: 2026-09-10.

## Execution map

```text
POST /api/chat
  -> main.py validates HTTP input and opens SSE
  -> LooktraceWorkflow.stream()
     -> opens trace: looktrace.phase1
     -> Runner.run_streamed()
        -> Looktrace Agent
           -> DeepSeek chat completions model
           -> search_xhs_evidence(query)
              -> XhsMcpClient.search()
                 -> check_login_status (startup only)
                 -> search_feeds
                 -> get_feed_detail
     -> maps SDK events to application events
     -> validates the final model text
     -> wraps it in the Phase 1 API schema
     -> attaches sources from actual MCP results
     -> emits one terminal result
```

The orchestration is intentionally explicit in `workflow.py`. The SDK owns the
model/tool loop; the workflow owns application events, timeouts, cancellation,
result assembly, and error mapping.

## Module responsibilities

| Module | Responsibility |
| --- | --- |
| `main.py` | FastAPI routes, request validation, SSE, resource lifecycle |
| `workflow.py` | Visible run orchestration and final status mapping |
| `looktrace_agent.py` | Agent definition and the single business tool |
| `model_provider.py` | DeepSeek client and Agents SDK model adapter |
| `events.py` | Stable SDK-event-to-SSE contract |
| `xhs_integration.py` | MCP connection, read-only allowlist, retries, error mapping |
| `xhs_content.py` | Pure MCP payload parsing, sanitization, and size limits |
| `schemas.py` | Phase 1 context, tool results, and typed API answer |
| `config.py` | Environment-backed runtime settings |
| `prompts.py` | Agent instructions only |

## Agent boundary

The Agent sees one function tool: `search_xhs_evidence(query)`. The upstream MCP
server is not attached directly because it exposes write-capable tools and its
search response contains a temporary `xsec_token` needed for detail lookup.

`XhsMcpClient` is the only component allowed to call:

- `check_login_status`
- `search_feeds`
- `get_feed_detail`

It returns typed, bounded `XhsSearchResult` data. Tokens, cookies, authorization
values, internal exceptions, and unsupported fields are removed before the tool
result reaches the Agent.

## Workflow events

The browser depends only on these application events, never SDK-private names:

```text
run_started    { run, conversation }
status         { phase, message }
text_delta     { text }
tool_started   { toolName, callId, inputSummary }
tool_finished  { toolName, callId, status, outputSummary, errorCode }
result         { answer, answerText, status, run }
error          { code, message }
```

`result.answer` follows `looktrace.answer.v1`. DeepSeek returns normal text
because its current Chat Completions endpoint rejects the SDK's structured
`response_format`. The workflow validates that text, wraps it in the typed API
schema, and adds source references only from the MCP result stored in the
server-side run context.

## OpenAI Tracing

Model and tracing credentials have separate responsibilities:

- `DEEPSEEK_API_KEY` is passed only to the DeepSeek `AsyncOpenAI` client.
- `OPENAI_TRACING_API_KEY` is passed only through the Agents SDK tracing config.
- `OPENAI_API_KEY` is only a compatibility fallback for tracing; use the
  dedicated variable when the global OpenAI client points at a relay.
- The model is constructed explicitly as an `OpenAIChatCompletionsModel`; the
  SDK never resolves `deepseek-chat` through its default OpenAI model provider.
- Agents SDK 0.22.2 exports traces directly to
  `https://api.openai.com/v1/traces/ingest`; `OPENAI_BASE_URL` does not change
  that endpoint.

Each request creates one trace with:

- workflow: `looktrace.phase1`
- group ID: `conversationId`
- metadata: opaque run, message, conversation, user, and XHS mode identifiers
- model/tool payload capture controlled by
  `OPENAI_AGENTS_TRACE_INCLUDE_SENSITIVE_DATA`

For local debugging, set:

```env
OPENAI_AGENTS_TRACE_INCLUDE_SENSITIVE_DATA="true"
```

With this enabled, Generation spans contain the complete model message sequence
and output, including Agent instructions. Function spans contain tool arguments
and results. In MCP mode, this also uploads the cleaned Xiaohongshu post and
comment content used by the model. Keep it disabled in environments where that
data must not leave the application boundary.

The SDK records the Agent, model, and function-tool spans. The XHS tool adds an
`xhs_mcp.search` custom span containing only operational fields: query length,
status, post count, detail failure count, and truncation state.

The SSE `run.traceId` identifies the corresponding trace in the OpenAI Platform
trace view.

## Conversation state

Phase 1 does not use an SDK session. Persisting the full tool transcript would
also persist raw post and comment context. `conversationId` currently groups
traces only; a later phase can add a separately designed redacted memory format.

## Setup

```bash
python3 -m venv .venv
./.venv/bin/python -m pip install -r agent_service/requirements.txt
cp .env.example .env
```

Required live configuration:

```env
AGENT_MODEL_PROVIDER="deepseek"
AGENT_MODEL="deepseek-chat"
AGENT_MODEL_BASE_URL="https://api.deepseek.com"
DEEPSEEK_API_KEY="..."
OPENAI_TRACING_API_KEY="..." # official OpenAI Platform key
OPENAI_AGENTS_TRACE_INCLUDE_SENSITIVE_DATA="false"
AGENT_TIMEOUT_SECONDS="180"
XHS_SOURCE_MODE="mcp"
XHS_MCP_URL="http://127.0.0.1:18060/mcp"
XHS_MCP_AUTH_TOKEN=""
XHS_MCP_REQUEST_TIMEOUT_SECONDS="75"
XHS_MCP_SSE_READ_TIMEOUT_SECONDS="120"
XHS_MCP_SEARCH_LIMIT="5"
XHS_MCP_DETAIL_LIMIT="2"
```

Start and log in to the Xiaohongshu MCP service before the Agent service.

```bash
npm run xhs:login
npm run xhs:mcp
npm run agent:dev
```

`xhs:mcp` keeps the upstream process output visible while redacting temporary
`xsec_token` query parameters from feed-detail URLs. The upstream browser may
take about 40 seconds for one search plus two detail reads. One failed search is
retried once on the existing MCP connection, so the Agent timeout is 180 seconds.

Health information is available at `GET /health`, including MCP connection,
login, and last safe error code.

## Tests

```bash
npm run test:python
npm test
npm run typecheck
npm run build
```

Unit tests use injected MCP servers and Runner streams. `XHS_SOURCE_MODE=mock` is
only for isolated tests and local UI work; mock evidence always produces a
`degraded` final result and is never used as fallback after an MCP failure.

The optional L3 test requires a running, logged-in XHS MCP service,
`DEEPSEEK_API_KEY`, `OPENAI_TRACING_API_KEY`, and `XHS_SOURCE_MODE=mcp`.
