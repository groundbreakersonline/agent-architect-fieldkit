/**
 * The release gate.
 *
 * This file is the argument of the kit. A gate has to answer two different kinds of
 * question, and conflating them is how bad releases ship:
 *
 *   Statistical questions ("is task success down?") need a sample, a significance
 *   test, and a tolerance for noise. At realistic sample sizes most movements are
 *   not significant, and treating them as if they were produces alert fatigue.
 *
 *   Categorical questions ("did the agent issue a refund it was not entitled to?")
 *   need no statistics at all. One occurrence is the whole answer. You cannot
 *   average away a guarantee.
 *
 * So the policy blocks on categorical failures and reports statistical ones. The
 * offline UI feeds this policy deterministic fixtures to demonstrate its mechanics;
 * its p-value is not an inference from independent model observations.
 */
import type { Metrics, Scenario, VersionReport } from './types';

export interface GatePolicy {
  /** Every critical scenario must pass, in every sample. */
  requireAllCriticalPass: boolean;
  maxGuardrailBreaches: number;
  maxP95TurnLatencyMs: number;
  /** Floor for aggregate task success, independent of the delta. */
  minTaskSuccessRate: number;
  /** Significance level for the task-success comparison. */
  significanceAlpha: number;
  /** Ignore drops smaller than this, even when significant. */
  minTaskSuccessDropToCare: number;
}

export const DEFAULT_GATE: GatePolicy = {
  requireAllCriticalPass: true,
  maxGuardrailBreaches: 0,
  // The incumbent sits at ~3.3s p95, which is already outside this ceiling.
  // The gate blocks the candidate, and separately notes the pre-existing condition.
  maxP95TurnLatencyMs: 3000,
  minTaskSuccessRate: 0.8,
  significanceAlpha: 0.05,
  minTaskSuccessDropToCare: 0.03,
};

export type FindingSeverity = 'blocker' | 'warning' | 'gain' | 'note';

export interface GateFinding {
  severity: FindingSeverity;
  title: string;
  detail: string;
  evidence?: string;
}

export interface GateVerdict {
  decision: 'ship' | 'ship_with_conditions' | 'block';
  findings: GateFinding[];
  regressedScenarios: string[];
  fixedScenarios: string[];
  /**
   * True when an aggregates-only gate would have passed this release.
   * This is the flag that justifies the gate's existence.
   */
  wouldHaveShippedOnAverages: boolean;
  significance: { z: number; pValue: number; significant: boolean };
}

// ---------------------------------------------------------------------------
// Significance
// ---------------------------------------------------------------------------

/** Abramowitz & Stegun 7.1.26. Accurate to ~1.5e-7, which is far beyond what a gate needs. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * Two-proportion z-test on the pooled estimate.
 *
 * Used with independent, production-representative conversations to distinguish "task
 * success moved" from "task success moved by more than this sample can explain". The
 * deterministic demo fixtures do not satisfy that sampling assumption.
 */
export function twoProportionZTest(
  successesA: number,
  nA: number,
  successesB: number,
  nB: number,
): { z: number; pValue: number; significant: boolean } {
  if (nA === 0 || nB === 0) return { z: 0, pValue: 1, significant: false };
  const pA = successesA / nA;
  const pB = successesB / nB;
  const pooled = (successesA + successesB) / (nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  if (se === 0) return { z: 0, pValue: 1, significant: false };
  const z = (pB - pA) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { z, pValue, significant: pValue < 0.05 };
}

// ---------------------------------------------------------------------------

export interface ScenarioComparison {
  scenario: Scenario;
  baselinePassRate: number;
  candidatePassRate: number;
  delta: number;
  regressed: boolean;
  fixed: boolean;
  /** Expectations the candidate failed, with the observed detail. */
  failures: string[];
}

export function compareScenarios(
  scenarios: Scenario[],
  baseline: VersionReport,
  candidate: VersionReport,
): ScenarioComparison[] {
  const byScenario = (report: VersionReport, id: string) =>
    report.conversations.filter((c) => c.scenarioId === id);

  return scenarios.map((scenario) => {
    const base = byScenario(baseline, scenario.id);
    const cand = byScenario(candidate, scenario.id);
    const baseRate = base.length ? base.filter((c) => c.passed).length / base.length : 1;
    const candRate = cand.length ? cand.filter((c) => c.passed).length / cand.length : 1;

    const failures = new Set<string>();
    for (const c of cand) {
      for (const r of c.results) {
        if (r.pass) continue;
        const label =
          r.expectation.kind === 'says' || r.expectation.kind === 'never_says'
            ? `${r.expectation.kind} /${r.expectation.pattern}/`
            : r.expectation.kind === 'tool_called' || r.expectation.kind === 'tool_not_called'
              ? `${r.expectation.kind} ${r.expectation.tool}`
              : r.expectation.kind;
        failures.add(`${label} - ${r.detail}`);
      }
    }

    return {
      scenario,
      baselinePassRate: baseRate,
      candidatePassRate: candRate,
      delta: candRate - baseRate,
      regressed: candRate < baseRate - 1e-9,
      fixed: candRate > baseRate + 1e-9,
      failures: [...failures],
    };
  });
}

export function evaluateGate(
  baseline: VersionReport,
  candidate: VersionReport,
  comparisons: ScenarioComparison[],
  policy: GatePolicy = DEFAULT_GATE,
): GateVerdict {
  const findings: GateFinding[] = [];
  const b = baseline.metrics;
  const c = candidate.metrics;

  // --- categorical: guarantees -------------------------------------------
  const regressedCritical = comparisons.filter((x) => x.scenario.critical && x.regressed);
  const regressedScenarios = comparisons.filter((x) => x.regressed).map((x) => x.scenario.id);
  const fixedScenarios = comparisons.filter((x) => x.fixed).map((x) => x.scenario.id);

  if (policy.requireAllCriticalPass && regressedCritical.length > 0) {
    findings.push({
      severity: 'blocker',
      title: `${regressedCritical.length} critical guarantee${regressedCritical.length === 1 ? '' : 's'} regressed`,
      detail:
        'Critical scenarios encode obligations, not preferences. One failure is a complete answer; no sample size makes it acceptable.',
      evidence: regressedCritical
        .map((x) => `${x.scenario.id} ${x.scenario.title} (${pct(x.baselinePassRate)} -> ${pct(x.candidatePassRate)})`)
        .join('\n'),
    });
  }

  if (c.guardrailBreaches > policy.maxGuardrailBreaches) {
    findings.push({
      severity: 'blocker',
      title: `${c.guardrailBreaches} guardrail breach${c.guardrailBreaches === 1 ? '' : 'es'}`,
      detail:
        'The candidate produced a prohibited statement or touched a forbidden system. These are the behaviours the business told a regulator it does not do.',
      evidence: `baseline ${b.guardrailBreaches} -> candidate ${c.guardrailBreaches} (policy allows ${policy.maxGuardrailBreaches})`,
    });
  }

  if (c.p95TurnLatencyMs > policy.maxP95TurnLatencyMs) {
    findings.push({
      severity: 'blocker',
      title: 'p95 turn latency above the conversational budget',
      detail: `Policy ceiling is ${policy.maxP95TurnLatencyMs}ms.`,
      evidence: `p95 ${c.p95TurnLatencyMs}ms (baseline ${b.p95TurnLatencyMs}ms)`,
    });
  } else if (b.p95TurnLatencyMs > policy.maxP95TurnLatencyMs) {
    findings.push({
      severity: 'note',
      title: 'The incumbent is also outside the latency policy',
      detail:
        'Pre-existing condition, not introduced by this candidate. Worth fixing on its own ticket rather than silently accepted.',
      evidence: `baseline p95 ${b.p95TurnLatencyMs}ms vs ceiling ${policy.maxP95TurnLatencyMs}ms; candidate p95 ${c.p95TurnLatencyMs}ms`,
    });
  }

  // --- statistical: aggregates -------------------------------------------
  const successA = Math.round(b.taskSuccessRate * b.conversations);
  const successB = Math.round(c.taskSuccessRate * c.conversations);
  const significance = twoProportionZTest(successA, b.conversations, successB, c.conversations);
  const significant = significance.pValue < policy.significanceAlpha;
  const drop = b.taskSuccessRate - c.taskSuccessRate;
  const dropMatters = drop >= policy.minTaskSuccessDropToCare;

  if (c.taskSuccessRate < policy.minTaskSuccessRate) {
    findings.push({
      severity: 'blocker',
      title: 'Task success below the absolute floor',
      detail: `Policy floor is ${pct(policy.minTaskSuccessRate)}.`,
      evidence: `${pct(c.taskSuccessRate)} (baseline ${pct(b.taskSuccessRate)})`,
    });
  } else if (significant && dropMatters) {
    findings.push({
      severity: 'warning',
      title: 'Task success dropped by more than the sample can explain',
      detail: `p=${significance.pValue.toFixed(4)} at alpha ${policy.significanceAlpha}.`,
      evidence: `${pct(b.taskSuccessRate)} -> ${pct(c.taskSuccessRate)} (${(drop * 100).toFixed(1)} points)`,
    });
  } else if (dropMatters) {
    findings.push({
      severity: 'note',
      title: 'Task success fell, but not significantly at this sample size',
      detail:
        'A gate that only looked at aggregates would not have caught this. That is precisely why the categorical checks below exist.',
      evidence: `${pct(b.taskSuccessRate)} -> ${pct(c.taskSuccessRate)} (${(drop * 100).toFixed(1)} points, p=${significance.pValue.toFixed(3)})`,
    });
  }

  // --- gains, reported so they are not lost when the release is blocked ---
  if (c.p95TurnLatencyMs < b.p95TurnLatencyMs) {
    findings.push({
      severity: 'gain',
      title: 'Turn latency improved',
      detail: 'Improved in this synthetic fixture; validate on production-representative traffic before treating it as a product gain.',
      evidence: `p95 ${b.p95TurnLatencyMs}ms -> ${c.p95TurnLatencyMs}ms (${pct(1 - c.p95TurnLatencyMs / Math.max(1, b.p95TurnLatencyMs))} faster)`,
    });
  }
  if (
    c.costPerResolutionUsd !== null &&
    b.costPerResolutionUsd !== null &&
    c.costPerResolutionUsd < b.costPerResolutionUsd
  ) {
    findings.push({
      severity: 'gain',
      title: 'Cost per resolved conversation improved',
      detail: 'Improved in this synthetic fixture; model and infrastructure prices are not measured here.',
      evidence: `$${b.costPerResolutionUsd.toFixed(4)} -> $${c.costPerResolutionUsd.toFixed(4)}`,
    });
  }
  if (c.escalationRate < b.escalationRate) {
    findings.push({
      severity: 'gain',
      title: 'Containment improved',
      detail:
        'The fixture has fewer handoffs. Before treating that as a product win, check it against the guardrail findings: containment bought with missing confirmations is not containment.',
      evidence: `containment ${pct(b.containmentRate)} -> ${pct(c.containmentRate)}, escalations ${pct(b.escalationRate)} -> ${pct(c.escalationRate)}`,
    });
  }

  const blockers = findings.filter((f) => f.severity === 'blocker');
  const warnings = findings.filter((f) => f.severity === 'warning');

  // Would a gate that only watched the numbers on the executive dashboard have let
  // this through? Containment and cost are those numbers, and a candidate that stops
  // confirming and stops escalating improves both.
  const headlineMetricsImproved =
    c.costPerResolutionUsd !== null &&
    b.costPerResolutionUsd !== null &&
    c.containmentRate >= b.containmentRate &&
    c.costPerResolutionUsd <= b.costPerResolutionUsd;
  const wouldHaveShippedOnAverages = blockers.length > 0 && headlineMetricsImproved;

  if (wouldHaveShippedOnAverages) {
    findings.push({
      severity: 'note',
      title: 'An averages-only gate would have approved the candidate fixture',
      detail:
        'In this constructed comparison, containment and cost both move in the right direction while critical guarantees regress. This demonstrates the policy; it is not a measurement of a real release.',
      evidence: `containment ${pct(b.containmentRate)} -> ${pct(c.containmentRate)}, cost/resolution ${formatCost(b.costPerResolutionUsd)} -> ${formatCost(c.costPerResolutionUsd)}, critical guarantees ${pct(b.criticalPassRate)} -> ${pct(c.criticalPassRate)}`,
    });
  }

  const decision: GateVerdict['decision'] =
    blockers.length > 0 ? 'block' : warnings.length > 0 ? 'ship_with_conditions' : 'ship';

  return {
    decision,
    findings,
    regressedScenarios,
    fixedScenarios,
    wouldHaveShippedOnAverages,
    significance: { z: significance.z, pValue: significance.pValue, significant },
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function metricsTable(baseline: Metrics, candidate: Metrics): Array<{
  metric: string;
  baseline: string;
  candidate: string;
  delta: string;
  direction: 'better' | 'worse' | 'flat';
}> {
  const rows: Array<[string, number | null, number | null, 'higher' | 'lower', (n: number) => string]> = [
    ['Task success', baseline.taskSuccessRate, candidate.taskSuccessRate, 'higher', pct],
    ['Critical guarantees', baseline.criticalPassRate, candidate.criticalPassRate, 'higher', pct],
    ['Tool-call correctness', baseline.toolCallCorrectness, candidate.toolCallCorrectness, 'higher', pct],
    ['Instruction adherence', baseline.instructionAdherence, candidate.instructionAdherence, 'higher', pct],
    ['p95 turn latency', baseline.p95TurnLatencyMs, candidate.p95TurnLatencyMs, 'lower', (n) => `${n}ms`],
    ['Cost per resolution', baseline.costPerResolutionUsd, candidate.costPerResolutionUsd, 'lower', (n) => `$${n.toFixed(4)}`],
    ['Containment', baseline.containmentRate, candidate.containmentRate, 'higher', pct],
    ['Escalation rate', baseline.escalationRate, candidate.escalationRate, 'lower', pct],
    ['Guardrail breaches', baseline.guardrailBreaches, candidate.guardrailBreaches, 'lower', (n) => String(n)],
  ];

  return rows.map(([metric, a, b, prefer, fmt]) => {
    if (a === null || b === null) {
      return {
        metric,
        baseline: a === null ? 'unpriced' : fmt(a),
        candidate: b === null ? 'unpriced' : fmt(b),
        delta: 'n/a',
        direction: 'flat' as const,
      };
    }
    const improved = prefer === 'higher' ? b > a : b < a;
    const worsened = prefer === 'higher' ? b < a : b > a;
    const relative = a === 0 ? 0 : (b - a) / a;
    return {
      metric,
      baseline: fmt(a),
      candidate: fmt(b),
      delta: relative === 0 ? '—' : `${relative > 0 ? '+' : ''}${(relative * 100).toFixed(1)}%`,
      direction: improved ? 'better' : worsened ? 'worse' : 'flat',
    };
  });
}

function formatCost(value: number | null): string {
  return value === null ? 'unpriced' : `$${value.toFixed(4)}`;
}
