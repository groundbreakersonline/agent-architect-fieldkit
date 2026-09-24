import { useCallback, useEffect, useRef, useState } from 'react';
import { runDeployment, type DeploymentRun } from './demo/deployment';
import type { ChaosFlag } from './core/sim/enterpriseApi';
import { runRegressionSuite, type RegressionRun } from './core/regression/runner';
import { SCENARIOS } from './core/regression/scenarios';
import { CONFORMANCE_CASES } from './core/voice/conformance';
import { OBLIGATIONS } from './core/evidence/pack';
import { CdrStrip } from './ui/CdrStrip';
import { Masthead } from './ui/Masthead';
import { Deployment } from './panels/Deployment';
import { ReleaseGate } from './panels/ReleaseGate';
import { VoiceOutput } from './panels/VoiceOutput';
import { Evidence } from './panels/Evidence';
import { Architecture } from './panels/Architecture';

type TabId = 'deployment' | 'gate' | 'voice' | 'evidence' | 'architecture';

const TABS: Array<{ id: TabId; n: string; label: string }> = [
  { id: 'deployment', n: '01', label: 'Deployment' },
  { id: 'gate', n: '02', label: 'Release gate' },
  { id: 'voice', n: '03', label: 'Voice output' },
  { id: 'evidence', n: '04', label: 'Evidence' },
  { id: 'architecture', n: '05', label: 'Architecture' },
];

const STEP_MS = 165;

export default function App() {
  const [tab, setTab] = useState<TabId>('deployment');
  const [chaos, setChaos] = useState<ChaosFlag[]>(['rateLimit']);
  const [run, setRun] = useState<DeploymentRun | null>(null);
  const [revealed, setRevealed] = useState(0);
  const [running, setRunning] = useState(false);
  const [runCount, setRunCount] = useState(0);
  const [gate, setGate] = useState<RegressionRun | null>(null);
  const timer = useRef<number | null>(null);
  const booted = useRef(false);

  const execute = useCallback(async (flags: ChaosFlag[]) => {
    if (timer.current !== null) window.clearInterval(timer.current);
    setRunning(true);
    const result = await runDeployment(flags);
    setRun(result);
    setRunCount((c) => c + 1);
    setRevealed(0);

    const total = Math.max(result.cdr.length, result.transcript.length, 1);
    let i = 0;
    timer.current = window.setInterval(() => {
      i += 1;
      setRevealed(i);
      if (i >= total) {
        if (timer.current !== null) window.clearInterval(timer.current);
        timer.current = null;
        setRunning(false);
      }
    }, STEP_MS);
  }, []);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void execute(['rateLimit']);
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
    };
  }, [execute]);

  const runGate = useCallback(() => {
    setGate(runRegressionSuite({ samples: 5 }));
  }, []);

  const toggleChaos = (flag: ChaosFlag) => {
    setChaos((prev) => (prev.includes(flag) ? prev.filter((f) => f !== flag) : [...prev, flag]));
  };

  const setPreset = (flags: ChaosFlag[]) => {
    setChaos(flags);
    void execute(flags);
  };

  const clockMs = run ? run.metrics.totalMs : 0;
  const verdict = gate
    ? gate.verdict.decision === 'block'
      ? 'BLOCKED'
      : gate.verdict.decision === 'ship'
        ? 'SHIP'
        : 'CONDITIONS'
    : '—';

  return (
    <div className="shell">
      <Masthead runCount={runCount} verdict={verdict} />

      <p className="thesis">
        Enterprise voice agents rarely fail because the model is weak. They fail at the
        seam: an integration that returns a 429 mid-sentence, a policy number the caller
        misread, a release that improves every number on the dashboard while quietly
        dropping the guarantees underneath it. This is a working reference kit for that
        seam — <strong>runnable, tested, and reproducible</strong>.
      </p>

      <CdrStrip entries={run?.cdr ?? []} revealed={revealed} running={running} clockMs={clockMs} />

      <nav className="tabs" role="tablist" aria-label="Panels">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            className="tab"
            onClick={() => setTab(t.id)}
          >
            <span className="tab__n">{t.n}</span>
            {t.label}
          </button>
        ))}
      </nav>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'deployment' ? (
          <Deployment
            chaos={chaos}
            onToggleChaos={toggleChaos}
            onPreset={setPreset}
            run={run}
            revealed={revealed}
            running={running}
            onRun={() => void execute(chaos)}
          />
        ) : null}
        {tab === 'gate' ? <ReleaseGate run={gate} onRun={runGate} /> : null}
        {tab === 'voice' ? <VoiceOutput /> : null}
        {tab === 'evidence' ? <Evidence run={run} /> : null}
        {tab === 'architecture' ? <Architecture /> : null}
      </div>

      <footer className="footer">
        <span>
          Agent Architect Field Kit · reference implementation · {SCENARIOS.length}{' '}
          regression scenarios · {CONFORMANCE_CASES.length} voice conformance cases ·{' '}
          {OBLIGATIONS.length} audited obligations · offline, no API keys
        </span>
        <span>npm test · npm run eval:live</span>
      </footer>
    </div>
  );
}
