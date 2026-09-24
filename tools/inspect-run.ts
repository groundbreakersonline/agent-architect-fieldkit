import { runRegressionSuite, failingScenarios } from '../src/core/regression/runner';
import { metricsTable } from '../src/core/regression/gate';
import { SCENARIOS } from '../src/core/regression/scenarios';

const run = runRegressionSuite({ samples: 5 });

console.log('baseline ', run.baseline.version, JSON.stringify(run.baseline.metrics, null, 1));
console.log('candidate', run.candidate.version, JSON.stringify(run.candidate.metrics, null, 1));
console.log('significance', run.verdict.significance);
console.log('wouldHaveShippedOnAverages', run.verdict.wouldHaveShippedOnAverages);
console.log('decision', run.verdict.decision);
console.log('findings:');
for (const f of run.verdict.findings) console.log(' ', f.severity, '|', f.title, '|', f.evidence ?? '');
console.log('\nmetrics table:');
for (const r of metricsTable(run.baseline.metrics, run.candidate.metrics)) {
  console.log(' ', r.metric.padEnd(24), r.baseline.padStart(10), '->', r.candidate.padStart(10), r.delta.padStart(8), r.direction);
}
console.log('\nper-scenario (regressed first):');
const regressed = new Set(failingScenarios(run).map((c) => c.scenario.id));
for (const c of run.comparisons) {
  const mark = regressed.has(c.scenario.id) ? 'REGRESSED' : c.fixed ? 'fixed    ' : '         ';
  console.log(
    ' ',
    c.scenario.id,
    c.scenario.critical ? 'CRIT' : '    ',
    mark,
    (c.baselinePassRate * 100).toFixed(0).padStart(4) + '% ->',
    (c.candidatePassRate * 100).toFixed(0).padStart(4) + '%',
    c.scenario.title,
  );
  if (regressed.has(c.scenario.id)) {
    for (const f of c.failures) console.log('        -', f);
  }
}
console.log('\ntotal scenarios', SCENARIOS.length, 'critical', SCENARIOS.filter((s) => s.critical).length);
