/**
 * Live evaluation CLI.
 *
 *   npm run eval:live -- --scenario S03
 *   npm run eval:live -- --all --samples 3 --transcripts
 *
 * Flags: --scenario | --all | --model | --base-url | --samples |
 *        --chaos | --budget-ms | --max-tokens-param | --temperature | --price-in |
 *        --price-out | --transcripts
 *
 * `--max-tokens-param` defaults to `max_completion_tokens`, which is what OpenAI's
 * current models require. Pass `max_tokens` for third-party OpenAI-compatible servers
 * that have not adopted the new name.
 *
 * `--temperature` is omitted from the request unless you pass it, because OpenAI's
 * current models reject any value other than their own default.
 *
 * `--price-in` / `--price-out` are USD per million tokens. Supply both to report cost;
 * without them, cost is reported as unpriced rather than as $0.00.
 *
 * Requires OPENAI_API_KEY (or a compatible key for the endpoint you pass). Everything
 * else in the kit runs offline; this is the one entry point that does not, and it is
 * opt-in for exactly that reason.
 *
 * What this gives you that the deterministic path cannot: it answers "does a real
 * model, given this prompt revision, actually stop re-confirming identifiers?" rather
 * than asserting that it does.
 */
import { SCENARIOS } from '../src/core/regression/scenarios';
import {
  createOpenAiCompatibleClient,
  LIVE_EXPLICIT_PROMPT,
  LIVE_STREAMLINED_PROMPT,
  runLiveConversation,
  type LiveConversationResult,
} from '../src/core/regression/llm';
import { CHAOS_LABELS, type ChaosFlag } from '../src/core/sim/enterpriseApi';
import type { Conversation, Scenario } from '../src/core/regression/types';

interface Args {
  scenarios: string[];
  model: string;
  baseUrl?: string;
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  temperature?: number;
  chaos: ChaosFlag[];
  samples: number;
  budgetMs: number;
  priceIn?: number;
  priceOut?: number;
  transcripts: boolean;
}

function parseMaxTokensParam(raw: string | undefined): Args['maxTokensParam'] {
  if (raw === undefined) return 'max_completion_tokens';
  if (raw === 'max_tokens' || raw === 'max_completion_tokens') return raw;
  throw new Error(
    `--max-tokens-param must be "max_tokens" or "max_completion_tokens", got "${raw}".`,
  );
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const all = argv.includes('--all');
  const scenario = get('--scenario');
  const chaos = (get('--chaos') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const validChaos = new Set(Object.keys(CHAOS_LABELS));
  const invalidChaos = chaos.filter((flag) => !validChaos.has(flag));
  if (invalidChaos.length) {
    throw new Error(`Unknown --chaos flag(s): ${invalidChaos.join(', ')}.`);
  }
  const priceIn = get('--price-in');
  const priceOut = get('--price-out');
  if ((priceIn === undefined) !== (priceOut === undefined)) {
    throw new Error('Pass both --price-in and --price-out, or neither.');
  }
  if ([priceIn, priceOut].some((price) => price !== undefined && (!Number.isFinite(Number(price)) || Number(price) < 0))) {
    throw new Error('Token prices must be finite, non-negative USD-per-million values.');
  }
  const samples = Number(get('--samples') ?? '1');
  if (!Number.isInteger(samples) || samples < 1) throw new Error('--samples must be a positive integer.');

  return {
    scenarios: all ? SCENARIOS.map((s) => s.id) : scenario ? [scenario] : ['S03'],
    model: get('--model') ?? 'gpt-6-luna',
    baseUrl: get('--base-url'),
    maxTokensParam: parseMaxTokensParam(get('--max-tokens-param')),
    temperature: get('--temperature') === undefined ? undefined : Number(get('--temperature')),
    chaos: chaos as ChaosFlag[],
    samples,
    budgetMs: Number(get('--budget-ms') ?? '6000'),
    priceIn: priceIn === undefined ? undefined : Number(priceIn),
    priceOut: priceOut === undefined ? undefined : Number(priceOut),
    transcripts: argv.includes('--transcripts'),
  };
}

function bar(pass: boolean): string {
  return pass ? '\u2713' : '\u2717';
}

function formatFailureLabel(r: Conversation['results'][number]): string {
  const e = r.expectation;
  return e.kind === 'says' || e.kind === 'never_says'
    ? `${e.kind} /${e.pattern}/`
    : e.kind === 'tool_called' || e.kind === 'tool_not_called'
      ? `${e.kind} ${e.tool}`
      : e.kind;
}

interface Observation {
  scenario: Scenario;
  sample: number;
  prompt: string;
  conversation?: Conversation;
  result?: LiveConversationResult;
  error?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(
      [
        'OPENAI_API_KEY is not set.',
        '',
        'This is the only part of the kit that needs a network call. Everything else',
        'runs offline: `npm test` and `npm run build` never touch a model.',
        '',
        '  $env:OPENAI_API_KEY = "sk-..."   # PowerShell',
        '  export OPENAI_API_KEY=sk-...     # bash',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  const agentClient = createOpenAiCompatibleClient({
    apiKey,
    model: args.model,
    baseUrl: args.baseUrl,
    maxTokensParam: args.maxTokensParam,
    temperature: args.temperature,
    pricePerMillionInputUsd: args.priceIn,
    pricePerMillionOutputUsd: args.priceOut,
  });

  const selected = SCENARIOS.filter((s) => args.scenarios.includes(s.id));
  if (selected.length === 0) {
    console.error(`No scenario matched ${args.scenarios.join(', ')}.`);
    process.exitCode = 1;
    return;
  }

  const prompts = [LIVE_EXPLICIT_PROMPT, LIVE_STREAMLINED_PROMPT];
  const observations: Observation[] = [];
  const priceText = args.priceIn === undefined ? 'unpriced' : 'token prices configured';
  console.log(
    `\nLive prompt comparison · model=${args.model} · fixed caller scripts · ${priceText}` +
      ` · ${selected.length} scenario(s) × ${args.samples} paired sample(s)\n`,
  );

  for (const scenario of selected) {
    const chaosFlags = [...new Set([...(scenario.chaosFlags ?? []), ...args.chaos])];
    console.log(
      `${scenario.id} ${scenario.title}${scenario.critical ? '  [CRITICAL]' : ''}` +
        `${chaosFlags.length ? ` · chaos=${chaosFlags.join(',')}` : ''}`,
    );
    for (let sample = 0; sample < args.samples; sample += 1) {
      for (const prompt of prompts) {
        try {
          const result = await runLiveConversation({
            scenario,
            agent: prompt,
            agentClient,
            chaosFlags,
            turnBudgetMs: args.budgetMs,
            sample,
          });
          const c = result.conversation;
          observations.push({ scenario, sample, prompt: prompt.version, conversation: c, result });
          console.log(
            `  ${bar(c.passed)} ${prompt.version.padEnd(24)} ${result.modelCalls} agent calls · ` +
              `${c.toolCalls.length} tool calls · ${result.completed ? 'complete' : 'incomplete'} · ` +
              `LLM ${c.latency.llmMs.toFixed(0)}ms + simulated tools ${c.latency.toolMs.toFixed(0)}ms · ` +
              `${c.costUsd === null ? 'unpriced' : `$${c.costUsd.toFixed(5)}`}`,
          );
          for (const r of c.results.filter((x) => !x.pass)) {
            console.log(`      ${formatFailureLabel(r)} — ${r.detail}`);
          }
          if (args.transcripts) {
            for (const turn of result.transcript) console.log(`      [${turn.role}] ${turn.text}`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          observations.push({ scenario, sample, prompt: prompt.version, error: message });
          console.log(`  ! ${prompt.version.padEnd(24)} ${message}`);
        }
      }
    }
    console.log('');
  }

  const baseline = observations.filter((o) => o.prompt === prompts[0].version);
  const candidate = observations.filter((o) => o.prompt === prompts[1].version);
  const baselineCompleted = baseline.filter((o) => o.conversation);
  const candidateCompleted = candidate.filter((o) => o.conversation);
  const criticalPairs = new Map<string, { scenario: Scenario; baseline?: Conversation; candidate?: Conversation }>();
  for (const observation of observations) {
    if (!observation.scenario.critical) continue;
    const key = `${observation.scenario.id}:${observation.sample}`;
    const pair = criticalPairs.get(key) ?? { scenario: observation.scenario };
    if (observation.prompt === prompts[0].version) pair.baseline = observation.conversation;
    else pair.candidate = observation.conversation;
    criticalPairs.set(key, pair);
  }
  const comparable = [...criticalPairs.values()].filter((p) => p.baseline && p.candidate);
  const pairedCriticalRegressions = comparable.filter((p) => p.baseline!.passed && !p.candidate!.passed).length;
  const pairedCriticalImprovements = comparable.filter((p) => !p.baseline!.passed && p.candidate!.passed).length;
  const criticalBaselineFailures = comparable.filter((p) => !p.baseline!.passed).length;
  const criticalCandidateFailures = comparable.filter((p) => !p.candidate!.passed).length;

  console.log('Summary (paired descriptive observations; not a statistical release verdict):');
  console.log(`  explicit prompt passed: ${baselineCompleted.filter((o) => o.conversation!.passed).length}/${baselineCompleted.length}`);
  console.log(`  streamlined prompt passed: ${candidateCompleted.filter((o) => o.conversation!.passed).length}/${candidateCompleted.length}`);
  console.log(`  critical failures observed: explicit ${criticalBaselineFailures}/${comparable.length}, streamlined ${criticalCandidateFailures}/${comparable.length}`);
  console.log(`  paired critical regressions observed (explicit pass → streamlined fail): ${pairedCriticalRegressions}`);
  console.log(`  paired critical improvements observed (explicit fail → streamlined pass): ${pairedCriticalImprovements}`);
  console.log(`  model-call errors: ${observations.filter((o) => o.error).length}`);
  console.log('  Caller turns and scenario-specific chaos were held constant; this compares two prompt fixtures on the same model.');
  console.log('  Live model outcomes are stochastic. Repeat and inspect transcripts before drawing a release conclusion.\n');
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
