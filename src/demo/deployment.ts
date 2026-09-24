/**
 * The scenario the console runs.
 *
 * One Italian motor-insurance conversation, executed against the simulated
 * enterprise backend with whatever failure modes the reviewer switches on. The point
 * is not that the happy path works. The point is that every failure path ends in a
 * sentence somebody approved in advance.
 *
 * The conversation is carried in both locales the deployment runs in, so a reviewer
 * who does not read Italian can audit the same run line for line. Language is a
 * reading choice here, never a run parameter: nothing below branches on it except
 * which wording gets rendered.
 */
import { EnterpriseClient, POLICY_SLOTS } from '../core/integration/client';
import { mapFields } from '../core/integration/mapping';
import { IdempotencyLedger } from '../core/integration/idempotency';
import { recoveryFor, type IntegrationError, type RecoveryScript } from '../core/integration/errors';
import { Saga, type SagaResult } from '../core/integration/saga';
import { TurnBudget } from '../core/integration/resilience';
import { manualClock, type TraceEvent, type TraceSink } from '../core/integration/types';
import { createEnterpriseApi, type ChaosFlag } from '../core/sim/enterpriseApi';
import { Rng } from '../core/util/rng';
import type { Lang } from '../core/voice/numbers';

export interface CdrEntry {
  index: number;
  at: number;
  kind: TraceEvent['kind'];
  status: TraceEvent['status'];
  label: string;
  detail?: string;
  latencyMs?: number;
  attempt?: number;
}

export interface TranscriptLine {
  role: 'caller' | 'agent';
  /**
   * The line in every locale the deployment runs in. Wording is the only
   * locale-dependent part of a run: the trace, the metrics and the outcome are
   * identical whichever language the reviewer reads it in.
   */
  text: Record<Lang, string>;
  /** Why the agent said this. Shown inline so the reviewer can audit the wording. */
  note?: string;
  /** Set when the line came from a recovery script rather than the happy path. */
  recovered?: boolean;
}

export interface DeploymentMetrics {
  totalMs: number;
  budgetMs: number;
  remainingMs: number;
  calls: number;
  retries: number;
  breakerTrips: number;
  writesAccepted: number;
  duplicateWritesSuppressed: number;
  recoveryUsed: boolean;
}

export interface DeploymentRun {
  chaos: ChaosFlag[];
  cdr: CdrEntry[];
  trace: TraceEvent[];
  transcript: TranscriptLine[];
  saga: SagaResult;
  outcome: 'resolved' | 'recovered' | 'escalated';
  headline: string;
  metrics: DeploymentMetrics;
}

const POLICY_NUMBER = 'IT-2026-004571';
const TURN_BUDGET_MS = 4200;

/**
 * The conversation itself, in both locales the deployment runs in.
 *
 * Everything in here is wording. The chain, the retry policy, the turn budget and
 * the recovery decision are language-independent, which is why the same run can be
 * read in either language without a single number moving.
 */
interface ConversationCopy {
  disclosure: string;
  consentAcknowledgement: string;
  callerOpener: string;
  callerAddress: string;
  policyFound: (name: string, address: string) => string;
  identityChallenge: (taxCode: string) => string;
  callerConfirms: string;
  addressUpdated: (address: string) => string;
}

/** A street address is a proper noun: the caller reads the same string either way. */
const ADDRESS_SPOKEN = 'Via Melchiorre Gioia 42, 20124 Milano.';
const REQUESTED_ADDRESS: Record<string, string> = {
  street: 'Via Melchiorre Gioia',
  civic: '42',
  postalCode: '20124',
  city: 'Milano',
  province: 'MI',
  country: 'IT',
};

const COPY: Record<Lang, ConversationCopy> = {
  'it-IT': {
    disclosure:
      'Buongiorno, sono un assistente basato sull\'intelligenza artificiale di Polaris Assicurazioni. Questa chiamata viene registrata. Acconsente a proseguire?',
    consentAcknowledgement: 'Sì, acconsento a proseguire.',
    callerOpener: 'Buongiorno, ho cambiato casa e devo aggiornare l\'indirizzo della polizza.',
    callerAddress: ADDRESS_SPOKEN,
    policyFound: (name, address) => `La trovo, ${name}. L'indirizzo che risulta è ${address}.`,
    identityChallenge: (taxCode) =>
      `Per sicurezza le chiedo conferma del codice fiscale: ${taxCode}.`,
    callerConfirms: 'Sì, corretto.',
    addressUpdated: (address) => `Ho aggiornato l'indirizzo a ${address}. La modifica è confermata dal sistema.`,
  },
  'en-GB': {
    disclosure:
      'Good morning, I am an AI-powered assistant for Polaris Assicurazioni. This call is being recorded. Do you agree to continue?',
    consentAcknowledgement: 'Yes, I agree to continue.',
    callerOpener:
      'Good morning, I have moved house and I need to update the address on my policy.',
    callerAddress: ADDRESS_SPOKEN,
    policyFound: (name, address) =>
      `I have your file here, ${name}. The address we hold is ${address}.`,
    identityChallenge: (taxCode) =>
      `For security, let me confirm the tax code on file: ${taxCode}.`,
    callerConfirms: 'Yes, that is correct.',
    addressUpdated: (address) => `I have updated the address to ${address}. The system has confirmed the change.`,
  },
};

/**
 * Resolves one line in every locale at once, so a line can never end up existing in
 * only one language.
 */
const say = (pick: (copy: ConversationCopy) => string): Record<Lang, string> => ({
  'it-IT': pick(COPY['it-IT']),
  'en-GB': pick(COPY['en-GB']),
});

interface Ctx {
  client: EnterpriseClient;
  slots: Record<string, unknown>;
  previousAddress?: Record<string, string>;
  turnId: string;
  caseId?: string;
  recovery?: RecoveryScript;
  error?: IntegrationError;
  writes: number;
  claimedSuccess: boolean;
}

class StepFailed extends Error {
  constructor(public readonly integrationError: IntegrationError) {
    super(integrationError.message);
    this.name = 'StepFailed';
  }
}

export async function runDeployment(chaosFlags: ChaosFlag[]): Promise<DeploymentRun> {
  const rng = new Rng(4242);
  const clock = manualClock(0);
  const trace: TraceEvent[] = [];
  const sink: TraceSink = (e) => trace.push(e);

  const chaos = {
    rateLimit: false,
    serverError: false,
    timeout: false,
    tokenExpiry: false,
    duplicateSubmit: false,
    slowCrm: false,
    flapping: false,
    crmUnavailable: false,
    ...Object.fromEntries(chaosFlags.map((f) => [f, true])),
  };

  const api = createEnterpriseApi(chaos, rng);
  const budget = new TurnBudget(TURN_BUDGET_MS, clock, sink);
  const ledger = new IdempotencyLedger();

  const client = new EnterpriseClient({
    baseUrl: 'https://api.example.invalid',
    tokenUrl: '/oauth/token',
    clientId: 'polaris-agent',
    clientSecret: 'redacted',
    transport: api.transport,
    clock,
    trace: sink,
    budget,
    ledger,
  });

  const transcript: TranscriptLine[] = [];
  const callerSays = (pick: (copy: ConversationCopy) => string) =>
    transcript.push({ role: 'caller', text: say(pick) });

  // --- compliance beat ----------------------------------------------------
  const disclosureText = say((copy) => copy.disclosure);
  sink({
    at: 0,
    kind: 'compliance',
    status: 'ok',
    label: 'AI disclosure played in the scripted demo',
    detail: 'The locale-specific sample explicitly identifies the assistant as AI-powered.',
    meta: { evidenceKind: 'ai_disclosure', explicitAiDisclosure: true, source: 'scripted demo' },
  });
  transcript.push({
    role: 'agent',
    text: disclosureText,
    note: 'Scripted AI disclosure and recording notice. The 0ms timestamp is a fixture, not measured audio or a legal conclusion.',
  });

  callerSays((copy) => copy.consentAcknowledgement);
  sink({
    at: 0,
    kind: 'compliance',
    status: 'ok',
    label: 'Scripted caller acknowledged the recording notice',
    detail: 'This fixture records a sample acknowledgement; it does not establish a lawful basis or valid consent in a real deployment.',
    meta: { evidenceKind: 'recording_acknowledgement', source: 'scripted demo caller' },
  });

  callerSays((copy) => copy.callerOpener);
  callerSays((copy) => copy.callerAddress);

  const ctx: Ctx = {
    client,
    slots: {},
    turnId: 'turn-2026-09-24-001',
    writes: 0,
    claimedSuccess: false,
  };

  const saga = new Saga<Ctx>('addressChange', [
    {
      id: 'read',
      name: 'Read current policy',
      critical: true,
      run: async (c) => {
        const res = await c.client.lookupPolicy(POLICY_NUMBER);
        if (!res.ok) {
          c.error = res.error;
          throw new StepFailed(res.error);
        }
        const prior = res.value.address;
        if (prior && typeof prior === 'object') {
          c.previousAddress = Object.fromEntries(
            Object.entries(prior as Record<string, unknown>).filter(
              ([, value]) => typeof value === 'string',
            ),
          ) as Record<string, string>;
        }
        const mapped = mapFields(res.value, POLICY_SLOTS);
        c.slots = mapped.values;
        const callerName = `${String(c.slots.callerFirstName)} ${String(c.slots.callerLastName)}`;
        const addressOnFile = String(c.slots.addressOnFile);
        transcript.push({
          role: 'agent',
          text: say((copy) => copy.policyFound(callerName, addressOnFile)),
          note: `Mapped ${mapped.applied.length} fields into agent slots; ${mapped.missingRequired.length} required fields missing.`,
        });
      },
    },
    {
      id: 'verify',
      name: 'Verify caller identity',
      critical: true,
      run: async (c) => {
        transcript.push({
          role: 'agent',
          text: say((copy) => copy.identityChallenge(String(c.slots.taxCodeMasked))),
          note: 'Scripted masked-identifier challenge; this is not production identity assurance.',
        });
        callerSays((copy) => copy.callerConfirms);
        c.slots.identityChallengeAcknowledged = true;
        sink({
          at: clock.now(),
          kind: 'compliance',
          status: 'info',
          label: 'Masked tax-code challenge acknowledged in the scripted demo',
          detail: 'A scripted confirmation is not proof of identity assurance in a production service.',
          meta: { evidenceKind: 'identity_challenge', source: 'scripted demo caller' },
        });
      },
    },
    {
      id: 'write',
      name: 'Apply address change',
      critical: true,
      run: async (c) => {
        const res = await c.client.updateAddress(
          POLICY_NUMBER,
          REQUESTED_ADDRESS,
          c.turnId,
        );
        if (!res.ok) {
          c.error = res.error;
          throw new StepFailed(res.error);
        }
        c.writes += 1;
        c.slots.replayed = res.replayed;
      },
      compensate: async (c) => {
        if (!c.previousAddress) {
          throw new Error('Previous address was not captured; cannot compensate safely.');
        }
        const res = await c.client.updateAddress(
          POLICY_NUMBER,
          c.previousAddress,
          `${c.turnId}-compensate`,
        );
        if (!res.ok) throw new Error(`Address compensation failed: ${res.error.kind}.`);
        c.writes += 1;
      },
    },
  ]);

  const sagaResult = await saga.run(ctx, { clock, trace: sink });

  // --- recovery -----------------------------------------------------------
  let outcome: DeploymentRun['outcome'] = 'resolved';
  let headline = 'Address change applied and confirmed.';

  if (sagaResult.status !== 'completed') {
    const error =
      ctx.error ??
      ({
        kind: 'unknown',
        message: 'The chain did not complete.',
        retryable: false,
        attempts: 1,
      } as IntegrationError);

    // Open a case if the recovery script needs one. If ticketing does not return a
    // reference, recoveryFor chooses an honest handoff line instead of inventing one.
    let caseId: string | undefined;
    // A placeholder here resolves only the script's intended move. The final wording
    // is generated below with the real case ID (or the no-reference fallback).
    const provisional = recoveryFor(error, { caseId: 'pending-reference' });
    if (provisional.move === 'open_ticket') {
      const caseRes = await client.openCase(
        {
          subject: `Address change not applied for ${POLICY_NUMBER}`,
          body: `Requested address: ${ADDRESS_SPOKEN} The system did not confirm the write (${error.kind}: ${error.message}). Do not treat the address as updated.`,
          priority: 'normal',
        },
        `${ctx.turnId}-case`,
      );
      if (caseRes.ok) caseId = caseRes.value.caseId;
    }

    const script = recoveryFor(error, { caseId });
    ctx.recovery = script;
    transcript.push({
      role: 'agent',
      // The wording comes from the reviewed script table, in the caller's language.
      text: { 'it-IT': script.agentLine.it, 'en-GB': script.agentLine.en },
      note: `Recovery script for "${error.kind}" - move: ${script.move}, handoff selected: ${script.escalate ? 'yes' : 'no'}. No live human queue is connected.`,
      recovered: true,
    });
    sink({
      at: clock.now(),
      kind: 'compliance',
      status: script.escalate ? 'warn' : 'info',
      label: script.escalate ? 'Human handoff selected in the simulated flow' : 'Recovery wording selected',
      detail: 'No external human queue is connected in this reference implementation.',
      meta: { evidenceKind: script.escalate ? 'simulated_handoff' : 'recovery_statement' },
    });
    sink({
      at: clock.now(),
      kind: 'compliance',
      status: 'ok',
      label: 'Agent did not claim the write was confirmed',
      meta: { evidenceKind: 'agent_outcome', writeAcknowledged: false, claimedSuccess: false },
    });
    outcome = script.escalate ? 'escalated' : 'recovered';
    headline =
      script.move === 'open_ticket'
        ? 'The write is unconfirmed. The caller left with a ticket reference and no promise that the change succeeded.'
        : script.escalate
          ? 'The write is unconfirmed. A human handoff was selected in the simulated flow; no external queue is connected.'
          : 'The failure was absorbed inside the turn. The caller never learned it happened.';
  } else {
    ctx.claimedSuccess = true;
    transcript.push({
      role: 'agent',
      text: say((copy) => copy.addressUpdated(String(ctx.slots.addressOnFile))),
      note: 'Success claimed only after the system of record acknowledged the write. No messaging provider is connected.',
    });
    sink({
      at: clock.now(),
      kind: 'compliance',
      status: 'ok',
      label: 'Agent confirmed the address change after write acknowledgement',
      meta: { evidenceKind: 'agent_outcome', writeAcknowledged: true, claimedSuccess: true },
    });
  }

  // --- metrics ------------------------------------------------------------
  const httpEvents = trace.filter((e) => e.kind === 'http');
  const metrics: DeploymentMetrics = {
    totalMs: clock.now(),
    budgetMs: TURN_BUDGET_MS,
    remainingMs: budget.remainingMs,
    calls: httpEvents.length,
    retries: trace.filter((e) => e.kind === 'retry').length,
    breakerTrips: trace.filter((e) => e.kind === 'breaker' && e.status === 'error').length,
    writesAccepted: api.acceptedWrites.filter((write) => /\/address|\/refunds/.test(write.path)).length,
    duplicateWritesSuppressed: ledger.duplicateAttempts,
    recoveryUsed: ctx.recovery !== undefined,
  };

  return {
    chaos: chaosFlags,
    cdr: toCdr(trace),
    trace,
    transcript,
    saga: sagaResult,
    outcome,
    headline,
    metrics,
  };
}

function toCdr(trace: TraceEvent[]): CdrEntry[] {
  return trace
    .filter((e) => e.kind !== 'auth' || e.status === 'ok')
    .map((e, i) => ({
      index: i,
      at: e.at,
      kind: e.kind,
      status: e.status,
      label: e.label,
      detail: e.detail,
      latencyMs: e.latencyMs,
      attempt: e.attempt,
    }));
}

/**
 * The failure modes worth putting in front of a reviewer, in the order they usually
 * show up in a real deployment.
 */
export const CHAOS_PRESETS: Array<{ id: string; label: string; flags: ChaosFlag[]; why: string }> = [
  {
    id: 'clean',
    label: 'Clean run',
    flags: [],
    why: 'Baseline. Establishes what a resolved conversation looks like end to end.',
  },
  {
    id: 'throttled',
    label: 'Throttled CRM',
    flags: ['rateLimit'],
    why: 'The most common production failure, and the one most often surfaced to the caller by mistake.',
  },
  {
    id: 'flaky',
    label: 'Flaky ticketing',
    flags: ['crmUnavailable', 'serverError'],
    why: 'CRM is unavailable, forcing recovery; ticketing fails once and then accepts the case on retry.',
  },
  {
    id: 'slow',
    label: 'Slow CRM',
    flags: ['slowCrm'],
    why: 'Nothing fails, but the turn blows its conversational budget. Callers hang up on silence, not on errors.',
  },
  {
    id: 'expiry',
    label: 'Token expires mid-call',
    flags: ['tokenExpiry'],
    why: 'Infrastructure noise that must never reach the caller, and must not stampede the identity provider.',
  },
  {
    id: 'duplicate',
    label: 'Lost acknowledgement',
    flags: ['duplicateSubmit'],
    why: 'The write succeeded, the response did not. The classic path to a duplicate change.',
  },
  {
    id: 'silent',
    label: 'CRM goes silent',
    flags: ['timeout'],
    why: 'The address lookup times out. The shared budget stops repeated waits and the agent must not claim the change succeeded.',
  },
  {
    id: 'dead',
    label: 'Dependency down',
    flags: ['crmUnavailable'],
    why: 'CRM is unavailable but ticketing remains reachable, so recovery can leave the caller with a real case reference.',
  },
];
