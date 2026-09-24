import { useMemo, useState } from 'react';
import { normalize } from '../core/voice/normalize';
import { findItalianLeakage, runConformance } from '../core/voice/conformance';
import { lintAgentSpeech, LEXICON, toDictionary, toPls } from '../core/voice/lexicon';
import type { Lang } from '../core/voice/numbers';
import { Chip, Section, Stat, StatRow } from '../ui/bits';

const SAMPLES: Record<Lang, string> = {
  'it-IT': `Buongiorno, la sua pratica è IT-2026-004571 e risulta in lavorazione dal 14/08/2026.
L'importo da rimborsare è €1.234,56 e il massimale è 45.000 euro.
Può chiamare il +39 02 5550 1188 oppure scrivere a g.rossi@example.it.
Il codice fiscale associato è RSSGLI85M41F205X e l'IBAN è IT60X0542811101000000123456.
Il sinistro SIN-2026-88213 è in istruttoria dal Sig. Marchetti. La pratica richiede 3-5 giorni lavorativi.
L'identificazione scade alle 14:30 e il tasso applicato è del 12%.`,
  'en-GB': `Good morning, your policy IT-2026-004571 has been open since 14/08/2026.
The amount to refund is €1.234,56 and the limit is 45.000 euro.
You can call +39 02 5550 1188 or write to g.rossi@example.it.
The tax code on file is RSSGLI85M41F205X and the IBAN is IT60X0542811101000000123456.
The claim SIN-2026-88213 is under review by Sig. Marchetti. It takes 3-5 working days.
Your identification expires at 14:30 and the rate applied is 12%.`,
};

export function VoiceOutput() {
  const [text, setText] = useState(SAMPLES['it-IT']);
  const [lang, setLang] = useState<Lang>('it-IT');

  const result = useMemo(() => normalize(text, lang), [text, lang]);
  const report = useMemo(() => runConformance(), []);
  const leaks = useMemo(() => findItalianLeakage(), []);
  const lint = useMemo(() => lintAgentSpeech(text), [text]);

  /**
   * Switching locale swaps the sample only if the field still holds a sample.
   * Anything the reviewer typed is left alone.
   */
  const switchLang = (next: Lang) => {
    setLang(next);
    setText((current) =>
      current === SAMPLES['it-IT'] || current === SAMPLES['en-GB'] ? SAMPLES[next] : current,
    );
  };

  return (
    <div className="panel">
      <p className="lede">
        Text-to-speech engines read <code>IT-2026-004571</code> as something between a
        word and a sneeze, and <code>€1.234,56</code> as a date. In a regulated contact
        centre a misread policy number is a failed identification, not a cosmetic
        defect. Every substitution below is a named, reviewable rule with a stated
        reason, and the suite asserts the output character for character.
      </p>

      <div className="grid">
        <div>
          <Section title="Raw agent output" note="what the model produced">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={12}
              spellCheck={false}
              style={{
                width: '100%',
                fontFamily: 'var(--mono)',
                fontSize: 12,
                lineHeight: 1.6,
                padding: '10px 12px',
                border: '1px solid var(--rule-strong)',
                background: 'var(--paper-2)',
                color: 'var(--ink)',
                resize: 'vertical',
              }}
            />
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button
                type="button"
                className={`btn ${lang === 'it-IT' ? '' : 'btn--ghost'}`}
                onClick={() => switchLang('it-IT')}
              >
                it-IT
              </button>
              <button
                type="button"
                className={`btn ${lang === 'en-GB' ? '' : 'btn--ghost'}`}
                onClick={() => switchLang('en-GB')}
              >
                en-GB
              </button>
              <span className="mono muted" style={{ fontSize: 11 }}>
                output locale · the input language is independent
              </span>
            </div>
          </Section>

          <Section
            title="Italian leakage"
            note="English output must be pronounceable by an English engine"
          >
            {leaks.length === 0 ? (
              <p className="lede" style={{ color: 'var(--pass)', marginBottom: 0 }}>
                Clean. Every en-GB conformance case produces a spoken form with no
                Italian tokens in it.
              </p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Case</th>
                    <th>Leaked token</th>
                  </tr>
                </thead>
                <tbody>
                  {leaks.map((l, i) => (
                    <tr key={i} data-tone="fail">
                      <td className="mono">{l.caseId}</td>
                      <td className="tone-fail">{l.token}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title="Conformance suite" note={`${report.passed}/${report.total} passing`}>
            <StatRow>
              <Stat
                value={report.passed}
                label="passing"
                tone={report.passed === report.total ? 'pass' : 'fail'}
              />
              <Stat value={report.total} label="cases" />
              <Stat
                value={report.failed.length}
                label="failing"
                tone={report.failed.length ? 'fail' : 'pass'}
              />
            </StatRow>
            <table className="table" style={{ marginTop: 12 }}>
              <tbody>
                {report.results.map((r) => (
                  <tr key={r.id} data-tone={r.pass ? undefined : 'fail'}>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {r.id}
                    </td>
                    <td>
                      <Chip tone={r.pass ? 'pass' : 'fail'}>{r.pass ? 'pass' : 'fail'}</Chip>
                    </td>
                    <td className="muted" style={{ fontSize: 11.5 }}>
                      {r.because}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </div>

        <div>
          <Section title="Spoken form" note={`${result.hits.length} substitutions`}>
            <pre className="block">{result.spoken}</pre>
            {lint.length ? (
              <p className="lede" style={{ color: 'var(--signal)', fontSize: 13 }}>
                Speech lint: {lint.map((l) => l.term).join(', ')} — internal vocabulary
                that should not reach a customer.
              </p>
            ) : null}
          </Section>

          <Section title="Substitutions" note="with provenance">
            <table className="table">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Matched</th>
                  <th>Spoken</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {result.hits.map((h, i) => (
                  <tr key={i}>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {h.ruleId}
                      <div className="muted" style={{ fontSize: 10 }}>
                        {h.note}
                      </div>
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {h.matched}
                    </td>
                    <td className="mono tone-pass" style={{ fontSize: 11 }}>
                      {h.spoken}
                    </td>
                    <td>
                      <Chip
                        tone={
                          h.source === 'legal'
                            ? 'fail'
                            : h.source === 'brand'
                              ? 'warn'
                              : undefined
                        }
                      >
                        {h.source}
                      </Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title="SSML" note="rate and break hints per construct">
            <pre className="block">{result.ssml}</pre>
          </Section>

          <Section title="Pronunciation lexicon" note="W3C PLS, ready for the vendor">
            <pre className="block" style={{ maxHeight: 260, overflowY: 'auto' }}>
              {toPls(LEXICON, lang)}
            </pre>
            <table className="table">
              <thead>
                <tr>
                  <th>Grapheme</th>
                  <th>Alias / phoneme</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {LEXICON.map((e) => (
                  <tr key={e.grapheme}>
                    <td className="mono">{e.grapheme}</td>
                    <td className="mono tone-pass">{e.alias ?? e.phoneme}</td>
                    <td className="muted" style={{ fontSize: 11.5 }}>
                      {e.note}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mono muted" style={{ fontSize: 11, marginTop: 10 }}>
              Flat dictionary for vendors that do not take PLS:{' '}
              {Object.keys(toDictionary()).length} entries.
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}
