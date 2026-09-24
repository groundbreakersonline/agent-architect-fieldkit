import { describe, expect, it } from 'vitest';
import { buildEvidencePack, packToJson, OBLIGATIONS } from '../src/core/evidence/pack';
import type { TraceEvent } from '../src/core/integration/types';

const trace: TraceEvent[] = [
  {
    at: 0,
    kind: 'compliance',
    status: 'ok',
    label: 'AI disclosure played',
    meta: { evidenceKind: 'ai_disclosure', explicitAiDisclosure: true, source: 'test fixture' },
  },
  {
    at: 120,
    kind: 'compliance',
    status: 'ok',
    label: 'Scripted recording acknowledgement',
    meta: { evidenceKind: 'recording_acknowledgement' },
  },
  {
    at: 220,
    kind: 'compliance',
    status: 'info',
    label: 'Masked identifier challenge acknowledged',
    meta: { evidenceKind: 'identity_challenge' },
  },
  { at: 300, kind: 'auth', status: 'ok', label: 'Access token issued' },
  { at: 480, kind: 'http', status: 'ok', label: 'GET /crm/v2/policies/IT-2026-004571', latencyMs: 96 },
  { at: 900, kind: 'retry', status: 'warn', label: 'crm.updateAddress retry 1/3', detail: 'Rate limited.' },
  { at: 1400, kind: 'http', status: 'ok', label: 'POST /crm/v2/policies/IT-2026-004571/address', latencyMs: 88 },
  { at: 1600, kind: 'breaker', status: 'error', label: 'crm breaker closed -> open' },
  { at: 1700, kind: 'guardrail', status: 'warn', label: 'Blocked refund request without entitlement check' },
  {
    at: 1800,
    kind: 'compliance',
    status: 'ok',
    label: 'Agent confirmed the write after acknowledgement',
    meta: { evidenceKind: 'agent_outcome', writeAcknowledged: true, claimedSuccess: true },
  },
];

const pack = (traceEvents: TraceEvent[] = trace) =>
  buildEvidencePack({
    conversationId: 'call-1',
    generatedFor: 'simulated fixture',
    trace: traceEvents,
  });

describe('evidence: trace-linked, not asserted by caller-supplied booleans', () => {
  it('links only explicit trace events to obligations', () => {
    const result = pack();
    const toolLedger = result.records.filter((r) => r.kind === 'tool_ledger');
    expect(toolLedger.length).toBeGreaterThanOrEqual(2);
    expect(toolLedger.every((r) => r.satisfies.includes('AIA-12'))).toBe(true);
    expect(toolLedger.every((r) => !r.satisfies.includes('DORA-8'))).toBe(true);

    const disclosure = result.obligations.find((o) => o.id === 'AIA-50-1')!;
    expect(disclosure.status).toBe('evidence_present');
    expect(disclosure.evidenceIds).toHaveLength(1);

    const consent = result.records.find((r) => r.kind === 'consent')!;
    expect(consent.satisfies).toEqual([]);
    expect(consent.summary).toMatch(/not a legal determination/i);

    const identity = result.records.find((r) => r.kind === 'identity_challenge')!;
    expect(identity.satisfies).toEqual([]);
    expect(identity.summary).toMatch(/not production identity proof/i);

    expect(result.obligations.find((o) => o.id === 'INTERNAL-NO-UNPROVEN-CLAIM')?.status)
      .toBe('evidence_present');
  });

  it('does not count a late disclosure or a disclosure without explicit AI wording', () => {
    const late = pack([
      {
        at: 4000,
        kind: 'compliance',
        status: 'ok',
        label: 'Disclosure',
        meta: { evidenceKind: 'ai_disclosure', explicitAiDisclosure: true },
      },
    ]);
    const lateObligation = late.obligations.find((o) => o.id === 'AIA-50-1')!;
    expect(lateObligation.status).toBe('gap');
    expect(late.records[0]?.summary).toContain('outside');

    const vague = pack([
      {
        at: 0,
        kind: 'compliance',
        status: 'ok',
        label: 'Virtual assistant disclosure',
        meta: { evidenceKind: 'ai_disclosure', explicitAiDisclosure: false },
      },
    ]);
    expect(vague.obligations.find((o) => o.id === 'AIA-50-1')?.status).toBe('gap');
  });

  it('records an unsupported success claim as a violation, not evidence', () => {
    const result = pack([
      { at: 100, kind: 'http', status: 'error', label: 'POST /crm/v2/policies/1/address' },
      {
        at: 200,
        kind: 'compliance',
        status: 'ok',
        label: 'Agent claimed success',
        meta: { evidenceKind: 'agent_outcome', writeAcknowledged: false, claimedSuccess: true },
      },
    ]);
    const violation = result.records.find((r) => r.kind === 'failure_handling' && !r.satisfies.length);
    expect(violation).toBeDefined();
    expect(violation!.summary).toMatch(/without a preceding write acknowledgement/i);
    expect(result.obligations.find((o) => o.id === 'INTERNAL-NO-UNPROVEN-CLAIM')?.status).toBe('gap');
  });

  it('does not infer provider residency from an unverified region label', () => {
    const result = pack([
      {
        at: 100,
        kind: 'compliance',
        status: 'ok',
        label: 'Model residency',
        meta: { evidenceKind: 'data_residency', stage: 'model orchestration', region: 'EU', sourceVerified: false },
      },
    ]);
    const egress = result.records.find((r) => r.kind === 'data_egress')!;
    expect(egress.summary).toContain('without a verified provider source');
    expect(egress.satisfies).toEqual([]);
    expect(result.obligations.find((o) => o.id === 'GDPR-32')?.status).toBe('gap');
  });

  it('keeps human oversight and Article 22 open without completed handoff evidence and sign-off', () => {
    const result = pack([
      {
        at: 300,
        kind: 'compliance',
        status: 'warn',
        label: 'Handoff selected in demo',
        meta: { evidenceKind: 'simulated_handoff', handoffCompleted: false },
      },
    ]);
    expect(result.obligations.find((o) => o.id === 'AIA-14')?.status).toBe('gap');
    const art22 = result.obligations.find((o) => o.id === 'GDPR-22')!;
    expect(art22.status).toBe('gap');
    expect(art22.gapReason).toMatch(/signed applicability assessment/i);
    expect(result.records.find((r) => r.kind === 'human_oversight')?.satisfies).toEqual([]);
  });

  it('exports a versioned evidence index and explains every gap', () => {
    const result = pack();
    expect(result.obligations.every((o) => o.status !== 'gap' || Boolean(o.gapReason))).toBe(true);
    const json = JSON.parse(packToJson(result)) as {
      schema: string;
      coverage: { evidencePresent: number; total: number };
      obligations: unknown[];
    };
    expect(json.schema).toBe('agent-architect-fieldkit/evidence-pack/v2');
    expect(json.coverage.total).toBe(OBLIGATIONS.length);
    expect(json.obligations).toHaveLength(OBLIGATIONS.length);
  });
});
