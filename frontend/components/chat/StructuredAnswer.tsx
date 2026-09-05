import {
  ClipboardList,
  ExternalLink,
  PackageCheck,
  Plus,
  Search,
  Sparkles
} from "lucide-react";
import type { AgentAnswer, SkuCandidate } from "@/lib/types/domain";

type StructuredAnswerProps = {
  answer: AgentAnswer;
  onCandidateToLibrary: (candidate: SkuCandidate) => void;
};

export function StructuredAnswer({ answer, onCandidateToLibrary }: StructuredAnswerProps) {
  if (!answer.searchPlan.isClearEnough) {
    return <p className="message-text">{answer.answerText}</p>;
  }

  const topCandidates = answer.skuCandidates.slice(0, 5);
  const missingCapabilities = answer.ownedProductMatch.missingCapabilities;

  return (
    <div className="answer-card">
      <p className="answer-lead">
        我先按「{answer.lookFeatures.overallStyle}」来拆。参考来源于互联网；先看妆容共同点，再落到化妆品品类和 SKU。
      </p>

      <section className="answer-section">
        <SectionHeading icon={<Search size={16} />} title="本轮参考" />
        <p className="source-copy">
          参考来源于互联网。淘宝用于补全候选 SKU 的价格、渠道和购买入口。
        </p>
      </section>

      <section className="answer-section">
        <SectionHeading icon={<ClipboardList size={16} />} title="妆容特点" />
        <div className="feature-grid">
          <Feature label="底妆" values={answer.lookFeatures.base} />
          <Feature label="眉眼" values={[...answer.lookFeatures.eyes, ...answer.lookFeatures.brows]} />
          <Feature label="腮红唇部" values={[...answer.lookFeatures.cheeks, ...answer.lookFeatures.lips]} />
          <Feature label="质地重心" values={[...answer.lookFeatures.texture, ...answer.lookFeatures.focus]} />
        </div>
      </section>

      <section className="answer-section">
        <SectionHeading icon={<PackageCheck size={16} />} title="妆匣核对" />
        <div className="match-row">
          <Metric label="可用" value={answer.ownedProductMatch.usableItems.length} />
          <Metric label="可替" value={answer.ownedProductMatch.partialMatches.length} />
          <Metric label="缺口" value={missingCapabilities.length} />
        </div>
        <p className="source-copy">
          {answer.ownedProductMatch.reviewed
            ? `我看了你的妆匣，当前还缺 ${missingCapabilities.length} 类能力。`
            : "你还没有录入妆匣，所以本轮直接按目标妆效给 SKU 候选。"}
        </p>
      </section>

      <section className="answer-section">
        <SectionHeading icon={<Sparkles size={16} />} title="SKU 候选" />
        <div className="candidate-list">
          {topCandidates.map((candidate) => (
            <article className="candidate-card" key={candidate.id}>
              <div className="candidate-main">
                <span className={`swatch ${candidate.colorFamily?.includes("粉") ? "rose" : ""}`} />
                <div>
                  <strong>{candidate.brand} {candidate.name}</strong>
                  <span>{candidate.category} · {candidate.shade ?? candidate.colorFamily ?? "按目标色系选"}</span>
                </div>
              </div>
              <p>{candidate.reason}</p>
              <div className="candidate-actions">
                {candidate.purchaseUrl ? (
                  <a className="link-button" href={candidate.purchaseUrl} target="_blank" rel="noreferrer">
                    <ExternalLink size={14} />
                    淘宝
                  </a>
                ) : null}
                <button type="button" onClick={() => onCandidateToLibrary(candidate)}>
                  <Plus size={14} />
                  妆匣
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function SectionHeading({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="section-heading">
      {icon}
      <h3>{title}</h3>
    </div>
  );
}

function Feature({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="feature-card">
      <span>{label}</span>
      <p>{values.slice(0, 4).join("、") || "待确认"}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
