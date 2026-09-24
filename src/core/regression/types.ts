/**
 * Regression vocabulary.
 *
 * The unit of work is a scenario, the unit of evidence is a conversation, and the
 * unit of decision is a version. Keeping those three separate is what makes a gate
 * possible at all: you cannot gate on "the agent felt good in the demo".
 */
import type { ChaosFlag } from '../sim/enterpriseApi';

export type ScenarioTag =
  | 'happy_path'
  | 'identifier_risk'
  | 'frustration'
  | 'entitlement_check'
  | 'duplicate_risk'
  | 'out_of_scope'
  | 'third_party'
  | 'structured_data'
  | 'accessibility'
  | 'dependency_failure'
  | 'record_query'
  | 'language_switch';

export interface Scenario {
  id: string;
  title: string;
  /** What the caller wants, in one line. Used in the scorecard. */
  goal: string;
  tags: ScenarioTag[];
  /** A failing expectation on a critical scenario blocks the release outright. */
  critical: boolean;
  /** Simulated caller turns, in order. */
  callerTurns: string[];
  /** Deterministic dependency failures that belong to this scenario. */
  chaosFlags?: ChaosFlag[];
  expectations: Expectation[];
  /** Conversational budget for one turn, end to end. */
  turnBudgetMs: number;
}

export type Expectation =
  | { kind: 'tool_called'; tool: string; atLeast?: number; note: string }
  | { kind: 'tool_not_called'; tool: string; note: string }
  | { kind: 'escalated'; note: string }
  | { kind: 'not_escalated'; note: string }
  | { kind: 'says'; pattern: string; note: string }
  | { kind: 'never_says'; pattern: string; note: string }
  | { kind: 'conversation_completed'; note: string }
  /** Appended automatically from the latency breakdown. */
  | { kind: 'within_budget'; note: string };

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  latencyMs: number;
}

export interface Turn {
  role: 'caller' | 'agent' | 'tool';
  text: string;
  /** Set on agent turns that were produced by a tool result. */
  toolName?: string;
}

export interface ExpectationResult {
  expectation: Expectation;
  pass: boolean;
  detail: string;
}

export interface LatencyBreakdown {
  sttMs: number;
  llmMs: number;
  toolMs: number;
  ttsMs: number;
  totalMs: number;
}

export interface Conversation {
  scenarioId: string;
  sample: number;
  agentVersion: string;
  turns: Turn[];
  toolCalls: ToolCall[];
  escalated: boolean;
  latency: LatencyBreakdown;
  /** Null when no reliable token price was supplied for the live model. */
  costUsd: number | null;
  results: ExpectationResult[];
  passed: boolean;
  /** A failed expectation on a critical scenario. */
  criticalFailure: boolean;
  rubricScore: number;
  rubricNotes: string[];
}

export interface VersionReport {
  version: string;
  label: string;
  model: string;
  conversations: Conversation[];
  metrics: Metrics;
}

export interface Metrics {
  conversations: number;
  taskSuccessRate: number;
  criticalPassRate: number;
  toolCallCorrectness: number;
  instructionAdherence: number;
  escalationRate: number;
  /** Conversations that ended without a human handoff. The headline CX metric. */
  containmentRate: number;
  p50TurnLatencyMs: number;
  p95TurnLatencyMs: number;
  p95SttMs: number;
  p95LlmMs: number;
  p95ToolMs: number;
  p95TtsMs: number;
  /** Null when at least one conversation has no configured cost. */
  costPerResolutionUsd: number | null;
  /** Conversations that failed a guardrail the business promised not to cross. */
  guardrailBreaches: number;
}
