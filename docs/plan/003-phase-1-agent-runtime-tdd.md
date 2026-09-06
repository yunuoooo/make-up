# 阶段 1 Agent Runtime TDD Plan

Status: Active
Date: 2026-09-05
Related spec: [09-05-phase-1-agent-runtime.md](../specs/09-05-phase-1-agent-runtime.md)

## 目标

用 Python OpenAI Agents SDK 完成一次服务端 Agent 最小闭环：模型可以直接回答，也可以调用 `mock_lookup`，读取结构化工具结果后继续回答；Next.js 代理输出稳定 SSE，暴露脱敏后的状态、增量文本和终态。

## TDD 顺序

1. **RED：runtime contracts（L1）**
   - 固定 `AgentRuntimeContext` 的四个关联 ID 和服务端运行预算。
   - 固定 `mock_lookup` 成功、空结果和异常转换契约。
   - 固定 direct-answer、tool-call、tool-failure、duplicate-call、turn-limit、timeout/cancel 六类终态。
   - 固定 Runtime Event 到 SSE 的事件名和响应头。
2. **GREEN：runtime core（L1）**
   - 实现 `agent_service/runtime.py`、`agent_service/main.py` 和 Python Agents SDK 模型适配。
   - 仅允许服务端配置提供 `maxTurns`/`timeoutMs`，工具输入只包含 `query`。
   - 用 AbortController、turn 计数和同输入保护收敛运行；内部异常转换为公开错误码。
3. **GREEN：HTTP/SSE（L3）**
   - 新增 FastAPI `POST /api/agent-runtime/spike`，Next.js 同路径代理并转发事件。
   - 只发送 `status`、`chunk`、`tool`、`result`、`error`，不发送原始 SDK 对象、工具 JSON 或堆栈。
4. **OBSERVABILITY：best effort**
   - OpenAI tracing 与 Langfuse 使用窄适配接口；配置缺失或 flush 失败不阻塞主链路。
   - 本地 runtime audit 记录关联 ID、turn/tool 计数、耗时、终态和错误码。
5. **VERIFY**
   - L1 运行本地纯代码测试；L3 只运行真实 HTTP + OpenAI smoke test。
   - L3 通过 `RUN_L3_E2E=1` 和 Python 服务的模型 API key 显式启用，服务地址由 `RUNTIME_BASE_URL` 指定。
   - 最后运行 `npm run typecheck` 和 `npm run build`。

## 测试映射

| Case | 测试重点 | 预期终态 |
| --- | --- | --- |
| RUNTIME-001 | L3 真实 API：模型选择 `mock_lookup`，结果影响最终文本 | `succeeded` |
| RUNTIME-002 | L3 真实 API：模型直接回答 | `succeeded` |
| RUNTIME-003 | L1 runner：工具返回结构化失败 | `degraded` 或 `failed` |
| RUNTIME-004 | L1 runner：相同工具输入重复调用 | `limit_exceeded` |
| RUNTIME-005 | L1 runner：超过最大 turn | `limit_exceeded` |
| RUNTIME-006 | L1 runner：模型超时或请求取消 | `failed`，含公开错误码 |

## 边界

本批次不接入真实小红书、淘宝、数据库或长期会话；SDK 原始事件只存在于 runner adapter 内，业务层依赖稳定的应用事件类型。
