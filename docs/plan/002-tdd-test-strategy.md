# 妆迹 TDD 测试分级计划

Status: Draft
Date: 2026-09-05
Related spec: [09-05-phase-1-agent-runtime.md](../specs/09-05-phase-1-agent-runtime.md)

## 0. 当前状态

本次只建立测试目录占位，不新增测试用例、不新增测试 runner、不修改生产代码。后续所有功能实现遵循 Red-Green-Refactor：先写一个能证明需求的失败测试，确认失败原因正确，再写最小实现使其通过，最后在保持全绿的前提下重构。

## 1. 测试分级

### L1：代码层测试

目标是验证确定性的业务函数和边界，不调用真实模型或外部平台。

后续覆盖范围：

- `search-plan`：目标识别、澄清、医疗边界和淘宝查询词。
- 妆容拆解：证据到 `LookFeatureSet` 的结构化映射。
- SKU 推荐：产品能力到候选 SKU 的映射和排序。
- 妆匣匹配：可直接使用、部分匹配、不适合和缺口。
- 淘宝占位：未配置 API 时的 `placeholder` 状态和搜索链接。

测试位置：`test/L1/`

### L2：单节点 Prompt 测试

目标是验证单个 prompt/Agent node 的输入输出契约，不测试完整 workflow。

后续覆盖范围：

- prompt 能要求模型只输出约定的结构化对象。
- 证据不足时保留不确定性，不虚构来源。
- 工具失败时输出 `degraded` 语义。
- 医疗相关输入触发安全边界。
- 工具描述能引导模型选择正确工具。

测试位置：`test/L2/`

### L3：端到端测试

目标是验证 HTTP/SSE、Agent runner、工具调用、最终状态和可观测性之间的完整链路。

后续覆盖范围：

- 模型调用、工具调用、工具结果和最终回答完整流转。
- 前端收到 `status`、`chunk`、`tool`、`result` 或 `error` 事件。
- 最大 turn、超时、取消和重复调用保护生效。
- OpenAI tracing 与本地审计可以关联同一 run。
- Langfuse 不可用时主链路仍能完成。

测试位置：`test/L3/`

## 2. 实施顺序

1. 先补齐 L1 测试基础设施和纯函数测试。
2. 再实现并测试 L2 的单节点 prompt 契约。
3. 最后实现 L3 的 OpenAI Agent runner 和 SSE endpoint。
4. 每个级别完成后运行该级别及之前级别的全部测试。

## 3. 测试替身原则

- L1 使用固定输入和本地 fixture，不依赖网络、API key、实时价格或随机数据。
- L2 使用固定模型响应或可记录的模型适配器，不把模型偶然措辞作为主要断言。
- L3 只使用真实 HTTP API 和真实 OpenAI 调用；通过 `RUN_L3_E2E=1`、`OPENAI_API_KEY` 和 `RUNTIME_BASE_URL` 显式启用，避免普通测试误触发外部调用。
- 失败、降级和占位状态必须是结构化断言，不能只断言最终自然语言包含某个词。
- 不记录 API key、Cookie、完整用户资料或隐藏 chain-of-thought。

## 4. 阶段出口

- `test/L1/`、`test/L2/`、`test/L3/` 目录已建立。
- 每个测试级别都有独立的运行命令和失败定位方式。
- L1 纯函数测试达到稳定全绿后，才进入 L2。
- L2 prompt 契约稳定后，才进入 L3 runtime 集成。
- 阶段 1 spec 中的真实链路由 L3 smoke test 覆盖；runner 保护和失败分支由 L1 覆盖。
