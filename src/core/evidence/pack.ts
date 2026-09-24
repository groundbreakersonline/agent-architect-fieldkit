/**
 * Audit evidence.
 *
 * This module builds an illustrative evidence index from the trace emitted by a run.
 * Its purpose is to make evidence wiring inspectable: which raw events can be linked
 * to a selected obligation, and which expected signals are missing.
 * A linked event is a technical signal, not a legal finding or a compliance
 * certification. Applicability, identity assurance, consent validity and provider
 * residency require independent source evidence and review.
 */
import type { TraceEvent } from '../integration/types';

export type Framework = 'EU_AI_ACT' | 'GDPR' | 'DORA' | 'INTERNAL';

export interface Obligation {
  id: string;
  framework: Framework;
  reference: string;
  title: string;
  /** What has to be demonstrable, in plain language. */
  requirement: string;
}

/**
 * A small, illustrative set of obligations to which technical signals may be linked.
 *
 * Deliberately a short, defensible list rather than a comprehensive one. A pack that
 * claims to cover everything covers nothing, because nobody can check it.
 */
export const OBLIGATIONS: Obligation[] = [
  {
    id: 'AIA-50-1',
    framework: 'EU_AI_ACT',
    reference: 'Article 50(1)',
    title: 'Disclosure that the user is interacting with an AI system',
    requirement:
      'The natural person must be informed that they are interacting with an AI system, at the latest at the time of the first interaction.',
  },
  {
    id: 'AIA-12',
    framework: 'EU_AI_ACT',
    reference: 'Article 12',
    title: 'Record-keeping and automatic logging',
    requirement:
      'The system must technically allow for the automatic recording of events over its lifetime, with logs that permit the reconstruction of decisions.',
  },
  {
    id: 'AIA-14',
    framework: 'EU_AI_ACT',
    reference: 'Article 14',
    title: 'Human oversight',
    requirement:
      'The system must allow effective oversight by natural persons, including the ability to intervene or interrupt, and to interpret the output.',
  },
  {
    id: 'AIA-15',
    framework: 'EU_AI_ACT',
    reference: 'Article 15',
    title: 'Accuracy, robustness and cybersecurity',
    requirement:
      'The system must achieve an appropriate level of accuracy and be resilient to errors, faults and attempts to alter its use.',
  },
  {
    id: 'GDPR-5-1-f',
    framework: 'GDPR',
    reference: 'Article 5(1)(f)',
    title: 'Integrity and confidentiality',
    requirement:
      'Personal data must be processed in a manner that ensures appropriate security, including protection against unauthorised processing.',
  },
  {
    id: 'GDPR-22',
    framework: 'GDPR',
    reference: 'Article 22',
    title: 'Automated individual decision-making',
    requirement:
      'A decision producing legal or similarly significant effects must not be based solely on automated processing without a route to human intervention.',
  },
  {
    id: 'GDPR-32',
    framework: 'GDPR',
    reference: 'Article 32',
    title: 'Security of processing',
    requirement:
      'Technical and organisational measures appropriate to the risk, including the ability to restore availability and to test the effectiveness of controls.',
  },
  {
    id: 'DORA-8',
    framework: 'DORA',
    reference: 'Article 8',
    title: 'Identification of ICT-supported business functions',
    requirement:
      'Financial entities must identify and document the functions supported by ICT third-party providers, and the dependencies between them.',
  },
  {
    id: 'DORA-11',
    framework: 'DORA',
    reference: 'Article 11',
    title: 'Response and recovery',
    requirement:
      'Continuity policies must allow for the response, recovery and restoration of services after an ICT-related incident, including measured recovery capability.',
  },
  {
    id: 'INTERNAL-NO-UNPROVEN-CLAIM',
    framework: 'INTERNAL',
    reference: 'Brand standard',
    title: 'The agent never claims an outcome it cannot evidence',
    requirement:
      'Where a write did not succeed, the agent must not state that it did. Where a write did succeed, the agent must state it only after the acknowledgement was received.',
  },
];

// ---------------------------------------------------------------------------

export type EvidenceKind =
  | 'ai_disclosure'
  | 'consent'
  | 'identity_challenge'
  | 'data_egress'
  | 'pii_redaction'
  | 'tool_ledger'
  | 'human_oversight'
  | 'failure_handling'
  | 'prohibited_action_blocked'
  /** A recorded judgement that an obligation does not apply, with its reasoning. */
  | 'assessment';

export interface EvidenceRecord {
  id: string;
  at: number;
  kind: EvidenceKind;
  summary: string;
  /** Which obligations this record contributes to. */
  satisfies: string[];
  /** The underlying event, kept verbatim so the pack can be audited. */
  raw?: unknown;
}

export interface EvidencePack {
  conversationId: string;
  generatedFor: string;
  records: EvidenceRecord[];
  obligations: Array<
    Obligation & {
      status: 'evidence_present' | 'gap';
      evidenceIds: string[];
      /** Why this is a gap. A gap without a reason is not a control, it is an omission. */
      gapReason?: string;
    }
  >;
  coverage: { evidencePresent: number; total: number };
}

export interface BuildPackInput {
  conversationId: string;
  generatedFor: string;
  trace: TraceEvent[];
}

/**
 * Builds the pack.
 *
 * Note what it does with the trace: it does not summarise it, it indexes it. A
 * compliance reviewer needs to be able to go from an obligation to the exact event
 * that discharges it, in one hop.
 */
export function buildEvidencePack(input: BuildPackInput): EvidencePack {
  const records: EvidenceRecord[] = [];
  let seq = 0;
  const add = (
    kind: EvidenceKind,
    at: number,
    summary: string,
    satisfies: string[],
    raw?: unknown,
  ): EvidenceRecord => {
    const record: EvidenceRecord = { id: `E${++seq}`, at, kind, summary, satisfies, raw };
    records.push(record);
    return record;
  };

  // 1. Compliance signals. Only explicit events emitted into the trace are indexed;
  //    caller-supplied booleans are deliberately not accepted as evidence.
  const complianceEvents = input.trace.filter((e) => e.kind === 'compliance');
  const evidenceKind = (event: TraceEvent) => String(event.meta?.evidenceKind ?? '');

  for (const event of complianceEvents) {
    const meta = event.meta ?? {};
    switch (evidenceKind(event)) {
      case 'ai_disclosure': {
        const explicit = meta.explicitAiDisclosure === true;
        const onTime = event.at <= 1500;
        add(
          'ai_disclosure',
          event.at,
          `${event.label}; ${explicit ? 'explicit AI wording recorded' : 'explicit AI wording not verified'}; ${onTime ? 'within' : 'outside'} the 1500ms fixture threshold.`,
          explicit && onTime && event.status === 'ok' ? ['AIA-50-1'] : [],
          event,
        );
        break;
      }
      case 'recording_acknowledgement':
        add(
          'consent',
          event.at,
          'A scripted caller acknowledgement was recorded. This is not a legal determination that consent is required or valid.',
          [],
          event,
        );
        break;
      case 'identity_challenge':
        add(
          'identity_challenge',
          event.at,
          'A masked identifier challenge was acknowledged in the scripted fixture; this is not production identity proof.',
          [],
          event,
        );
        break;
      case 'data_residency': {
        const stage = String(meta.stage ?? 'unknown stage');
        const region = String(meta.region ?? 'unknown');
        const sourceVerified = meta.sourceVerified === true;
        add(
          'data_egress',
          event.at,
          `${stage} residency recorded as ${region}${sourceVerified ? ' from a verified provider source' : ' without a verified provider source'}.`,
          region === 'EU' && sourceVerified && event.status === 'ok' ? ['GDPR-32'] : [],
          event,
        );
        break;
      }
      case 'pii_redaction': {
        const fields = Array.isArray(meta.fields) ? meta.fields.map(String) : [];
        const verified = meta.boundarySanitized === true && event.status === 'ok';
        add(
          'pii_redaction',
          event.at,
          verified
            ? `${fields.length} field(s) were redacted by the recorded boundary control.`
            : 'A redaction signal was reported, but the boundary control was not verified.',
          verified ? ['GDPR-5-1-f', 'GDPR-32'] : [],
          event,
        );
        break;
      }
      case 'simulated_handoff':
        add(
          'human_oversight',
          event.at,
          'The demo selected a handoff path; no external human queue or completed transfer is connected.',
          meta.handoffCompleted === true && event.status === 'ok' ? ['AIA-14'] : [],
          event,
        );
        break;
    }
  }

  // 3. The tool ledger. Every call that touched an enterprise system, in order.
  const httpEvents = input.trace.filter((e) => e.kind === 'http');
  for (const event of httpEvents) {
    add(
      'tool_ledger',
      event.at,
      `${event.label} - ${event.detail ?? event.status}`,
      ['AIA-12'],
      event,
    );
  }

  const writeEvents = httpEvents.filter((e) => /\/address|\/refunds/.test(e.label));
  const writeAcknowledged = writeEvents.some((e) => e.status === 'ok');
  const outcomeSignal = complianceEvents.find((e) => evidenceKind(e) === 'agent_outcome');
  if (outcomeSignal) {
    const claimedSuccess = outcomeSignal.meta?.claimedSuccess === true;
    const claimIsSupported =
      !claimedSuccess ||
      (writeAcknowledged &&
        outcomeSignal.meta?.writeAcknowledged === true &&
        outcomeSignal.at >= Math.max(...writeEvents.filter((e) => e.status === 'ok').map((e) => e.at)));
    add(
      claimIsSupported ? 'assessment' : 'failure_handling',
      outcomeSignal.at,
      claimIsSupported
        ? claimedSuccess
          ? 'The agent success statement followed an acknowledged write in the trace.'
          : 'The agent recorded that the write was unconfirmed and made no success claim.'
        : 'The agent asserted success without a preceding write acknowledgement.',
      claimIsSupported ? ['INTERNAL-NO-UNPROVEN-CLAIM'] : [],
      outcomeSignal,
    );
  }

  // 4. Failure handling, from the resilience layer's own events.
  const failures = input.trace.filter((e) => e.status === 'error' || e.kind === 'retry' || e.kind === 'breaker');
  for (const event of failures) {
    add(
      'failure_handling',
      event.at,
      `${event.label}${event.detail ? ` - ${event.detail}` : ''}`,
      ['AIA-15', 'DORA-11'],
      event,
    );
  }

  // Human control and legal applicability are not inferred from an agent's words
  // or from the fact that a demo run happened not to escalate.

  // 6. Prohibited actions the guardrails stopped.
  const blocked = input.trace.filter((e) => e.kind === 'guardrail');
  for (const event of blocked) {
    add('prohibited_action_blocked', event.at, event.label, ['AIA-15'], event);
  }

  const obligations = OBLIGATIONS.map((o) => {
    const evidenceIds = records.filter((r) => r.satisfies.includes(o.id)).map((r) => r.id);
    return {
      ...o,
      status: evidenceIds.length > 0 ? ('evidence_present' as const) : ('gap' as const),
      evidenceIds,
      gapReason:
        evidenceIds.length === 0
          ? o.id === 'GDPR-22'
            ? 'No signed applicability assessment or completed human-decision evidence was emitted by this run.'
            : 'No qualifying source-linked event was emitted by this run. This illustrative pack does not establish legal compliance.'
          : undefined,
    };
  });

  return {
    conversationId: input.conversationId,
    generatedFor: input.generatedFor,
    records,
    obligations,
    coverage: {
      evidencePresent: obligations.filter((o) => o.status === 'evidence_present').length,
      total: obligations.length,
    },
  };
}

export function packToJson(pack: EvidencePack): string {
  return JSON.stringify(
    {
      schema: 'agent-architect-fieldkit/evidence-pack/v2',
      conversationId: pack.conversationId,
      generatedFor: pack.generatedFor,
      coverage: pack.coverage,
      obligations: pack.obligations.map((o) => ({
        id: o.id,
        framework: o.framework,
        reference: o.reference,
        title: o.title,
        status: o.status,
        evidence: o.evidenceIds,
        gapReason: o.gapReason,
      })),
      records: pack.records,
    },
    null,
    2,
  );
}
