import { useState } from 'react';
import { CHAOS_LABELS, type ChaosFlag } from '../core/sim/enterpriseApi';
import { CHAOS_PRESETS, type DeploymentRun } from '../demo/deployment';
import type { Lang } from '../core/voice/numbers';
import { Chip, Section, Stat, StatRow } from '../ui/bits';

export function Deployment({
  chaos,
  onToggleChaos,
  onPreset,
  run,
  revealed,
  running,
  onRun,
}: {
  chaos: ChaosFlag[];
  onToggleChaos: (flag: ChaosFlag) => void;
  onPreset: (flags: ChaosFlag[]) => void;
  run: DeploymentRun | null;
  revealed: number;
  running: boolean;
  onRun: () => void;
}) {
  /**
   * Reading choice, not a run parameter: every run carries both locales, so
   * switching here re-renders the transcript without touching trace or metrics.
   */
  const [lang, setLang] = useState<Lang>('it-IT');

  const flags = Object.keys(CHAOS_LABELS) as ChaosFlag[];
  const activePreset = CHAOS_PRESETS.find(
    (p) => p.flags.length === chaos.length && p.flags.every((f) => chaos.includes(f)),
  );

  return (
    <div className="panel">
      <p className="lede">
        One conversation, executed against a deliberately awkward enterprise backend.
        Switch on a failure mode and watch where it lands: absorbed inside the turn,
        converted into a case reference the caller can quote, or escalated to a human
        in the simulated flow. Ticketing is available for the scoped CRM outage; no live
        enterprise system or human queue is connected. Timings are virtual backend
        timings, not end-to-end voice latency. <strong>No recovery wording is improvised.</strong>
      </p>

      <div className="grid">
        <div>
          <Section title="Presets" note="start here">
            <div className="btn-row">
              {CHAOS_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`btn ${activePreset?.id === p.id ? '' : 'btn--ghost'}`}
                  onClick={() => onPreset(p.flags)}
                  title={p.why}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {activePreset ? (
              <p className="lede" style={{ marginTop: 10, marginBottom: 0, fontSize: 13 }}>
                {activePreset.why}
              </p>
            ) : null}
          </Section>

          <Section title="Failure injection" note="composable">
            {flags.map((flag) => {
              const on = chaos.includes(flag);
              return (
                <label key={flag} className="switch" data-on={on}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => onToggleChaos(flag)}
                  />
                  <span className="switch__body">
                    <span className="switch__label">{CHAOS_LABELS[flag].label}</span>
                    <span className="switch__note">{CHAOS_LABELS[flag].note}</span>
                  </span>
                </label>
              );
            })}
          </Section>

          <div className="btn-row" style={{ marginBottom: 26 }}>
            <button type="button" className="btn" onClick={onRun} disabled={running}>
              {running ? 'Recording…' : 'Run conversation'}
            </button>
          </div>

          {run ? (
            <Section title="Chain" note="ordered, with compensation">
              <table className="table">
                <tbody>
                  {run.saga.steps.map((step) => (
                    <tr key={step.id} data-tone={step.status === 'failed' ? 'fail' : undefined}>
                      <td className="mono">{step.name}</td>
                      <td className="num">
                        <Chip
                          tone={
                            step.status === 'ok'
                              ? 'pass'
                              : step.status === 'failed' || step.status === 'compensation_failed'
                                ? 'fail'
                                : 'warn'
                          }
                        >
                          {step.status.replace('_', ' ')}
                        </Chip>
                      </td>
                      <td className="num muted">{step.latencyMs}ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          ) : null}
        </div>

        <div>
          {!run ? (
            <Section title="Record" note="awaiting run">
              <p className="lede">
                Run a conversation to produce a call detail record, a bilingual transcript
                with line-level provenance, and an illustrative trace evidence index.
                The backend and caller are scripted fixtures; no live customer data is used.
              </p>
            </Section>
          ) : (
            <>
              <Section
                title="Outcome"
                note={
                  <span>
                    <Chip
                      tone={
                        run.outcome === 'resolved'
                          ? 'pass'
                          : run.outcome === 'recovered'
                            ? 'warn'
                            : 'fail'
                      }
                    >
                      {run.outcome}
                    </Chip>
                  </span>
                }
              >
                <p className="lede" style={{ color: 'var(--ink)' }}>
                  {run.headline}
                </p>
                <StatRow>
                  <Stat
                    value={`${(run.metrics.totalMs / 1000).toFixed(2)}s`}
                    label="simulated turn"
                    tone={run.metrics.remainingMs > 0 ? 'pass' : 'fail'}
                  />
                  <Stat value={run.metrics.calls} label="enterprise calls" />
                  <Stat
                    value={run.metrics.retries}
                    label="retries"
                    tone={run.metrics.retries > 0 ? 'warn' : undefined}
                  />
                  <Stat
                    value={run.metrics.breakerTrips}
                    label="breaker trips"
                    tone={run.metrics.breakerTrips > 0 ? 'fail' : undefined}
                  />
                  <Stat
                    value={run.metrics.writesAccepted}
                    label="business writes accepted"
                    tone={run.metrics.writesAccepted > 1 ? 'fail' : 'pass'}
                  />
                  <Stat
                    value={`${run.metrics.remainingMs}ms`}
                    label="budget left"
                    tone={run.metrics.remainingMs > 0 ? 'pass' : 'fail'}
                  />
                </StatRow>
              </Section>

              <Section title="Transcript" note="agent lines carry their provenance">
                <div className="btn-row" style={{ marginBottom: 12 }}>
                  {(['it-IT', 'en-GB'] as Lang[]).map((l) => (
                    <button
                      key={l}
                      type="button"
                      className={`btn ${lang === l ? '' : 'btn--ghost'}`}
                      onClick={() => setLang(l)}
                    >
                      {l}
                    </button>
                  ))}
                  <span className="mono muted" style={{ fontSize: 11 }}>
                    transcript locale · same run, same trace — only the wording changes
                  </span>
                </div>
                <div className="turns">
                  {run.transcript.map((line, i) => (
                    <div
                      key={`${i}-${line.role}`}
                      className="turn"
                      data-role={line.role}
                      data-recovered={line.recovered ? 'true' : undefined}
                      data-pending={i >= revealed && running ? 'true' : undefined}
                    >
                      <span className="turn__who">
                        {line.role === 'caller' ? 'Caller' : 'Agent'}
                      </span>
                      <div>
                        <p className="turn__text">{line.text[lang]}</p>
                        {line.note ? <p className="turn__note">{line.note}</p> : null}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>

              <Section title="Trace" note="every event the evidence pack indexes">
                <div className="log">
                  {run.trace.slice(0, Math.max(revealed * 2, 6)).map((e, i) => (
                    <div className="log__row" key={i} data-status={e.status}>
                      <span className="log__t">{(e.at / 1000).toFixed(2)}s</span>
                      <span className="log__k">{e.kind}</span>
                      <span className="log__m">
                        {e.label}
                        {e.detail ? ` — ${e.detail}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
