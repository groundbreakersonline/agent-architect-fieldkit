import { useMemo, useState } from 'react';
import type { RegressionRun } from '../core/regression/runner';
import { metricsTable } from '../core/regression/gate';
import { Chip, Section, Stat, StatRow, pct } from '../ui/bits';

export function ReleaseGate({
  run,
  onRun,
}: {
  run: RegressionRun | null;
  onRun: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const execute = () => {
    setBusy(true);
    // Synchronous and instant: 200 simulated conversations, no network, no cost.
    window.setTimeout(() => {
      onRun();
      setBusy(false);
    }, 220);
  };

  const table = useMemo(
    () => (run ? metricsTable(run.baseline.metrics, run.candidate.metrics) : []),
    [run],
  );

  const regressed = useMemo(
    () => (run ? run.comparisons.filter((c) => c.regressed) : []),
    [run],
  );

  return (
    <div className="panel">
      <p className="lede">
        This is an <strong>illustrative offline fixture</strong>, not a measurement of a
        production model: baseline and candidate behaviours are encoded as test profiles.
        The candidate is configured to look faster and cheaper while dropping selected
        safeguards. The gate demonstrates the release policy: averages are reported, but
        a critical obligation is not averaged away.
      </p>

      <div className="btn-row" style={{ marginBottom: 22 }}>
        <button type="button" className="btn" onClick={execute} disabled={busy}>
          {busy ? 'Running 200 conversations…' : run ? 'Run again' : 'Run the release gate'}
        </button>
        {run ? (
            <span className="mono muted">
            {run.conversationsPerVersion} simulated conversations × 2 profiles · seed 20260924 ·
            deterministic
          </span>
        ) : null}
      </div>

      {!run ? (
        <Section title="Scorecard" note="awaiting run">
          <p className="lede">
            The suite is 20 scenarios, 10 of them critical, covering identity, entitlement,
            duplicate writes, dependency failure, accessibility, third-party disclosure and
            prompt injection. Five samples each.
          </p>
        </Section>
      ) : (
        <>
          <div className="verdict" data-decision={run.verdict.decision}>
            <span className="verdict__word">
              {run.verdict.decision === 'block'
                ? 'Blocked'
                : run.verdict.decision === 'ship'
                  ? 'Ship'
                  : 'Conditions'}
            </span>
            <p className="verdict__why" style={{ margin: 0 }}>
              {run.verdict.decision === 'block' ? (
                <>
                  <b>
                    {run.verdict.findings.filter((f) => f.severity === 'blocker').length}{' '}
                    blockers.
                  </b>{' '}
                  {run.verdict.wouldHaveShippedOnAverages
                    ? 'In this synthetic comparison, containment and cost improve while critical guarantees regress. An averages-only gate would have approved the fixture.'
                    : 'The candidate fixture regressed on obligations, not on preferences.'}
                </>
              ) : (
                <>
                  No blocking findings. Every critical guarantee held at{' '}
                  {pct(run.candidate.metrics.criticalPassRate)}.
                </>
              )}
            </p>
          </div>

          <StatRow>
            <Stat
              value={pct(run.candidate.metrics.criticalPassRate, 0)}
              label="critical guarantees"
              tone={run.candidate.metrics.criticalPassRate === 1 ? 'pass' : 'fail'}
            />
            <Stat
              value={pct(run.candidate.metrics.containmentRate, 0)}
              label="containment"
              tone="pass"
            />
            <Stat
              value={`${run.candidate.metrics.p95TurnLatencyMs}ms`}
              label="p95 turn"
              tone="pass"
            />
            <Stat
              value={run.candidate.metrics.costPerResolutionUsd === null
                ? 'Unpriced'
                : `$${run.candidate.metrics.costPerResolutionUsd.toFixed(4)}`}
              label="cost / resolution"
              tone={run.candidate.metrics.costPerResolutionUsd === null ? undefined : 'pass'}
            />
            <Stat
              value={run.candidate.metrics.guardrailBreaches}
              label="guardrail breaches"
              tone={run.candidate.metrics.guardrailBreaches > 0 ? 'fail' : 'pass'}
            />
            <Stat
              value={`p=${run.verdict.significance.pValue.toFixed(3)}`}
              label="illustrative z-test"
              tone={run.verdict.significance.significant ? 'warn' : undefined}
            />
          </StatRow>

          <div style={{ height: 26 }} />

          <Section title="Findings" note="blockers, warnings, and the wins worth keeping">
            {run.verdict.findings.map((f, i) => (
              <div className="finding" key={i} data-sev={f.severity}>
                <h3 className="finding__t">
                  {f.severity === 'blocker'
                    ? 'Blocker'
                    : f.severity === 'gain'
                      ? 'Gain'
                      : f.severity === 'warning'
                        ? 'Warning'
                        : 'Note'}{' '}
                  · {f.title}
                </h3>
                <p className="finding__d">{f.detail}</p>
                {f.evidence ? <p className="finding__e">{f.evidence}</p> : null}
              </div>
            ))}
          </Section>

          <Section title="Metric diff" note="candidate against the incumbent">
            <table className="table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th className="num">{run.baseline.label}</th>
                  <th className="num">{run.candidate.label}</th>
                  <th className="num">Delta</th>
                </tr>
              </thead>
              <tbody>
                {table.map((row) => (
                  <tr
                    key={row.metric}
                    data-tone={
                      row.direction === 'worse'
                        ? 'fail'
                        : row.direction === 'better'
                          ? 'gain'
                          : undefined
                    }
                  >
                    <td>{row.metric}</td>
                    <td className="num">{row.baseline}</td>
                    <td className="num">{row.candidate}</td>
                    <td
                      className={`num ${row.direction === 'worse' ? 'tone-fail' : row.direction === 'better' ? 'tone-pass' : 'muted'}`}
                    >
                      {row.delta}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section
            title="Regressed scenarios"
            note={`${regressed.length} of ${run.comparisons.length}`}
          >
            <table className="table">
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>Obligation</th>
                  <th className="num">{run.baseline.label}</th>
                  <th className="num">{run.candidate.label}</th>
                </tr>
              </thead>
              <tbody>
                {regressed.map((c) => (
                  <tr key={c.scenario.id} data-tone="fail">
                    <td>
                      <span className="mono">{c.scenario.id}</span> {c.scenario.title}
                      {c.scenario.critical ? (
                        <>
                          {' '}
                          <Chip tone="fail">critical</Chip>
                        </>
                      ) : null}
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {c.failures.map((f, i) => (
                        <div key={i}>{f}</div>
                      ))}
                    </td>
                    <td className="num">{pct(c.baselinePassRate, 0)}</td>
                    <td className="num tone-fail">{pct(c.candidatePassRate, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
          <Section
            title="Optional live probe"
            note="real model call · fixed caller · simulated enterprise backend"
          >
            <p className="lede">
              What you just ran is the <strong>offline</strong> suite: the agent under
              test is a behavioural fixture, so the gate runs in CI, free, deterministically,
              and returns the same answer every time. That is what makes it usable as a
              required check rather than a report somebody reads.
            </p>
            <p className="lede">
              What it cannot do is <em>discover</em> a regression. It asserts that the
              candidate stopped re-confirming identifiers; it does not observe a real
              model doing so. For that, the same suite has a <strong>live</strong> path
              where every caller turn comes from the authored scenario, the agent is a
              real model call, and its tool calls go through the same integration layer
              against a simulated enterprise backend.
            </p>
            <pre className="block">
              {`# the offline gate — CI, every commit
npm test

# the live suite — nightly, or before a model swap
npm run eval:live -- --all --model <model-id>

# any OpenAI-compatible endpoint, including a local one
npm run eval:live -- --scenario S03 --model llama3.1 \\
  --base-url http://localhost:11434/v1`}
            </pre>
            <p className="lede" style={{ marginBottom: 0 }}>
              Both paths evaluate with the <code>evaluateExpectations</code> function.
              A gate that means different things depending on how the conversation was
              produced is not a gate.
            </p>
          </Section>
        </>
      )}
    </div>
  );
}
