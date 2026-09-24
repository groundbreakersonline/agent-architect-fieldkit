import { Section } from '../ui/bits';

const ADRS = [
  {
    id: 'ADR-001',
    title: 'The turn budget is shared across every dependency',
    body: 'Per-dependency timeouts are respected individually and add up. A caller does not experience four 2.5-second timeouts, they experience ten seconds of silence. One budget is opened at the start of a turn and every call spends against it, so the last dependency to be tried cannot be the one that breaks the experience.',
  },
  {
    id: 'ADR-002',
    title: 'Idempotency keys are derived from intent, not from a request',
    body: 'A key generated at request time protects against a retry inside one process. It does not protect against a pod restart, a queue redelivery, or an engineer replaying a turn from a support console - which is where duplicate refunds and duplicate address changes actually come from. The key is a function of the operation, the subject, and the turn that expressed it.',
  },
  {
    id: 'ADR-003',
    title: 'A timeout is a failure of the acknowledgement, not of the request',
    body: 'When a write times out, the write may well have succeeded. Blindly re-submitting is how duplicates happen; reporting failure is how customers are told the opposite of the truth. The correct move is to log the intent with a reference the caller can quote, and reconcile out of band.',
  },
  {
    id: 'ADR-004',
    title: 'Every integration error class has a pre-approved sentence',
    body: 'An integration error is a system fact; a caller experiences it as a sentence. Most deployments handle the first and improvise the second, which is why "escalation problems" so often turn out to be wording problems. Each class maps to a move and to reviewed wording in both languages, and the suite asserts the agent never claims an outcome it cannot evidence.',
  },
  {
    id: 'ADR-005',
    title: 'Verbalisation rules live in code, with provenance',
    body: 'Whether an IBAN is read in groups of four, whether "IT" is spelled or pronounced as a word, whether the first of the month takes an ordinal: these are decisions. They are reviewed by a linguist, attributed to a brand standard, a legal obligation or an observed ASR failure, and asserted in CI character for character.',
  },
  {
    id: 'ADR-006',
    title: 'The gate blocks on categories and reports on statistics',
    body: 'Statistical questions need samples and a significance test, or every release is blocked by noise. Categorical questions need none: one unauthorised refund is the whole answer. Conflating the two is how a release that improves containment by ten points also ships five broken guarantees.',
  },
  {
    id: 'ADR-007',
    title: 'The judge is an interface, not a vendor',
    body: 'The offline rubric runs in CI, free, offline and deterministically. A model-backed judge implements the same one-method interface. An evaluation harness whose judge silently changes version under you is worse than no harness, so the seam is explicit and the default is the boring one.',
  },
  {
    id: 'ADR-008',
    title: 'Evidence is an index, not a compliance attestation',
    body: 'The pack indexes explicit technical signals from the same trace as the run. A link means an event was recorded, not that a legal obligation is discharged. Applicability, provider residency, production identity assurance and consent validity need evidence and review outside this fixture; missing signals remain gaps.',
  },
];

const RUNBOOK = [
  {
    symptom: 'Callers hang up during the call',
    first: 'p95 turn latency by stage, not the mean.',
    because:
      'A mean hides the exact calls that produce silence. Look at STT, model and tool p95 separately before blaming the model.',
  },
  {
    symptom: 'Escalation rate rose without a change in volume',
    first: 'Instruction adherence on the never_says set.',
    because:
      'Callers escalate when they feel dismissed or forced to repeat themselves. Tone drift and rigid phrasing erode trust faster than factual errors.',
  },
  {
    symptom: 'Duplicate changes reported by the system of record',
    first: 'The idempotency ledger and the write count per turn.',
    because:
      'More accepted writes than intended writes is a retry problem, not a data problem. Check the key derivation before adding a unique constraint.',
  },
  {
    symptom: 'A dependency degraded and nobody noticed',
    first: 'Breaker transitions and retry counts on the CDR.',
    because:
      'A breaker that opens silently converts an outage into a slightly worse conversation. That is the right behaviour only if somebody is told.',
  },
  {
    symptom: 'Compliance asks for evidence of a specific call',
    first: 'The evidence pack, filtered by obligation.',
    because:
      'If the answer requires reconstructing a conversation from logs, the instrumentation is missing at the point where it matters.',
  },
];

export function Architecture() {
  return (
    <div className="panel doc">
      <p className="lede">
        The parts of an agent deployment that decide whether it survives contact with a
        real enterprise: how the chain is ordered, what happens when a dependency lies
        to you, how the caller hears it, and what you can prove afterwards. Below are
        the decisions, the runbook, and the workflow that turns a field problem into a
        tested asset.
      </p>

      <div className="grid--even" style={{ display: 'grid', gap: 34 }}>
        <div>
          <Section title="Logical reference flow" note="conceptual; voice providers and residency are out of scope">
            <pre className="block">{`caller
  │  audio
  ▼
speech-to-text ──────────────────► provider / region not modelled
  │  transcript
  ▼
conversation orchestrator
  │
   ├── explicit AI disclosure       Article 50(1)
   ├── recording notice / response  (fixture only)
  ├── intent + slot resolution
  │      │
  │      ▼
  │   ┌──────────────────────────────────────────────┐
  │   │ integration layer  (this kit)                │
  │   │                                              │
  │   │  turn budget ── shared across the whole turn │
  │   │  token provider ── single-flight refresh     │
  │   │  retry ── backoff + full jitter              │
  │   │  breaker ── fail fast, not queue             │
  │   │  idempotency ── intent-derived keys          │
  │   │  mapping ── JSON/XML → slots, explicit gaps  │
  │   │  saga ── ordered steps + compensation        │
  │   └──────────────┬───────────────────────────────┘
  │                  │
  │      ┌───────────┼───────────┬────────────┐
  │      ▼           ▼           ▼            ▼
   │    CRM       ticketing    claims       billing
  │   (OAuth)     (JSON)       (XML)      (silent?)
  │
  ├── recovery script ── one per error class, bilingual
  ├── evidence trail ── every event, indexed by obligation
  ▼
text-to-speech ◄── verbalisation rules + SSML + lexicon
  │  audio
   ▼
caller

The demo implements the integration boundary only; it does not process audio or assert EU residency.`}</pre>
          </Section>

          <Section title="Field problem → tested asset" note="how the kit is meant to grow">
            <p>
              The suite contains representative failure modes, not incidents claimed to
              have been observed in a specific production system. The loop for turning a
              real field report into a tested asset is deliberately short:
            </p>
            <ul>
              <li>
                <strong>Observe</strong> - a call fails in a way the suite does not
                cover. It is captured as a conversation, not as an anecdote.
              </li>
              <li>
                <strong>Classify</strong> - is this an integration fact, a wording
                problem, or a missing guarantee? These three have different owners.
              </li>
              <li>
                <strong>Encode</strong> - an integration fact becomes a chaos flag and a
                recovery script; a wording problem becomes a verbalisation rule with
                provenance; a missing guarantee becomes a critical scenario.
              </li>
              <li>
                <strong>Assert</strong> - the scenario joins the suite and the gate
                blocks on it from then on. The conversation that caused the incident is
                now the thing that prevents the next one.
              </li>
              <li>
                <strong>Publish</strong> - the pattern goes into the runbook and, where
                it is a product gap, into structured feedback for the platform.
              </li>
            </ul>
          </Section>
        </div>

        <div>
          <Section title="Decisions" note="the reasoning, not just the code">
            {ADRS.map((adr) => (
              <div className="adr" key={adr.id}>
                <span className="adr__id">{adr.id}</span>
                <h3 className="adr__t">{adr.title}</h3>
                <p className="adr__d">{adr.body}</p>
              </div>
            ))}
          </Section>

          <Section title="Runbook" note="what to look at first, and why">
            <table className="table">
              <thead>
                <tr>
                  <th>Symptom</th>
                  <th>First look at</th>
                </tr>
              </thead>
              <tbody>
                {RUNBOOK.map((r) => (
                  <tr key={r.symptom}>
                    <td style={{ fontSize: 13 }}>{r.symptom}</td>
                    <td>
                      <div className="mono" style={{ fontSize: 11.5 }}>
                        {r.first}
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {r.because}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </div>
      </div>
    </div>
  );
}
