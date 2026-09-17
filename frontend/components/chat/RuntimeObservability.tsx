import type { RuntimeObservation } from "@/frontend/lib/types";

export function RuntimeObservability({ observation }: { observation: RuntimeObservation | null }) {
  if (!observation) return null;

  const usage = observation.usage;
  return (
    <aside className="observability-panel" aria-label="Pi 运行观测">
      <div className="observability-header">
        <div>
          <p className="eyebrow">PI RUNTIME</p>
          <h2>执行观测</h2>
        </div>
        <span className="runtime-badge">{observation.provider} / {observation.model}</span>
      </div>

      <div className="observability-grid">
        <div><span>模型调用</span><strong>{observation.modelCallCount}</strong></div>
        <div><span>输入 tokens</span><strong>{usage.input ?? 0}</strong></div>
        <div><span>输出 tokens</span><strong>{usage.output ?? 0}</strong></div>
        <div><span>总 tokens</span><strong>{usage.totalTokens ?? 0}</strong></div>
      </div>

      <div className="observability-ids">
        <span title={observation.skillPath} className="skill-chip">技能 {observation.skillPath?.split("/").filter(Boolean).pop() ?? "-"}</span>
        <span title={observation.traceId}>trace {observation.traceId}</span>
        <span title={observation.agentRunId}>run {observation.agentRunId}</span>
      </div>

      <details className="prompt-details">
        <summary>查看实际提示词</summary>
        <div className="prompt-block"><span>system</span><pre>{observation.systemPrompt ?? "-"}</pre></div>
        <div className="prompt-block"><span>user</span><pre>{observation.userPrompt ?? "-"}</pre></div>
      </details>

      <div className="tool-timeline">
        <div className="timeline-heading"><span>工具时间线</span><strong>{observation.tools.length}</strong></div>
        {observation.tools.length === 0 ? <p className="empty-observation">尚未调用工具</p> : observation.tools.map((tool) => (
          <div className="tool-row" key={tool.toolCallId}>
            <span className={`tool-state ${tool.status}`} aria-hidden="true" />
            <div><strong>{tool.toolName}</strong><small>{tool.status === "running" ? "运行中" : tool.status === "succeeded" ? "完成" : "失败"}</small></div>
          </div>
        ))}
      </div>
    </aside>
  );
}
