/**
 * Voice output conformance suite.
 *
 * These are regression tests for speech. They exist because "the agent said it
 * correctly when I tried it" is not a control: a rule change three months from now
 * must not be able to silently turn a policy number back into an English word.
 */
import { normalize } from './normalize';
import type { Lang } from './numbers';

export interface ConformanceCase {
  id: string;
  lang: Lang;
  category: 'identifier' | 'money' | 'date' | 'prose' | 'legal';
  input: string;
  expect: string;
  because: string;
}

export const CONFORMANCE_CASES: ConformanceCase[] = [
  {
    id: 'policy-readback-it',
    lang: 'it-IT',
    category: 'identifier',
    input: 'Il suo codice pratica è IT-2026-004571.',
    expect:
      'Il suo codice pratica è i ti, duemilaventisei, zero zero quattro, cinque sette uno.',
    because:
      'The country prefix must be spelled in Italian, the year read as a cardinal, and the serial grouped.',
  },
  {
    id: 'policy-readback-en',
    lang: 'en-GB',
    category: 'identifier',
    input: 'Your policy IT-2026-004571 renews on 30/11/2026.',
    expect:
      'Your policy I, T, two thousand twenty-six, zero zero four, five seven one renews on thirtieth of November two thousand twenty-six.',
    because:
      'Adjacent letters must be separated, or the engine says the word "it". Day and month must not be swapped, and 30 must not become "thirtyth".',
  },
  {
    id: 'time-en',
    lang: 'en-GB',
    category: 'date',
    input: 'Your callback is at 14:30.',
    expect: 'Your callback is at half past two in the afternoon.',
    because:
      'English does not use the 24-hour clock in conversation. "Fourteen thirty" is transport-announcement English.',
  },
  {
    id: 'abbreviation-en',
    lang: 'en-GB',
    category: 'prose',
    input: 'The case is handled by Sig. Rossi and reviewed by Dott.ssa Bianchi.',
    expect: 'The case is handled by Mr Rossi and reviewed by Dr Bianchi.',
    because:
      'Input language and output language are independent. An Italian document read to an English-speaking caller must not hand an Italian abbreviation to the voice.',
  },
  {
    id: 'no-italian-leakage-en',
    lang: 'en-GB',
    category: 'prose',
    input:
      'Your policy IT-2026-004571 has been open since 14/08/2026. The amount is €1.234,56. Call +39 02 5550 1188. The rate is 12%. It takes 3-5 days.',
    expect:
      'Your policy I, T, two thousand twenty-six, zero zero four, five seven one has been open since fourteenth of August two thousand twenty-six. The amount is one thousand two hundred and thirty-four euro and fifty-six cents. Call three nine, zero two five, five five zero, one one, eight eight. The rate is twelve per cent. It takes three to five days.',
    because:
      'The guard that would have caught the regression this case was written for: a fully English conversation must produce a fully English spoken form.',
  },
  {
    id: 'amount-prefix-it',
    lang: 'it-IT',
    category: 'money',
    input: "L'importo è €1.234,56.",
    expect: "L'importo è milleduecentotrentaquattro euro e cinquantasei centesimi.",
    because:
      'Italian uses dot as the thousands separator. Parsing it as a decimal yields one point two three four five six.',
  },
  {
    id: 'amount-suffix-it',
    lang: 'it-IT',
    category: 'money',
    input: 'Il massimale è 45.000 euro.',
    expect: 'Il massimale è quarantacinquemila euro.',
    because: 'Trailing notation must produce the same value as leading notation.',
  },
  {
    id: 'date-it',
    lang: 'it-IT',
    category: 'date',
    input: 'La polizza scade il 30/11/2026.',
    expect: 'La polizza scade il trenta novembre duemilaventisei.',
    because: 'Civil date order, month spoken as a name.',
  },
  {
    id: 'date-first-of-month-it',
    lang: 'it-IT',
    category: 'date',
    input: 'Decorrenza dal 01/03/2026.',
    expect: 'Decorrenza dal primo marzo duemilaventisei.',
    because: 'The first of the month takes the ordinal in Italian, not "uno".',
  },
  {
    id: 'phone-it',
    lang: 'it-IT',
    category: 'identifier',
    input: 'Può chiamare il +39 02 5550 1188.',
    expect:
      'Può chiamare il tre nove, zero due cinque, cinque cinque zero, uno uno, otto otto.',
    because:
      'Never read a phone number as a cardinal, and never leave a trailing group of one digit.',
  },
  {
    id: 'case-ref-it',
    lang: 'it-IT',
    category: 'identifier',
    input: 'Ho aperto la pratica CS-482913.',
    expect: 'Ho aperto la pratica ci esse, quattro otto due, nove uno tre.',
    because: 'The reference is the only thing the caller writes down.',
  },
  {
    id: 'tax-code-it',
    lang: 'it-IT',
    category: 'legal',
    input: 'Il codice fiscale è RSSGLI85M41F205X.',
    expect:
      'Il codice fiscale è erre esse esse gi elle i, otto cinque, emme, quattro uno, effe, due zero cinque, ics.',
    because:
      'A fiscal code read as a word is an identification failure and a data-protection exposure.',
  },
  {
    id: 'iban-it',
    lang: 'it-IT',
    category: 'identifier',
    input: "L'IBAN è IT60X0542811101000000123456.",
    expect:
      "L'IBAN è i ti sei zero, ics zero cinque quattro, due otto uno uno, uno zero uno zero, zero zero zero zero, zero uno due tre, quattro cinque sei.",
    because:
      'Groups of four match how people transcribe an IBAN, and each group is read character by character as one unit.',
  },
  {
    id: 'percent-it',
    lang: 'it-IT',
    category: 'prose',
    input: 'Il tasso è sceso al 12%.',
    expect: 'Il tasso è sceso al dodici per cento.',
    because: 'The percent sign is silent in every engine tested.',
  },
  {
    id: 'abbreviation-it',
    lang: 'it-IT',
    category: 'prose',
    input: 'La pratica è seguita dal Sig. Rossi.',
    expect: 'La pratica è seguita dal Signor Rossi.',
    because: 'Expansion is a brand decision, so it lives in the reviewed rule set.',
  },
  {
    id: 'range-it',
    lang: 'it-IT',
    category: 'prose',
    input: 'La lavorazione richiede 3-5 giorni.',
    expect: 'La lavorazione richiede da tre a cinque giorni.',
    because: 'A hyphen read aloud as "minus" reverses the meaning of a service window.',
  },
  {
    id: 'time-it',
    lang: 'it-IT',
    category: 'date',
    input: 'Il richiamo è previsto alle 14:30.',
    expect: 'Il richiamo è previsto alle ore quattordici e trenta.',
    because: '24-hour clock, no AM/PM ambiguity introduced.',
  },
  {
    id: 'no-regression-plain-it',
    lang: 'it-IT',
    category: 'prose',
    input: 'Buongiorno, come posso aiutarla?',
    expect: 'Buongiorno, come posso aiutarla?',
    because: 'Ordinary prose must pass through untouched.',
  },
];

export interface ConformanceResult extends ConformanceCase {
  actual: string;
  pass: boolean;
}

export interface ConformanceReport {
  results: ConformanceResult[];
  passed: number;
  total: number;
  failed: string[];
}

/**
 * Italian tokens that must never survive into an English spoken form.
 *
 * Not a translation check - the input may legitimately be Italian. This is a
 * leakage check: whatever language the caller is being served in, the voice must
 * only ever be handed words that language's engine can pronounce.
 */
const ITALIAN_LEAKS = [
  'duemila',
  'mille',
  'cento',
  'venti',
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre',
  'euro e',
  'centesimi',
  'per cento',
  'ore ',
  'giorni',
  'Signor',
  'Dottore',
  'numero',
  'telefono',
];

export interface LeakFinding {
  caseId: string;
  token: string;
  where: string;
}

/** Scans every en-GB conformance case for Italian tokens in the spoken output. */
export function findItalianLeakage(
  cases: ConformanceCase[] = CONFORMANCE_CASES,
): LeakFinding[] {
  const findings: LeakFinding[] = [];
  for (const c of cases) {
    if (c.lang !== 'en-GB') continue;
    const spoken = normalize(c.input, c.lang).spoken;
    for (const token of ITALIAN_LEAKS) {
      if (spoken.toLowerCase().includes(token.toLowerCase())) {
        findings.push({ caseId: c.id, token, where: spoken });
      }
    }
  }
  return findings;
}

export function runConformance(cases: ConformanceCase[] = CONFORMANCE_CASES): ConformanceReport {
  const results = cases.map<ConformanceResult>((c) => {
    const actual = normalize(c.input, c.lang).spoken;
    return { ...c, actual, pass: actual === c.expect };
  });
  const failed = results.filter((r) => !r.pass).map((r) => r.id);
  return {
    results,
    passed: results.length - failed.length,
    total: results.length,
    failed,
  };
}
