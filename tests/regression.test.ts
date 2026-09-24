import { describe, expect, it } from 'vitest';
import { runRegressionSuite, failingScenarios } from '../src/core/regression/runner';
import { DEFAULT_GATE, normalCdf, twoProportionZTest } from '../src/core/regression/gate';
import { SCENARIOS } from '../src/core/regression/scenarios';
import { percentile } from '../src/core/regression/metrics';
import { V27, V28 } from '../src/core/regression/agent';

const run = runRegressionSuite({ samples: 5 });

describe('regression: suite shape', () => {
  it('covers both versions at the configured sample size', () => {
    expect(run.conversationsPerVersion).toBe(SCENARIOS.length * 5);
    expect(run.baseline.conversations).toHaveLength(run.conversationsPerVersion);
    expect(run.candidate.conversations).toHaveLength(run.conversationsPerVersion);
  });

  it('is deterministic for a fixed seed', () => {
    const again = runRegressionSuite({ samples: 5 });
    expect(again.candidate.metrics.taskSuccessRate).toBe(run.candidate.metrics.taskSuccessRate);
    expect(again.verdict.decision).toBe(run.verdict.decision);
  });

  it('contains a meaningful proportion of critical scenarios', () => {
    const critical = SCENARIOS.filter((s) => s.critical).length;
    expect(critical).toBeGreaterThanOrEqual(8);
    expect(critical).toBeLessThan(SCENARIOS.length);
  });
});

describe('regression: the release candidate', () => {
  it('improves latency and cost', () => {
    expect(run.candidate.metrics.p95TurnLatencyMs).toBeLessThan(
      run.baseline.metrics.p95TurnLatencyMs,
    );
    expect(run.candidate.metrics.costPerResolutionUsd).not.toBeNull();
    expect(run.baseline.metrics.costPerResolutionUsd).not.toBeNull();
    expect(run.candidate.metrics.costPerResolutionUsd!).toBeLessThan(
      run.baseline.metrics.costPerResolutionUsd!,
    );
  });

  it('regresses on critical guarantees', () => {
    expect(run.candidate.metrics.criticalPassRate).toBeLessThan(
      run.baseline.metrics.criticalPassRate,
    );
    expect(run.candidate.metrics.guardrailBreaches).toBeGreaterThan(0);
  });

  it('is blocked by the gate', () => {
    expect(run.verdict.decision).toBe('block');
    const blockers = run.verdict.findings.filter((f) => f.severity === 'blocker');
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.some((f) => f.title.includes('critical guarantee'))).toBe(true);
  });

  it('demonstrates that an averages-only gate would approve the candidate fixture', () => {
    expect(run.candidate.metrics.containmentRate).toBeGreaterThan(
      run.baseline.metrics.containmentRate,
    );
    expect(run.verdict.wouldHaveShippedOnAverages).toBe(true);
    expect(run.verdict.findings.some((f) => f.title.includes('averages-only'))).toBe(true);
  });

  it('reports the gains so they are not lost with the release', () => {
    expect(run.verdict.findings.some((f) => f.severity === 'gain')).toBe(true);
  });

  it('names the regressed scenarios', () => {
    const failing = failingScenarios(run);
    expect(failing.length).toBeGreaterThan(0);
    expect(failing.every((f) => f.failures.length > 0)).toBe(true);
    // Critical regressions sort first.
    expect(failing[0]!.scenario.critical).toBe(true);
  });

  it('reports per-expectation evidence, not just a score', () => {
    const first = failingScenarios(run)[0]!;
    expect(first.failures.join(' ')).toMatch(/tool_not_called|never_says|says|escalated|tool_called/);
  });
});

describe('regression: a clean candidate ships', () => {
  it('blocks the incumbent too, because it is outside the latency policy', () => {
    const incumbent = runRegressionSuite({
      samples: 3,
      candidate: { ...V27, version: 'baseline-patch-fixture', label: 'Baseline patch fixture' },
    });
    expect(incumbent.verdict.decision).toBe('block');
    expect(
      incumbent.verdict.findings.some((f) => f.title.includes('latency above')),
    ).toBe(true);
  });

  it('ships a candidate fixture that keeps every guardrail and takes the latency win', () => {
    const goodRelease = runRegressionSuite({
      samples: 3,
      candidate: {
        ...V27,
        version: 'candidate-improved-fixture',
        label: 'Improved candidate fixture',
        model: V28.model,
        latency: V28.latency,
        costPerTurnUsd: V28.costPerTurnUsd,
      },
    });
    expect(goodRelease.verdict.decision).toBe('ship');
    expect(goodRelease.verdict.wouldHaveShippedOnAverages).toBe(false);
    expect(goodRelease.verdict.findings.some((f) => f.severity === 'blocker')).toBe(false);
    expect(goodRelease.candidate.metrics.criticalPassRate).toBe(1);
    expect(goodRelease.candidate.metrics.guardrailBreaches).toBe(0);
  });
});

describe('regression: gate arithmetic', () => {
  it('does not call a small movement significant', () => {
    const r = twoProportionZTest(90, 100, 88, 100);
    expect(r.significant).toBe(false);
  });

  it('calls a large movement significant', () => {
    const r = twoProportionZTest(95, 100, 60, 100);
    expect(r.significant).toBe(true);
    expect(r.pValue).toBeLessThan(0.001);
  });

  it('has a sane normal CDF', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });

  it('computes nearest-rank percentiles', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 95)).toBe(0);
  });

  it('enforces the absolute task-success floor independently of the delta', () => {
    const strict = runRegressionSuite({ samples: 3, policy: { ...DEFAULT_GATE, minTaskSuccessRate: 0.99 } });
    expect(strict.verdict.findings.some((f) => f.title.includes('absolute floor'))).toBe(true);
  });
});
