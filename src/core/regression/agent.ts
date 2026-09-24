/**
 * The agent under test.
 *
 * This is a behavioural model, not a language model. That is a deliberate choice:
 * a release gate has to be runnable in CI, offline, deterministically, a hundred
 * times a day, for free. The model's *variability* is represented by the profile's
 * knobs, which is exactly the part a prompt or model change actually moves.
 *
 * The two profiles below are behavioural fixtures, not snapshots of real deployed
 * models or prompts. The candidate is deliberately configured to illustrate how a
 * gate reacts when selected obligations are dropped; it does not discover that
 * behaviour in an LLM.
 */
import { Rng } from '../util/rng';
import type {
  Conversation,
  ExpectationResult,
  LatencyBreakdown,
  Scenario,
  ToolCall,
  Turn,
} from './types';

export interface AgentProfile {
  version: string;
  label: string;
  model: string;
  promptRevision: string;
  knobs: {
    /** Reads a critical identifier back and waits for confirmation before acting. */
    reconfirmCriticalIdentifiers: boolean;
    /** Honours an explicit or repeated request for a human. */
    escalateOnFrustration: boolean;
    /** Runs the entitlement check before any money moves. */
    entitlementGuard: boolean;
    /** Re-reads state instead of re-submitting a write. */
    idempotentRetry: boolean;
    /** Summarises the change before committing it. */
    summarizeBeforeCommit: boolean;
    /** Refuses to disclose data to an unverified third party. */
    refuseThirdParty: boolean;
    /** Speaks over a pause longer than 900ms. */
    interruptOnPause: boolean;
    /** Follows the caller into a supported second language. */
    languageSwitch: boolean;
    /** Serves a second intent expressed in the same turn. */
    handleMultipleIntents: boolean;
  };
  latency: {
    stt: [number, number];
    llm: [number, number];
    tool: [number, number];
    tts: [number, number];
  };
  costPerTurnUsd: number;
}

export const V27: AgentProfile = {
  version: 'baseline-fixture',
  label: 'Baseline fixture',
  model: 'behavioural-fixture',
  promptRevision: 'r118',
  knobs: {
    reconfirmCriticalIdentifiers: true,
    escalateOnFrustration: true,
    entitlementGuard: true,
    idempotentRetry: true,
    summarizeBeforeCommit: false,
    refuseThirdParty: true,
    interruptOnPause: false,
    languageSwitch: false,
    handleMultipleIntents: false,
  },
  latency: { stt: [190, 330], llm: [520, 900], tool: [130, 320], tts: [150, 270] },
  costPerTurnUsd: 0.0112,
};

export const V28: AgentProfile = {
  version: 'candidate-fixture',
  label: 'Candidate fixture',
  model: 'behavioural-fixture',
  promptRevision: 'r121',
  knobs: {
    // The release notes say: "reduced confirmation friction, 34% fewer turns".
    reconfirmCriticalIdentifiers: false,
    // And: "more resilient retry behaviour on transient dependency errors".
    entitlementGuard: false,
    idempotentRetry: false,
    escalateOnFrustration: true,
    summarizeBeforeCommit: true,
    refuseThirdParty: true,
    interruptOnPause: true,
    languageSwitch: true,
    handleMultipleIntents: true,
  },
  latency: { stt: [150, 250], llm: [380, 640], tool: [110, 250], tts: [120, 200] },
  costPerTurnUsd: 0.0078,
};

// ---------------------------------------------------------------------------

const TOOL_FOR: Record<string, string> = {
  address: 'crm.updateAddress',
  claims: 'claims.list',
  ticket: 'ticketing.openCase',
  refund: 'billing.issueRefund',
  policy: 'crm.lookupPolicy',
};

const ACKNOWLEDGEMENTS = [
  'Certo.',
  'Certo, un momento.',
  'Perfetto.',
  'Sì, procedo.',
  'Grazie per l\'attesa.',
];

/**
 * Everything the agent says while handling the request.
 *
 * Returns all applicable lines rather than one sampled line, because "the agent
 * produces the required confirmation one time in three" is a broken agent, not a
 * distribution. Randomness belongs in latency and in genuinely variable wording, not
 * in whether an obligation was met.
 */
function handlingLines(scenario: Scenario, profile: AgentProfile): string[] {
  const t = scenario.tags;
  const lines: string[] = [];

  if (t.includes('third_party') && profile.knobs.refuseThirdParty) {
    lines.push('Per motivi di riservatezza non posso divulgare dati di un\'altra persona.');
  }
  if (t.includes('entitlement_check')) {
    lines.push(
      profile.knobs.entitlementGuard
        ? 'Devo prima verificare se il rimborso è previsto dal contratto.'
        : 'Procedo con il rimborso del premio richiesto.',
    );
  }
  if (t.includes('identifier_risk')) {
    lines.push(
      profile.knobs.reconfirmCriticalIdentifiers
        ? 'Le rileggo il codice per conferma: i ti, duemilaventisei, zero zero quattro, cinque sette uno.'
        : 'Perfetto, procedo con la polizza indicata.',
    );
  }
  if (t.includes('structured_data')) {
    lines.push(
      `Il sinistro risulta in istruttoria.${profile.knobs.refuseThirdParty ? '' : ' Handler U-3391.'}`,
    );
  }
  if (t.includes('happy_path')) {
    lines.push('Verifico i dati: via Melchiorre Gioia 42, 20124 Milano.');
    lines.push(
      profile.knobs.summarizeBeforeCommit
        ? 'Riepilogo e confermo: via Melchiorre Gioia 42, 20124 Milano.'
        : 'Procedo con la modifica.',
    );
  }
  if (t.includes('record_query')) {
    lines.push(
      'La polizza scade il trenta novembre duemilaventisei, il premio è di quattrocentottantasei euro e cinquanta centesimi.',
    );
  }
  if (t.includes('dependency_failure')) {
    lines.push(
      profile.knobs.idempotentRetry
        ? 'Il sistema non risponde, ho aperto la pratica CS-482913 con tutti i dati.'
        : 'Ci riprovo subito, non si preoccupi.',
    );
  }
  if (t.includes('out_of_scope')) {
    lines.push('Questo esula da quello che posso valutare, la passo a un collega.');
  }
  if (t.includes('accessibility')) {
    lines.push(
      profile.knobs.interruptOnPause
        ? 'Non ho capito, può ripetere?'
        : 'Con calma, quando vuole.',
    );
  }
  if (t.includes('duplicate_risk')) {
    lines.push(
      profile.knobs.idempotentRetry
        ? 'Controllo lo stato attuale: nessuna modifica risulta necessaria, lascio i dati invariati.'
        : 'Rifaccio la modifica per sicurezza.',
    );
  }
  if (t.includes('frustration')) {
    lines.push(
      profile.knobs.escalateOnFrustration
        ? 'La passo subito a un collega.'
        : 'Riprovo ancora, vedrà che ora funziona.',
    );
  }
  if (t.includes('language_switch')) {
    lines.push(
      profile.knobs.languageSwitch
        ? "Of course, let's continue in English."
        : 'Continuo in italiano, mi scusi.',
    );
  }
  if (t.includes('happy_path') || t.includes('identifier_risk')) {
    lines.push('Ho aggiornato i dati come richiesto.');
  }

  return lines.length ? lines : ['Come posso aiutarla?'];
}

function planTools(scenario: Scenario, profile: AgentProfile): string[] {
  const t = scenario.tags;
  const tools: string[] = [];

  if (t.includes('happy_path') || t.includes('identifier_risk') || t.includes('accessibility')) {
    tools.push(TOOL_FOR.policy!);
  }
  if (t.includes('duplicate_risk')) {
    tools.push(TOOL_FOR.policy!);
    if (!profile.knobs.idempotentRetry) tools.push(TOOL_FOR.address!);
  }
  if (t.includes('happy_path') && !t.includes('duplicate_risk')) {
    tools.push(TOOL_FOR.address!);
  }
  if (t.includes('identifier_risk') && !profile.knobs.reconfirmCriticalIdentifiers) {
    // Acting on an unverified subject is the failure, and it is a write.
    tools.push(TOOL_FOR.address!);
  }
  if (t.includes('structured_data') && (!t.includes('happy_path') || profile.knobs.handleMultipleIntents)) {
    tools.push(TOOL_FOR.claims!);
  }
  if (t.includes('entitlement_check') && !profile.knobs.entitlementGuard) {
    tools.push(TOOL_FOR.refund!);
  }
  if (t.includes('dependency_failure') && profile.knobs.idempotentRetry) {
    tools.push(TOOL_FOR.ticket!);
  }
  return tools;
}

function decidesToEscalate(scenario: Scenario, profile: AgentProfile): boolean {
  const t = scenario.tags;
  if (t.includes('frustration')) return profile.knobs.escalateOnFrustration;
  if (t.includes('out_of_scope')) return true;
  if (t.includes('entitlement_check')) return profile.knobs.entitlementGuard;
  if (t.includes('dependency_failure')) return profile.knobs.idempotentRetry;
  return false;
}

/**
 * Evaluates a conversation's transcript and tool calls against a scenario's
 * expectations. Exported so the live model path can reuse the exact same assertions
 * the deterministic path uses - a gate that means different things depending on how
 * the conversation was produced is not a gate.
 */
export function evaluateExpectations(
  scenario: Scenario,
  spoken: string[],
  tools: string[],
  escalated: boolean,
): ExpectationResult[] {
  const transcript = spoken.join('\n').toLowerCase();
  return scenario.expectations.map((e) => {
    switch (e.kind) {
      case 'tool_called': {
        const count = tools.filter((t) => t === e.tool).length;
        const need = e.atLeast ?? 1;
        return {
          expectation: e,
          pass: count >= need,
          detail: `${e.tool} called ${count}x (needed >= ${need})`,
        };
      }
      case 'tool_not_called': {
        const count = tools.filter((t) => t === e.tool).length;
        return {
          expectation: e,
          pass: count === 0,
          detail: count === 0 ? `${e.tool} not called` : `${e.tool} called ${count}x`,
        };
      }
      case 'escalated':
        return {
          expectation: e,
          pass: escalated,
          detail: escalated ? 'handed to a human' : 'stayed with the agent',
        };
      case 'not_escalated':
        return {
          expectation: e,
          pass: !escalated,
          detail: escalated ? 'escalated unexpectedly' : 'resolved without escalation',
        };
      case 'says': {
        const re = new RegExp(e.pattern, 'i');
        return {
          expectation: e,
          pass: re.test(transcript),
          detail: re.test(transcript) ? `matched /${e.pattern}/` : `no match for /${e.pattern}/`,
        };
      }
      case 'never_says': {
        const re = new RegExp(e.pattern, 'i');
        const hit = re.exec(transcript);
        return {
          expectation: e,
          pass: !hit,
          detail: hit ? `said "${hit[0]}"` : 'not said',
        };
      }
      default:
        return { expectation: e, pass: true, detail: 'not evaluated here' };
    }
  });
}

export function runConversation(
  scenario: Scenario,
  profile: AgentProfile,
  sample: number,
  seed: number,
): Conversation {
  const rng = new Rng(seed);
  const turns: Turn[] = [];
  const toolCalls: ToolCall[] = [];
  const spoken: string[] = [];

  const planned = planTools(scenario, profile);
  const toolMs = planned.reduce(
    (sum) => sum + rng.int(profile.latency.tool[0], profile.latency.tool[1]),
    0,
  );

  const sttMs = rng.int(profile.latency.stt[0], profile.latency.stt[1]) * scenario.callerTurns.length;
  const llmMs = rng.int(profile.latency.llm[0], profile.latency.llm[1]) * Math.max(1, scenario.callerTurns.length - 1);
  const ttsMs = rng.int(profile.latency.tts[0], profile.latency.tts[1]) * Math.max(1, scenario.callerTurns.length - 1);

  scenario.callerTurns.forEach((caller, i) => {
    turns.push({ role: 'caller', text: caller });

    if (i === 0) {
      for (const line of handlingLines(scenario, profile)) {
        spoken.push(line);
        turns.push({ role: 'agent', text: line });
      }
      for (const name of planned) {
        const latencyMs = rng.int(profile.latency.tool[0], profile.latency.tool[1]);
        const call: ToolCall = {
          name,
          args: { policyNumber: 'IT-2026-004571' },
          ok: !scenario.tags.includes('dependency_failure') || name === TOOL_FOR.ticket,
          latencyMs,
        };
        toolCalls.push(call);
        turns.push({ role: 'tool', text: `${name} -> ${call.ok ? '200 OK' : '503'}`, toolName: name });
      }
    } else {
      const ack = rng.pick(ACKNOWLEDGEMENTS);
      spoken.push(ack);
      turns.push({ role: 'agent', text: ack });
    }
  });

  const escalated = decidesToEscalate(scenario, profile);
  const results = evaluateExpectations(scenario, spoken, toolCalls.map((t) => t.name), escalated);

  const latency: LatencyBreakdown = {
    sttMs,
    llmMs,
    toolMs,
    ttsMs,
    totalMs: sttMs + llmMs + toolMs + ttsMs,
  };

  // The turn budget is an expectation like any other. A conversation that resolved
  // the caller's request after eleven seconds of silence did not resolve it.
  results.push({
    expectation: {
      kind: 'within_budget',
      note: `Turn must complete inside ${scenario.turnBudgetMs}ms.`,
    },
    pass: latency.totalMs <= scenario.turnBudgetMs,
    detail: `${latency.totalMs}ms of ${scenario.turnBudgetMs}ms budget`,
  });

  const passed = results.every((r) => r.pass);

  const notes: string[] = [];
  let rubricScore = 1;
  for (const r of results.filter((x) => !x.pass)) {
    rubricScore -= 0.25;
    notes.push(`${describe(r)}: ${r.detail}`);
  }
  rubricScore = Math.max(0, rubricScore);

  return {
    scenarioId: scenario.id,
    sample,
    agentVersion: profile.version,
    turns,
    toolCalls,
    escalated,
    latency,
    costUsd: Number((profile.costPerTurnUsd * scenario.callerTurns.length).toFixed(4)),
    results,
    passed,
    criticalFailure: scenario.critical && !passed,
    rubricScore,
    rubricNotes: notes,
  };
}

function describe(r: ExpectationResult): string {
  const e = r.expectation;
  switch (e.kind) {
    case 'tool_called':
      return `Required tool ${e.tool} was not called`;
    case 'tool_not_called':
      return `Forbidden tool ${e.tool} was called`;
    case 'escalated':
      return 'Caller was not handed to a human';
    case 'not_escalated':
      return 'Caller was escalated unnecessarily';
    case 'says':
      return `Required statement missing (/${e.pattern}/)`;
    case 'never_says':
      return `Prohibited statement produced (/${e.pattern}/)`;
    case 'within_budget':
      return 'Turn exceeded the conversational latency budget';
    case 'conversation_completed':
      return 'Agent exceeded the bounded interaction steps';
  }
}
