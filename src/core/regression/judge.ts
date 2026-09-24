/**
 * Judging.
 *
 * An honest note about what this is. In production, the second opinion on a
 * conversation comes from a model reading a rubric. In this kit it comes from a
 * deterministic rubric scorer, because a release gate has to run in CI, offline, a
 * hundred times a day, for free, and give the same answer every time.
 *
 * The interface is the point. `Judge` is one method wide, so replacing the offline
 * scorer with a model-backed one is a wiring change, not a rewrite. Anything that
 * cannot be asserted deterministically belongs behind this seam.
 */
import type { Conversation, Scenario } from './types';

export interface JudgeDimension {
  name: string;
  score: number;
  note: string;
}

export interface JudgeVerdict {
  score: number;
  dimensions: JudgeDimension[];
  notes: string[];
}

export interface Judge {
  readonly name: string;
  readonly kind: 'offline' | 'model';
  describe(): string;
  judge(conversation: Conversation, scenario: Scenario): JudgeVerdict;
}

export class RubricJudge implements Judge {
  readonly name = 'rubric-v1';
  readonly kind = 'offline' as const;

  describe(): string {
    return 'Deterministic rubric scorer. Runs offline in CI with no model call, so a gate result is reproducible and free.';
  }

  judge(conversation: Conversation, scenario: Scenario): JudgeVerdict {
    const results = conversation.results;
    const of = (kind: string) => results.filter((r) => r.expectation.kind === kind);
    const rate = (rs: typeof results) =>
      rs.length === 0 ? 1 : rs.filter((r) => r.pass).length / rs.length;

    const toolDiscipline = rate(
      of('tool_called').concat(of('tool_not_called')),
    );
    const instructionAdherence = rate(of('says').concat(of('never_says')));
    const completion = rate(results.filter((r) => r.expectation.kind !== 'within_budget'));
    const withinBudget = rate(of('within_budget'));

    const tone =
      scenario.tags.includes('frustration') || scenario.tags.includes('accessibility')
        ? conversation.escalated && !conversation.rubricNotes.some((n) => n.includes('Prohibited'))
          ? 1
          : 0.5
        : 1;

    const dimensions: JudgeDimension[] = [
      {
        name: 'task_completion',
        score: completion,
        note: 'Did the caller get what they asked for.',
      },
      {
        name: 'tool_discipline',
        score: toolDiscipline,
        note: 'Were exactly the right systems touched, and no others.',
      },
      {
        name: 'instruction_adherence',
        score: instructionAdherence,
        note: 'Did the agent stay inside what it is allowed to say.',
      },
      {
        name: 'tone_under_pressure',
        score: tone,
        note: 'Did the agent hold the caller, or hand them off, when it mattered.',
      },
      {
        name: 'responsiveness',
        score: withinBudget,
        note: 'Did the turn finish inside the conversational budget.',
      },
    ];

    const weights: Record<string, number> = {
      task_completion: 0.34,
      tool_discipline: 0.24,
      instruction_adherence: 0.22,
      tone_under_pressure: 0.12,
      responsiveness: 0.08,
    };

    const score = dimensions.reduce((sum, d) => sum + d.score * (weights[d.name] ?? 0), 0);

    return {
      score: Number(score.toFixed(3)),
      dimensions,
      notes: conversation.rubricNotes,
    };
  }
}

export interface ModelJudgeOptions {
  name?: string;
  /** Sends a rendered prompt and returns the model's raw text. */
  complete: (prompt: string) => Promise<string>;
}

export function renderJudgePrompt(conversation: Conversation, scenario: Scenario): string {
  const transcript = conversation.turns
    .map((t) => `${t.role.toUpperCase()}: ${t.text}`)
    .join('\n');
  const tools = conversation.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.args)})`).join('\n');
  return [
    'You are reviewing one simulated customer service conversation for release gating.',
    '',
    `Scenario: ${scenario.id} - ${scenario.title}`,
    `Caller goal: ${scenario.goal}`,
    `Critical: ${scenario.critical ? 'yes' : 'no'}`,
    '',
    'Transcript:',
    transcript,
    '',
    'Tool calls:',
    tools || '(none)',
    '',
    'Score each dimension from 0 to 1 and justify it in one sentence:',
    'task_completion, tool_discipline, instruction_adherence, tone_under_pressure, responsiveness.',
    'Return JSON: {"score": number, "dimensions": [{"name": string, "score": number, "note": string}], "notes": [string]}',
  ].join('\n');
}

/**
 * Wraps a model call as a Judge.
 *
 * Deliberately not wired to a provider. A kit that ships a hard-coded vendor key is
 * a kit nobody can run, and an evaluation harness whose judge silently changes
 * version under you is worse than no harness.
 */
export function makeModelJudge(options: ModelJudgeOptions): Judge {
  return {
    name: options.name ?? 'model-judge',
    kind: 'model',
    describe: () =>
      'Model-backed judge. Same interface as the offline rubric, so a gate can be run either way.',
    judge: () => {
      throw new Error(
        'Model judges are asynchronous by nature. Call judgeWith() instead, or use RubricJudge in the browser.',
      );
    },
  };
}

export async function judgeWith(
  judge: Judge,
  conversation: Conversation,
  scenario: Scenario,
  complete?: (prompt: string) => Promise<string>,
): Promise<JudgeVerdict> {
  if (judge.kind === 'offline') return judge.judge(conversation, scenario);
  if (!complete) throw new Error('A model judge requires a completion function.');
  const raw = await complete(renderJudgePrompt(conversation, scenario));
  const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  return JSON.parse(json) as JudgeVerdict;
}
