import { useMemo } from 'react';
import { buildEvidencePack, packToJson } from '../core/evidence/pack';
import type { DeploymentRun } from '../demo/deployment';
import { Chip, Section, Stat, StatRow } from '../ui/bits';

export function Evidence({ run }: { run: DeploymentRun | null }) {
  const pack = useMemo(() => {
    if (!run) return null;
    return buildEvidencePack({
      conversationId: 'conv-2026-09-24-001',
      generatedFor: 'simulated policy fixture IT-2026-004571',
      trace: run.trace,
    });
  }, [run]);

  const download = () => {
    if (!pack) return;
    const blob = new Blob([packToJson(pack)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `evidence-${pack.conversationId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="panel">
      <p className="lede">
        This prototype builds an evidence index from the same trace as the simulated
        conversation. An evidence link means a technical event was recorded; it is not a
        legal finding or compliance certification. The fixture cannot prove provider
        residency, production identity assurance, consent validity, or a real human handoff.
        <strong> Missing signals stay visible as gaps.</strong>
      </p>

      {!pack ? (
        <Section title="Pack" note="awaiting a conversation">
          <p className="lede">Run a conversation from the deployment panel first.</p>
        </Section>
      ) : (
        <>
          <StatRow>
            <Stat
              value={`${pack.coverage.evidencePresent}/${pack.coverage.total}`}
              label="with linked evidence"
              tone={pack.coverage.evidencePresent === pack.coverage.total ? 'pass' : 'warn'}
            />
            <Stat value={pack.records.length} label="evidence records" />
            <Stat
              value={pack.obligations.filter((o) => o.status === 'gap').length}
              label="gaps"
              tone={
                pack.obligations.filter((o) => o.status === 'gap').length > 0
                  ? 'fail'
                  : 'pass'
              }
            />
            <Stat value={pack.records.filter((r) => r.kind === 'tool_ledger').length} label="tool calls logged" />
          </StatRow>

          <div className="btn-row" style={{ margin: '18px 0 26px' }}>
            <button type="button" className="btn" onClick={download}>
              Download pack (JSON)
            </button>
            <span className="mono muted">
              schema agent-architect-fieldkit/evidence-pack/v2
            </span>
          </div>

          <Section title="Obligation evidence" note="a trace link is not a compliance conclusion">
            <table className="table">
              <thead>
                <tr>
                  <th>Obligation</th>
                  <th>Framework</th>
                  <th>What has to be demonstrable</th>
                  <th className="num">Status</th>
                </tr>
              </thead>
              <tbody>
                {pack.obligations.map((o) => (
                    <tr key={o.id} data-tone={o.status === 'evidence_present' ? undefined : 'fail'}>
                    <td>
                      <span className="mono" style={{ fontSize: 11 }}>
                        {o.id}
                      </span>
                      <div style={{ fontSize: 13 }}>{o.title}</div>
                      <div className="mono muted" style={{ fontSize: 10 }}>
                        {o.reference} · evidence {o.evidenceIds.join(', ') || '—'}
                      </div>
                    </td>
                    <td>
                      <Chip
                        tone={
                          o.framework === 'EU_AI_ACT'
                            ? 'warn'
                            : o.framework === 'INTERNAL'
                              ? 'fail'
                              : undefined
                        }
                      >
                        {o.framework.replace(/_/g, ' ')}
                      </Chip>
                    </td>
                    <td className="muted" style={{ fontSize: 12.5 }}>
                      {o.requirement}
                      {o.gapReason ? (
                        <div className="tone-fail" style={{ marginTop: 5, fontSize: 12 }}>
                          {o.gapReason}
                        </div>
                      ) : null}
                    </td>
                    <td className="num">
                      <Chip tone={o.status === 'evidence_present' ? 'pass' : 'fail'}>
                        {o.status === 'evidence_present' ? 'evidence' : 'gap'}
                      </Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title="Records" note="verbatim, in order">
            <div className="log" style={{ maxHeight: 460 }}>
              {pack.records.map((r) => (
                <div className="log__row" key={r.id} data-status="ok">
                  <span className="log__t">{r.id}</span>
                  <span className="log__k">{r.kind}</span>
                  <span className="log__m">
                    {r.summary}
                    {r.satisfies.length ? (
                      <span className="muted"> → {r.satisfies.join(', ')}</span>
                    ) : (
                      <span className="tone-fail"> → no obligation discharged</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </Section>
        </>
      )}
    </div>
  );
}
