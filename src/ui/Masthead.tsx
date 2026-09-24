import { Led } from './bits';

export function Masthead({ runCount, verdict }: { runCount: number; verdict: string }) {
  return (
    <header className="masthead">
      <div className="masthead__id">
        <span className="masthead__eyebrow">Field kit / reference implementation</span>
        <h1 className="masthead__title">
          Agent Architect <em>Field Kit</em>
        </h1>
      </div>
      <div className="masthead__meta">
        <div>
          <span>Revision</span>
          0.1.0
        </div>
        <div>
          <span>Deployment</span>
          IT-MIL / motor
        </div>
        <div>
          <span>Runs</span>
          {String(runCount).padStart(2, '0')}
        </div>
        <div>
          <span>Gate</span>
          {verdict}
        </div>
        <div style={{ justifyContent: 'flex-end' }}>
          <span>Status</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Led on={runCount > 0} tone={runCount > 0 ? 'pass' : undefined} />
            {runCount > 0 ? 'armed' : 'idle'}
          </span>
        </div>
      </div>
    </header>
  );
}
