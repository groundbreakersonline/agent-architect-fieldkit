/**
 * Metrics.
 *
 * Two rules govern everything here.
 *
 * 1. Latency is reported per stage and at p95, never as a mean. A mean hides the
 *    exact calls that make a caller say "are you still there".
 * 2. Cost is reported per resolved conversation, not per token. Tokens are an
 *    input; the number the business buys is the cost of an outcome.
 */
import type { Conversation, Metrics, VersionReport } from './types';

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export function computeMetrics(
  conversations: Conversation[],
  criticalIds: ReadonlySet<string>,
): Metrics {
  const n = conversations.length;
  if (n === 0) {
    return {
      conversations: 0,
      taskSuccessRate: 0,
      criticalPassRate: 0,
      toolCallCorrectness: 0,
      instructionAdherence: 0,
      escalationRate: 0,
      containmentRate: 0,
      p50TurnLatencyMs: 0,
      p95TurnLatencyMs: 0,
      p95SttMs: 0,
      p95LlmMs: 0,
      p95ToolMs: 0,
      p95TtsMs: 0,
      costPerResolutionUsd: 0,
      guardrailBreaches: 0,
    };
  }

  const passed = conversations.filter((c) => c.passed).length;
  const critical = conversations.filter((c) => criticalIds.has(c.scenarioId));
  const criticalPassed = critical.filter((c) => c.passed).length;

  // Tool-call correctness: did the conversation call exactly the tools the
  // scenario's tool expectations asked for, with nothing forbidden?
  let toolChecks = 0;
  let toolPasses = 0;
  let instructionChecks = 0;
  let instructionPasses = 0;
  let guardrailBreaches = 0;

  for (const c of conversations) {
    for (const r of c.results) {
      const k = r.expectation.kind;
      if (k === 'tool_called' || k === 'tool_not_called') {
        toolChecks += 1;
        if (r.pass) toolPasses += 1;
      }
      if (k === 'says' || k === 'never_says') {
        instructionChecks += 1;
        if (r.pass) instructionPasses += 1;
      }
      // A breach is a conversation that did something the business promised not to.
      if (k === 'never_says' && !r.pass) guardrailBreaches += 1;
      if (k === 'tool_not_called' && !r.pass) guardrailBreaches += 1;
    }
  }

  const resolved = conversations.filter((c) => c.passed);
  const pricingComplete = conversations.every((c) => c.costUsd !== null);
  const totalCost = pricingComplete
    ? conversations.reduce((sum, c) => sum + (c.costUsd ?? 0), 0)
    : null;

  return {
    conversations: n,
    taskSuccessRate: passed / n,
    criticalPassRate: critical.length ? criticalPassed / critical.length : 1,
    toolCallCorrectness: toolChecks ? toolPasses / toolChecks : 1,
    instructionAdherence: instructionChecks ? instructionPasses / instructionChecks : 1,
    escalationRate: conversations.filter((c) => c.escalated).length / n,
    containmentRate: conversations.filter((c) => !c.escalated).length / n,
    p50TurnLatencyMs: percentile(conversations.map((c) => c.latency.totalMs), 50),
    p95TurnLatencyMs: percentile(conversations.map((c) => c.latency.totalMs), 95),
    p95SttMs: percentile(conversations.map((c) => c.latency.sttMs), 95),
    p95LlmMs: percentile(conversations.map((c) => c.latency.llmMs), 95),
    p95ToolMs: percentile(conversations.map((c) => c.latency.toolMs), 95),
    p95TtsMs: percentile(conversations.map((c) => c.latency.ttsMs), 95),
    // Conversations that did not resolve still cost money. Dividing by resolved
    // conversations is the honest number.
    costPerResolutionUsd:
      totalCost === null ? null : resolved.length ? totalCost / resolved.length : totalCost,
    guardrailBreaches,
  };
}

export function summarise(report: VersionReport): string {
  const m = report.metrics;
  return [
    `${report.version} (${report.model})`,
    `task success ${(m.taskSuccessRate * 100).toFixed(1)}%`,
    `critical ${(m.criticalPassRate * 100).toFixed(1)}%`,
    `p95 ${m.p95TurnLatencyMs}ms`,
    `cost/resolution ${m.costPerResolutionUsd === null ? 'unpriced' : `$${m.costPerResolutionUsd.toFixed(4)}`}`,
  ].join(' | ');
}
