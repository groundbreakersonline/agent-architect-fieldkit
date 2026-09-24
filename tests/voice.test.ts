import { describe, expect, it } from 'vitest';
import { findItalianLeakage, runConformance, type ConformanceCase } from '../src/core/voice/conformance';
import { normalize } from '../src/core/voice/normalize';
import {
  intToItalian,
  intToEnglish,
  euroToWords,
  enOrdinal,
  spellIdentifier,
  timeToWords,
} from '../src/core/voice/numbers';
import { lintAgentSpeech, toPls } from '../src/core/voice/lexicon';

describe('voice: conformance suite', () => {
  const report = runConformance();

  it('passes every conformance case', () => {
    const detail = report.results
      .filter((r) => !r.pass)
      .map((r) => `${r.id}\n  expected: ${r.expect}\n  actual:   ${r.actual}`)
      .join('\n\n');
    expect(report.failed, `\n${detail}`).toEqual([]);
  });

  it('covers both output locales', () => {
    const en = report.results.filter((r) => r.lang === 'en-GB');
    expect(en.length).toBeGreaterThanOrEqual(4);
    expect(report.total).toBeGreaterThanOrEqual(18);
  });
});

describe('voice: no Italian leakage into English output', () => {
  it('produces no Italian tokens across the en-GB cases', () => {
    const leaks = findItalianLeakage();
    expect(
      leaks.map((l) => `${l.caseId}: ${l.token}`),
      'Italian token found in an English spoken form',
    ).toEqual([]);
  });

  it('detects leakage when it is present, so the guard can actually fail', () => {
    // Italian prose served to an English engine. The detector reads the *actual*
    // spoken form, so the only way to exercise it is with an input that really does
    // leak - which is exactly the case a real deployment hits when a document is
    // Italian and the caller is not.
    const leaking: ConformanceCase[] = [
      {
        id: 'synthetic-leak',
        lang: 'en-GB',
        category: 'prose',
        input: 'La pratica richiede 3 giorni lavorativi e il premio è di 486 euro.',
        expect: '',
        because: 'Italian prose routed to an English voice.',
      },
    ];
    const leaks = findItalianLeakage(leaking);
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks.map((l) => l.token)).toContain('giorni');
  });
});

describe('voice: the two locales are independent', () => {
  it('separates adjacent letters so the engine cannot say the word "it"', () => {
    expect(spellIdentifier('IT', 'en-GB')).toBe('I, T');
    expect(spellIdentifier('RSSGLI', 'en-GB')).toBe('R, S, S, G, L, I');
    // Italian letter names are whole syllables and do not merge, so they stay joined.
    expect(spellIdentifier('IT', 'it-IT')).toBe('i ti');
    expect(spellIdentifier('RSSGLI', 'it-IT')).toBe('erre esse esse gi elle i');
  });

  it('reads English clock times the way English speakers say them', () => {
    expect(timeToWords(14, 30, 'en-GB')).toBe('half past two in the afternoon');
    expect(timeToWords(9, 15, 'en-GB')).toBe('quarter past nine in the morning');
    expect(timeToWords(20, 0, 'en-GB')).toBe("eight o'clock in the evening");
    expect(timeToWords(14, 30, 'it-IT')).toBe('ore quattordici e trenta');
  });

  it('expands an Italian abbreviation into the caller\'s language', () => {
    const en = normalize('Handled by Sig. Rossi.', 'en-GB').spoken;
    expect(en).toBe('Handled by Mr Rossi.');
    const it = normalize('Gestita dal Sig. Rossi.', 'it-IT').spoken;
    expect(it).toBe('Gestita dal Signor Rossi.');
  });

  it('expands an English abbreviation into Italian when the caller is Italian', () => {
    expect(normalize('Delivered to Mr. Rossi.', 'it-IT').spoken).toBe(
      'Delivered to Signor Rossi.',
    );
  });

  it('keeps a fully English conversation fully English', () => {
    const out = normalize(
      'Your policy IT-2026-004571 renews on 14/08/2026 for €1.234,56 at 14:30, a 12% increase.',
      'en-GB',
    ).spoken;
    for (const token of ['duemila', 'quattordici', 'agosto', 'mille', 'centesimi', 'per cento', 'ore ']) {
      expect(out).not.toContain(token);
    }
    expect(out).toContain('fourteenth of August');
    expect(out).toContain('half past two in the afternoon');
    expect(out).toContain('twelve per cent');
  });
});

describe('voice: cardinals', () => {
  it('handles the Italian elision rules', () => {
    expect(intToItalian(21)).toBe('ventuno');
    expect(intToItalian(28)).toBe('ventotto');
    expect(intToItalian(23)).toBe('ventitré');
    expect(intToItalian(108)).toBe('centotto');
    expect(intToItalian(180)).toBe('centottanta');
    expect(intToItalian(101)).toBe('centouno');
    expect(intToItalian(1000)).toBe('mille');
    expect(intToItalian(2026)).toBe('duemilaventisei');
    expect(intToItalian(21000)).toBe('ventunomila');
    expect(intToItalian(1234567)).toBe('un milione duecentotrentaquattromilacinquecentosessantasette');
  });

  it('handles English cardinals and ordinals', () => {
    expect(intToEnglish(2026)).toBe('two thousand twenty-six');
    expect(intToEnglish(125)).toBe('one hundred and twenty-five');
    expect(enOrdinal(30)).toBe('thirtieth');
    expect(enOrdinal(21)).toBe('twenty-first');
    expect(enOrdinal(1)).toBe('first');
  });

  it('verbalises euro amounts in both locales', () => {
    expect(euroToWords(1234.56, 'it-IT')).toBe(
      'milleduecentotrentaquattro euro e cinquantasei centesimi',
    );
    expect(euroToWords(45000, 'it-IT')).toBe('quarantacinquemila euro');
    expect(euroToWords(1.01, 'en-GB')).toBe('one euro and one cent');
  });
});

describe('voice: rules', () => {
  it('never re-processes its own output', () => {
    // The date rule emits digits-free text; the integer rule must not touch it,
    // and the placeholder must survive every subsequent rule.
    const r = normalize('Scade il 30/11/2026 e costa 45.000 euro.', 'it-IT');
    expect(r.spoken).toBe(
      'Scade il trenta novembre duemilaventisei e costa quarantacinquemila euro.',
    );
  });

  it('records provenance for every substitution', () => {
    const r = normalize('Pratica IT-2026-004571.', 'it-IT');
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.ruleId).toBe('policy_number');
    expect(r.hits[0]!.source).toBe('brand');
  });

  it('attributes a case reference to the case rule, not the generic policy rule', () => {
    const r = normalize('Ho aperto la pratica CS-482913 e il sinistro SIN-2026-88213.', 'it-IT');
    expect(r.hits.map((h) => h.ruleId)).toEqual(['case_reference', 'case_reference']);
  });

  it('emits SSML that slows down critical identifiers', () => {
    const r = normalize('Pratica IT-2026-004571.', 'it-IT');
    expect(r.ssml).toContain('<prosody rate="94%">');
    expect(r.ssml).toContain('<break time="200ms"/>');
    expect(r.ssml.startsWith('<speak')).toBe(true);
  });

  it('flags internal vocabulary before it reaches a customer', () => {
    const findings = lintAgentSpeech('I have raised a ticket and the SLA applies.');
    expect(findings.map((f) => f.term.toLowerCase()).sort()).toEqual(['sla', 'ticket']);
  });

  it('exports a valid PLS document', () => {
    const pls = toPls();
    expect(pls).toContain('pronunciation-lexicon');
    expect(pls).toContain('<grapheme>SAP</grapheme>');
    expect(pls).toContain('<alias>esse a pi</alias>');
  });
});
