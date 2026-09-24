/**
 * Suite runner.
 *
 * Deterministic by construction: the same seed produces the same conversations, the
 * same scorecard, and the same verdict. That property is what lets this run as a
 * required CI check rather than as a report somebody reads.
 */
import { computeMetrics } from './metrics';
import {
  compareScenarios,
  DEFAULT_GATE,
  evaluateGate,
  type GatePolicy,
  type GateVerdict,
  type ScenarioComparison,
} from './gate';
import { RubricJudge, type Judge } from './judge';
import { runConversation, V27, V28, type AgentProfile } from './agent';
import { SCENARIOS } from './scenarios';
import type { Conversation, Scenario, VersionReport } from './types';

export interface RegressionRunOptions {
  scenarios?: Scenario[];
  /** Conversations per scenario, per version. */
  samples?: number;
  baseline?: AgentProfile;
  candidate?: AgentProfile;
  policy?: GatePolicy;
  judge?: Judge;
  seed?: number;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface RegressionRun {
  baseline: VersionReport;
  candidate: VersionReport;
  verdict: GateVerdict;
  comparisons: ScenarioComparison[];
  samples: number;
  conversationsPerVersion: number;
}

function hash(seed: number, a: number, b: number): number {
  let h = seed ^ 0x9e3779b9;
  h = Math.imul(h ^ a, 0x85ebca6b);
  h = Math.imul(h ^ b, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function runVersion(
  profile: AgentProfile,
  scenarios: Scenario[],
  samples: number,
  seed: number,
  judge: Judge,
  onProgress?: (done: number, total: number, label: string) => void,
  offset = 0,
  total = 0,
): VersionReport {
  const conversations: Conversation[] = [];
  let done = offset;

  scenarios.forEach((scenario, si) => {
    for (let s = 0; s < samples; s += 1) {
      const conversation = runConversation(scenario, profile, s, hash(seed, si, s));
      const verdict = judge.judge(conversation, scenario);
      conversation.rubricScore = verdict.score;
      conversation.rubricNotes = verdict.notes.length ? verdict.notes : conversation.rubricNotes;
      conversations.push(conversation);
      done += 1;
      onProgress?.(done, total, `${profile.version} ${scenario.id} sample ${s + 1}/${samples}`);
    }
  });

  const criticalIds = new Set(scenarios.filter((s) => s.critical).map((s) => s.id));

  return {
    version: profile.version,
    label: profile.label,
    model: profile.model,
    conversations,
    metrics: computeMetrics(conversations, criticalIds),
  };
}

export function runRegressionSuite(options: RegressionRunOptions = {}): RegressionRun {
  const scenarios = options.scenarios ?? SCENARIOS;
  const samples = options.samples ?? 5;
  const baselineProfile = options.baseline ?? V27;
  const candidateProfile = options.candidate ?? V28;
  const policy = options.policy ?? DEFAULT_GATE;
  const judge = options.judge ?? new RubricJudge();
  const seed = options.seed ?? 20260924;
  const total = scenarios.length * samples * 2;

  const baseline = runVersion(
    baselineProfile,
    scenarios,
    samples,
    seed,
    judge,
    options.onProgress,
    0,
    total,
  );
  const candidate = runVersion(
    candidateProfile,
    scenarios,
    samples,
    seed,
    judge,
    options.onProgress,
    scenarios.length * samples,
    total,
  );

  const comparisons = compareScenarios(scenarios, baseline, candidate);
  const verdict = evaluateGate(baseline, candidate, comparisons, policy);

  return {
    baseline,
    candidate,
    verdict,
    comparisons,
    samples,
    conversationsPerVersion: scenarios.length * samples,
  };
}

/** The per-scenario view the scorecard renders. */
export function failingScenarios(run: RegressionRun): ScenarioComparison[] {
  return run.comparisons
    .filter((c) => c.regressed)
    .sort((a, b) => Number(b.scenario.critical) - Number(a.scenario.critical) || a.delta - b.delta);
}
