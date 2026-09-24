import { describe, expect, it } from 'vitest';
import {
  CHAOS_LABELS,
  createEnterpriseApi,
  NO_CHAOS,
  type ChaosFlag,
} from '../src/core/sim/enterpriseApi';
import { EnterpriseClient, POLICY_SLOTS } from '../src/core/integration/client';
import { IdempotencyLedger } from '../src/core/integration/idempotency';
import { TurnBudget } from '../src/core/integration/resilience';
import { Saga } from '../src/core/integration/saga';
import { collector, manualClock } from '../src/core/integration/types';
import { classify, recoveryFor, ALL_RECOVERY_SCRIPTS, type IntegrationError } from '../src/core/integration/errors';
import { mapFields, parseXml, findAll } from '../src/core/integration/mapping';
import { CLAIMS_XML_FIXTURE } from '../src/core/sim/enterpriseApi';
import { Rng } from '../src/core/util/rng';
import { CHAOS_PRESETS, runDeployment } from '../src/demo/deployment';

function harness(flags: Partial<Record<ChaosFlag, boolean>> = {}, budgetMs = 4200) {
  const chaos = { ...NO_CHAOS, ...flags };
  const api = createEnterpriseApi(chaos, new Rng(11));
  const clock = manualClock(0);
  const { events, sink } = collector();
  const budget = new TurnBudget(budgetMs, clock, sink);
  const ledger = new IdempotencyLedger();
  const client = new EnterpriseClient({
    baseUrl: 'https://api.example.invalid',
    tokenUrl: '/oauth/token',
    clientId: 'agent',
    clientSecret: 'secret',
    transport: api.transport,
    clock,
    trace: sink,
    budget,
    ledger,
  });
  return { api, clock, events, client, ledger, budget };
}

describe('integration: happy path', () => {
  it('looks up a policy and maps it into agent slots', async () => {
    const { client } = harness();
    const res = await client.lookupPolicy('IT-2026-004571');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const mapped = mapFields(res.value, POLICY_SLOTS);
    expect(mapped.missingRequired).toEqual([]);
    expect(mapped.values.callerLastName).toBe('Rossi');
    expect(mapped.values.addressOnFile).toBe(
      'Via Melchiorre Gioia, 42, 20124, Milano, MI',
    );
    expect(mapped.values.renewalDateIt).toBe('30/11/2026');
    expect(String(mapped.values.taxCodeMasked)).toMatch(/^RSS\*+/);
  });

  it('reads namespaced XML without losing attributes', async () => {
    const { client } = harness();
    const res = await client.getClaims('IT-2026-004571');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(2);
    expect(res.value[0]).toMatchObject({
      id: 'SIN-2026-88213',
      status: 'in_review',
      causeCode: '04',
      reserveEur: 2450,
    });
    expect(res.value[1]!.status).toBe('settled');
  });

  it('parses the raw document independently of the client', () => {
    const doc = parseXml(CLAIMS_XML_FIXTURE);
    expect(findAll(doc, 'claim')).toHaveLength(2);
    expect(findAll(doc, 'handler')[0]!.attributes.id).toBe('U-3391');
  });
});

describe('integration: token handling', () => {
  it('refreshes an expired token without the caller ever seeing it', async () => {
    const { client, events } = harness({ tokenExpiry: true });
    const first = await client.lookupPolicy('IT-2026-004571');
    expect(first.ok).toBe(true);

    // The identity provider expires the token between two calls. The caller must
    // never learn that this happened.
    const second = await client.lookupPolicy('IT-2026-004571');
    expect(second.ok).toBe(true);
    expect(second.attempts.some((a) => a.outcome === 'retryable')).toBe(true);

    const issued = events.filter((e) => e.label === 'Access token issued');
    expect(issued.length).toBeGreaterThanOrEqual(2);
  });

  it('does not stampede the identity provider when a token expires', async () => {
    const { client, events } = harness();
    await Promise.all([
      client.lookupPolicy('IT-2026-004571'),
      client.lookupPolicy('IT-2026-004571'),
      client.lookupPolicy('IT-2026-004571'),
    ]);
    const issued = events.filter((e) => e.label === 'Access token issued');
    expect(issued).toHaveLength(1);
  });
});

describe('integration: transient failures', () => {
  it('absorbs rate limiting with backoff and still succeeds', async () => {
    const { client, events, clock, budget } = harness({ rateLimit: true });
    const res = await client.lookupPolicy('IT-2026-004571');
    expect(res.ok).toBe(true);
    expect(res.attempts.length).toBeGreaterThan(1);
    expect(res.latencyMs).toBe(clock.now());
    expect(budget.remainingMs).toBe(4200 - clock.now());
    const retries = events.filter((e) => e.kind === 'retry');
    expect(retries.length).toBeGreaterThan(0);
    expect(retries[0]!.detail).toContain('full jitter');
  });

  it('retries a 500 and records every attempt', async () => {
    const { client } = harness({ serverError: true });
    const res = await client.openCase({ subject: 'Address change', body: 'x' }, 'turn-1');
    expect(res.ok).toBe(true);
    expect(res.attempts.some((a) => a.outcome === 'retryable')).toBe(true);
  });

  it('opens the breaker instead of queueing the caller behind a dead dependency', async () => {
    const { client } = harness({ flapping: true });
    for (let i = 0; i < 4; i += 1) {
      await client.lookupPolicy('IT-2026-004571');
    }
    expect(client.breakerState('crm')).toBe('open');
  });

  it('keeps the failure class when retries run out, instead of degrading to unknown', async () => {
    const { client } = harness({ flapping: true });
    const res = await client.lookupPolicy('IT-2026-004571');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('dependency_unavailable');
    expect(res.error.httpStatus).toBe(503);
    // and the script written for a dead dependency is the one that fires
    const script = recoveryFor(res.error, { caseId: 'CS-111222' });
    expect(script.move).toBe('open_ticket');
    expect(script.escalate).toBe(true);
  });

  it('classifies an exhausted attempt ceiling as a timeout, not as unknown', async () => {
    // generous budget, so the per-attempt ceiling is what fails rather than the turn
    const { client } = harness({ timeout: true }, 20_000);
    const res = await client.issueRefund(
      { policyNumber: 'IT-2026-004571', amountEur: 40, reason: 'goodwill' },
      'turn-11',
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('timeout');
    expect(res.error.code).toBe('attempt_ceiling');
  });

  it('converts a blown turn budget into a timeout the agent can speak to', async () => {
    const { client } = harness({ timeout: true }, 3000);
    const res = await client.issueRefund(
      { policyNumber: 'IT-2026-004571', amountEur: 40, reason: 'goodwill' },
      'turn-9',
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('timeout');
    const script = recoveryFor(res.error, { caseId: 'CS-111222' });
    expect(script.move).toBe('open_ticket');
    expect(script.agentLine.it).toContain('CS-111222');
    expect(script.escalate).toBe(false);
  });
});

describe('integration: idempotency', () => {
  it('absorbs a duplicate submission instead of writing twice', async () => {
    const { client, api } = harness({ duplicateSubmit: true });
    const res = await client.updateAddress(
      'IT-2026-004571',
      { street: 'Via Melchiorre Gioia', civic: '42', postalCode: '20124', city: 'Milano' },
      'turn-42',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.replayed).toBe(true);
    expect(api.acceptedWrites).toHaveLength(1);
  });

  it('derives a stable key from intent, not from a request-time uuid', () => {
    const ledger = new IdempotencyLedger();
    const a = ledger.derive('crm.updateAddress', 'IT-2026-004571', 'turn-42');
    const b = ledger.derive('crm.updateAddress', 'IT-2026-004571', 'turn-42');
    const c = ledger.derive('crm.updateAddress', 'IT-2026-004571', 'turn-43');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('integration: saga compensation', () => {
  it('runs completed compensations in reverse order after a later critical step fails', async () => {
    const state = { address: 'old address', notifications: 0 };
    const clock = manualClock(0);
    const { events, sink } = collector();
    const saga = new Saga<typeof state>('addressChange', [
      {
        id: 'write',
        name: 'Apply address',
        critical: true,
        run: async (s) => { s.address = 'new address'; },
        compensate: async (s) => { s.address = 'old address'; },
      },
      {
        id: 'audit',
        name: 'Record audit event',
        critical: true,
        run: async () => { throw new Error('audit store unavailable'); },
      },
    ]);

    const result = await saga.run(state, { clock, trace: sink });

    expect(result.status).toBe('compensated');
    expect(state.address).toBe('old address');
    expect(events.some((event) => event.label.includes('compensation failed'))).toBe(false);
    expect(result.steps.map((step) => step.status)).toEqual(['ok', 'failed', 'compensated']);
  });
});

describe('integration: error taxonomy and recovery', () => {
  it('classifies the statuses that matter', () => {
    expect(classify(401, 'invalid_token', '', 1).kind).toBe('auth_expired');
    expect(classify(429, 'rate_limited', '', 1).kind).toBe('rate_limited');
    expect(classify(503, undefined, '', 1).kind).toBe('dependency_unavailable');
    expect(classify(422, 'validation_failed', '', 1).kind).toBe('validation_rejected');
    expect(classify(404, 'policy_not_found', '', 1).kind).toBe('not_found');
  });

  it('never lets an agent claim a success it cannot evidence', () => {
    for (const script of ALL_RECOVERY_SCRIPTS) {
      expect(script.agentLine.it).not.toMatch(/\b(ho|abbiamo) aggiornato\b|completato con successo/i);
      expect(script.agentLine.en).not.toMatch(/\b(i|we) have updated\b|successfully completed/i);
      expect(script.rationale.length).toBeGreaterThan(20);
    }
  });

  it('escalates unclassified failures rather than improvising', () => {
    const script = recoveryFor(classify(undefined, undefined, 'weird', 1));
    expect(script.escalate).toBe(true);
    expect(script.move).toBe('handoff');
  });

  it('uses terminal recovery after authentication or rate-limit retries are exhausted', () => {
    const auth = recoveryFor(classify(401, 'invalid_token', 'refresh failed', 4));
    expect(auth.move).toBe('handoff');
    expect(auth.escalate).toBe(true);
    expect(auth.agentLine.en).not.toMatch(/one moment|bear with me/i);

    const throttled = recoveryFor(
      classify(429, 'rate_limited', 'still throttled', 4),
      { caseId: 'CS-111222' },
    );
    expect(throttled.move).toBe('open_ticket');
    expect(throttled.escalate).toBe(true);
    expect(throttled.agentLine.en).toContain('CS-111222');
    expect(throttled.agentLine.en).toContain('cannot confirm');
  });

  it('keeps every recovery script bilingual', () => {
    for (const script of ALL_RECOVERY_SCRIPTS) {
      expect(script.agentLine.en.length).toBeGreaterThan(10);
      expect(script.agentLine.it.length).toBeGreaterThan(10);
    }
  });

  it('labels every chaos flag for the console', () => {
    const flags = Object.keys(NO_CHAOS) as ChaosFlag[];
    expect(flags).toHaveLength(8);
    for (const flag of flags) {
      expect(CHAOS_LABELS[flag].label.length).toBeGreaterThan(3);
      expect(CHAOS_LABELS[flag].note.length).toBeGreaterThan(10);
    }
  });
});

describe('integration: mapping', () => {
  it('reports missing required fields instead of inventing them', () => {
    const result = mapFields({ product: 'Auto' }, POLICY_SLOTS);
    expect(result.missingRequired).toContain('policyNumber');
    expect(result.missingRequired).toContain('callerLastName');
    expect(result.values.policyNumber).toBeUndefined();
  });

  it('reads through arrays and applies transforms in order', () => {
    const result = mapFields(
      { items: [{ name: '  giulia rossi ' }] },
      [{ to: 'name', from: 'items.0.name', transform: ['trim', 'titleCase'] }],
    );
    expect(result.values.name).toBe('Giulia Rossi');
  });
});

/**
 * The deployment transcript is carried in both locales the run happens in, so the
 * language a reviewer reads it in can never change the run itself. These tests hold
 * that line: the wording is translated, the engineering is not.
 */
describe('deployment: one run, readable in both locales', () => {
  const ITALIAN_MARKERS = [
    'Buongiorno',
    'polizza',
    'indirizzo',
    'pratica',
    'codice fiscale',
    'Riceverà',
    'corretto',
    'non sono riuscito',
  ];

  const ENGLISH_MARKERS = [
    'Good morning',
    'the address we hold',
    'I have opened case',
    'please do not treat',
    'your policy',
    'case reference',
  ];

  it('carries every line in both locales, for every preset a reviewer can click', async () => {
    for (const preset of CHAOS_PRESETS) {
      const run = await runDeployment(preset.flags);
      // the shortest run is disclosure + two caller turns + a recovery script
      expect(run.transcript.length, preset.id).toBeGreaterThan(3);
      for (const line of run.transcript) {
        expect(line.text['it-IT'].trim().length, preset.id).toBeGreaterThan(0);
        expect(line.text['en-GB'].trim().length, preset.id).toBeGreaterThan(0);
      }
    }
  });

  it('never leaves a template placeholder in a line the agent would say', async () => {
    for (const preset of CHAOS_PRESETS) {
      const run = await runDeployment(preset.flags);
      for (const line of run.transcript) {
        expect(line.text['it-IT'], preset.id).not.toContain('{');
        expect(line.text['en-GB'], preset.id).not.toContain('{');
      }
    }
  });

  it('serves an English transcript with no Italian left in it', async () => {
    for (const preset of CHAOS_PRESETS) {
      const run = await runDeployment(preset.flags);
      const english = run.transcript.map((l) => l.text['en-GB']).join(' ');
      for (const token of ITALIAN_MARKERS) {
        expect(english, `${preset.id} leaked "${token}"`).not.toContain(token);
      }
    }
  });

  it('serves an Italian transcript with no English left in it', async () => {
    for (const preset of CHAOS_PRESETS) {
      const run = await runDeployment(preset.flags);
      const italian = run.transcript.map((l) => l.text['it-IT']).join(' ');
      for (const token of ENGLISH_MARKERS) {
        expect(italian, `${preset.id} leaked "${token}"`).not.toContain(token);
      }
    }
  });

  it('routes the recovery line through the reviewed script table, per locale', async () => {
    let recovered = 0;
    for (const preset of CHAOS_PRESETS) {
      const run = await runDeployment(preset.flags);
      for (const line of run.transcript.filter((l) => l.recovered)) {
        recovered += 1;
        expect(line.text['en-GB'], preset.id).not.toBe(line.text['it-IT']);
        expect(line.text['en-GB'], preset.id).not.toMatch(/polizza|pratica|collega/);
        expect(line.text['it-IT'], preset.id).not.toMatch(/policy|address|colleague/);
      }
    }
    // without this the suite would pass vacuously if no preset reached recovery
    expect(recovered).toBeGreaterThan(0);
  });

  it('reaches the purpose-written script when a dependency is down', async () => {
    // the demo's most dramatic preset has to demonstrate the script written for it,
    // not the generic fallback
    const run = await runDeployment(['crmUnavailable']);
    const recovered = run.transcript.filter((l) => l.recovered);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].note).toContain('"dependency_unavailable"');
    expect(recovered[0].text['en-GB']).toContain('cannot reach the system');
    expect(recovered[0].text['it-IT']).toContain('non riesco a raggiungere');
    expect(recovered[0].text['en-GB']).toMatch(/CS-\d{6}/);
  });

  it('makes the CRM timeout preset consume the shared budget instead of acting like a clean run', async () => {
    const preset = CHAOS_PRESETS.find((p) => p.id === 'silent')!;
    const clean = await runDeployment([]);
    const run = await runDeployment(preset.flags);
    expect(run.metrics.totalMs).toBeGreaterThan(clean.metrics.totalMs);
    expect(run.metrics.remainingMs).toBe(0);
    expect(run.trace.some((event) => event.kind === 'timeout')).toBe(true);
    expect(run.outcome).not.toBe('resolved');
    const recovery = run.transcript.find((line) => line.recovered)!;
    expect(recovery.text['en-GB']).toContain('do not assume the address has been updated');
    expect(recovery.text['en-GB']).not.toContain('I have opened case');
  });

  it('retries transient ticketing failure and gives the caller the acknowledged case reference', async () => {
    const preset = CHAOS_PRESETS.find((p) => p.id === 'flaky')!;
    const run = await runDeployment(preset.flags);
    const recovery = run.transcript.find((line) => line.recovered)!;
    expect(run.metrics.retries).toBeGreaterThan(0);
    expect(run.trace.some((event) => event.label.includes('ticketing.openCase retry'))).toBe(true);
    expect(recovery.text['en-GB']).toMatch(/CS-\d{6}/);
    expect(recovery.text['it-IT']).toMatch(/CS-\d{6}/);
  });
});

/**
 * A recovery line is the last thing a caller hears before the call ends, and it is
 * the one sentence in the whole kit that must never be improvised. These tests cover
 * the seam where the wording is assembled: the case reference, and the language.
 */
describe('integration: recovery wording', () => {
  const asError = (kind: IntegrationError['kind']): IntegrationError => ({
    kind,
    message: 'x',
    retryable: false,
    attempts: 1,
  });

  it('uses the actual case reference when ticketing acknowledged the case', () => {
    const script = recoveryFor(asError('dependency_unavailable'), { caseId: 'CS-111222' });
    expect(script.agentLine.en).toContain('CS-111222');
    expect(script.agentLine.it).toContain('CS-111222');
    expect(script.agentLine.en).not.toContain('{caseId}');
    expect(script.agentLine.it).not.toContain('{caseId}');
  });

  it('never claims a case was opened when no reference was returned', () => {
    const script = recoveryFor(asError('dependency_unavailable'));
    expect(script.move).toBe('handoff');
    expect(script.escalate).toBe(true);
    expect(script.agentLine.en).toContain('could not open a case reference');
    expect(script.agentLine.it).toContain('non sono riuscito ad aprire');
    expect(script.agentLine.en).not.toContain('I have opened case');
    expect(script.agentLine.it).not.toContain('Ho aperto la pratica');
  });

  it('leaves no untranslated placeholder, with or without a case reference', () => {
    for (const script of ALL_RECOVERY_SCRIPTS) {
      for (const vars of [{}, { caseId: 'CS-111222' }]) {
        const filled = recoveryFor(asError(script.kind), vars);
        expect(filled.agentLine.en, script.kind).not.toContain('{');
        expect(filled.agentLine.it, script.kind).not.toContain('{');
      }
    }
  });

  it('never leaves an English fallback inside an Italian sentence', () => {
    for (const script of ALL_RECOVERY_SCRIPTS) {
      const filled = recoveryFor(asError(script.kind));
      expect(filled.agentLine.it, script.kind).not.toMatch(/new case|logged|bear with|one moment/i);
    }
  });
});
