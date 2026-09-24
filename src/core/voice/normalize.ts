/**
 * The verbalisation rule set.
 *
 * Each rule is a named, reviewable decision about how a construct is spoken. Rules
 * carry their provenance, because in a regulated deployment "why does the agent say
 * it that way" needs an answer that survives an audit: a brand standard, an
 * accessibility requirement, a legal obligation, or a recovery from an ASR error we
 * actually observed.
 */
import {
  dateToWords,
  digitsToWords,
  euroToWords,
  groupDigits,
  intToWords,
  letterName,
  percentToWords,
  spellChars,
  spellIdentifier,
  timeToWords,
  type Lang,
} from './numbers';

export type RuleSource = 'brand' | 'accessibility' | 'legal' | 'asr_recovery';
export type Emphasis = 'identifier' | 'money' | 'date' | 'plain';

export interface RuleHit {
  ruleId: string;
  matched: string;
  spoken: string;
  source: RuleSource;
  emphasis: Emphasis;
  note: string;
}

export interface Rule {
  id: string;
  description: string;
  source: RuleSource;
  emphasis: Emphasis;
  note: string;
  pattern: RegExp;
  render: (match: string, groups: string[], lang: Lang) => string;
}

/**
 * Abbreviations, bilingual in both directions.
 *
 * The bug this fixes: the table was split per output locale, so "Sig." appearing in
 * Italian input read aloud in English fell through untouched and the English voice
 * was handed an Italian abbreviation to mangle. In a bilingual deployment the input
 * language and the output language are independent - a document is Italian, the
 * caller may be served in either - so every entry carries both expansions.
 */
const ABBREVIATIONS: Record<string, { it: string; en: string }> = {
  'sig.': { it: 'Signor', en: 'Mr' },
  'sig.ra': { it: 'Signora', en: 'Mrs' },
  'sig.na': { it: 'Signorina', en: 'Miss' },
  'dott.': { it: 'Dottore', en: 'Dr' },
  'dott.ssa': { it: 'Dottoressa', en: 'Dr' },
  'avv.': { it: 'Avvocato', en: 'lawyer' },
  'ing.': { it: 'Ingegnere', en: 'engineer' },
  'art.': { it: 'Articolo', en: 'Article' },
  'n.': { it: 'numero', en: 'number' },
  'tel.': { it: 'telefono', en: 'telephone' },
  'ecc.': { it: 'eccetera', en: 'etcetera' },
  'p.iva': { it: 'partita IVA', en: 'VAT number' },
  'c.f.': { it: 'codice fiscale', en: 'tax code' },
  'gg.': { it: 'giorni', en: 'days' },
  'c.a.': { it: 'cortese attenzione', en: 'for the attention of' },
  'mr.': { it: 'Signor', en: 'Mister' },
  'mrs.': { it: 'Signora', en: 'Missus' },
  'dr.': { it: 'Dottore', en: 'Doctor' },
  'st.': { it: 'via', en: 'Street' },
  'ave.': { it: 'viale', en: 'Avenue' },
  'approx.': { it: 'circa', en: 'approximately' },
  'dept.': { it: 'reparto', en: 'department' },
  'ref.': { it: 'riferimento', en: 'reference' },
};

export const RULES: Rule[] = [
  {
    id: 'iban_it',
    description: 'Italian IBAN read in groups of four',
    source: 'legal',
    emphasis: 'identifier',
    note: 'IBANs are read back by callers to validate payment details. Groups of four with a pause match how people write them down.',
    pattern: /\bIT\d{2}[A-Z]\d{10}[0-9A-Z]{12}\b/g,
    render: (match, _groups, lang) =>
      groupDigits(match, 4)
        .map((g) => spellChars(g, lang))
        .join(', '),
  },
  {
    id: 'tax_code_it',
    description: 'Italian fiscal code spelled out',
    source: 'legal',
    emphasis: 'identifier',
    note: 'Six letters, two digits, a letter, two digits, a letter, three digits, a letter. Spelling it as one token is an identification failure.',
    pattern: /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/g,
    render: (match, _groups, lang) => spellIdentifier(match, lang),
  },
  {
    id: 'case_reference',
    description: 'Service case and claim references',
    source: 'brand',
    emphasis: 'identifier',
    note: 'The reference is the only thing the caller has to write down. Slow it down and pause between groups. Declared before the generic policy pattern, which would otherwise claim it and attribute the wrong provenance.',
    pattern: /\b(CS|SIN|RMB)-(\d{4,8})(?:-(\d{4,6}))?\b/g,
    render: (_match, groups, lang) =>
      [
        spellIdentifier(groups[0] ?? '', lang),
        digitsToWords(groups[1] ?? '', lang, 3),
        groups[2] ? digitsToWords(groups[2], lang, 3) : '',
      ]
        .filter(Boolean)
        .join(', '),
  },
  {
    id: 'policy_number',
    description: 'Policy and contract numbers',
    source: 'brand',
    emphasis: 'identifier',
    note: 'Pattern is country-prefix + year + serial. Reading the serial in groups of three halves the read-back error rate we see in testing.',
    pattern: /\b([A-Z]{2,3})-(\d{4})-(\d{4,7})\b/g,
    render: (_match, groups, lang) =>
      [spellIdentifier(groups[0] ?? '', lang), intToWords(Number(groups[1]), lang), digitsToWords(groups[2] ?? '', lang, 3)]
        .filter(Boolean)
        .join(', '),
  },
  {
    id: 'amount_eur_prefix',
    description: 'Currency amounts written with a leading symbol',
    source: 'brand',
    emphasis: 'money',
    note: 'Italian format uses dot for thousands and comma for decimals. Parsing it as an English number turns 1.234,56 into one point two three four five six.',
    pattern: /(?:€\s?|\bEUR\s?)(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?/g,
    render: (_match, groups, lang) => {
      const whole = Number((groups[0] ?? '0').replace(/\./g, ''));
      const cents = groups[1] ? Number(groups[1].padEnd(2, '0')) : 0;
      return euroToWords(whole + cents / 100, lang);
    },
  },
  {
    id: 'amount_eur_suffix',
    description: 'Currency amounts written with a trailing symbol or word',
    source: 'brand',
    emphasis: 'money',
    note: 'Same value, different notation. Both notations occur in the same sentence in real policy documents.',
    pattern: /(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?\s?(?:€|euro\b|EUR\b)/g,
    render: (_match, groups, lang) => {
      const whole = Number((groups[0] ?? '0').replace(/\./g, ''));
      const cents = groups[1] ? Number(groups[1].padEnd(2, '0')) : 0;
      return euroToWords(whole + cents / 100, lang);
    },
  },
  {
    id: 'phone_it',
    description: 'Italian telephone numbers',
    source: 'accessibility',
    emphasis: 'identifier',
    note: 'Never read a phone number as a cardinal. Group it the way the prefix is dialled.',
    pattern: /(?:\+39|0039)[\s.]?\d(?:[\s.]?\d){5,12}/g,
    render: (match, _groups, lang) => {
      const digits = match.replace(/\D+/g, '');
      const prefix = digits.startsWith('0039') ? digits.slice(0, 4) : digits.slice(0, 2);
      const rest = digits.slice(prefix.length);
      return [digitsToWords(prefix, lang, 2), digitsToWords(rest, lang, 3)].join(', ');
    },
  },
  {
    id: 'date_slash',
    description: 'Dates in dd/mm/yyyy',
    source: 'brand',
    emphasis: 'date',
    note: 'Italian civil date order. Swapping day and month is the single most common localisation defect in this vertical.',
    pattern: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g,
    render: (_match, groups, lang) =>
      dateToWords(Number(groups[2]), Number(groups[1]), Number(groups[0]), lang),
  },
  {
    id: 'date_iso',
    description: 'Dates in ISO yyyy-mm-dd',
    source: 'brand',
    emphasis: 'date',
    note: 'APIs return ISO. Callers do not speak ISO.',
    pattern: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    render: (_match, groups, lang) =>
      dateToWords(Number(groups[0]), Number(groups[1]), Number(groups[2]), lang),
  },
  {
    id: 'time_of_day',
    description: 'Clock times',
    source: 'brand',
    emphasis: 'date',
    note: '24-hour clock is the Italian default, so no AM/PM ambiguity is introduced.',
    pattern: /\b(\d{1,2}):(\d{2})\b/g,
    render: (_match, groups, lang) => timeToWords(Number(groups[0]), Number(groups[1]), lang),
  },
  {
    id: 'percentage',
    description: 'Percentages',
    source: 'brand',
    emphasis: 'plain',
    note: 'The percent sign is silent in every TTS engine we tested.',
    pattern: /\b(\d{1,3}(?:,\d+)?)\s?%/g,
    render: (_match, groups, lang) =>
      percentToWords(Number((groups[0] ?? '0').replace(',', '.')), lang),
  },
  {
    id: 'abbreviation',
    description: 'Titles and legal abbreviations',
    source: 'brand',
    emphasis: 'plain',
    note: 'Expanding these is a brand decision, not an engine setting, so it lives in the rule set where a linguist can review it.',
    pattern: /\b(?:sig\.ra|sig\.na|dott\.ssa|sig\.|dott\.|avv\.|ing\.|art\.|tel\.|ecc\.|p\.iva|c\.f\.|c\.a\.|gg\.|mr\.|mrs\.|dr\.|st\.|ave\.|approx\.|dept\.|ref\.)/gi,
    render: (match, _groups, lang) => {
      const entry = ABBREVIATIONS[match.toLowerCase()];
      if (!entry) return match;
      return lang === 'it-IT' ? entry.it : entry.en;
    },
  },
  {
    id: 'numeric_range',
    description: 'Ranges such as 3-5 giorni',
    source: 'brand',
    emphasis: 'plain',
    note: 'A hyphen read aloud as "minus" reverses the meaning of a service window.',
    pattern: /\b(\d{1,4})\s?[-–]\s?(\d{1,4})\b/g,
    render: (_match, groups, lang) =>
      lang === 'it-IT'
        ? `da ${intToWords(Number(groups[0]), lang)} a ${intToWords(Number(groups[1]), lang)}`
        : `${intToWords(Number(groups[0]), lang)} to ${intToWords(Number(groups[1]), lang)}`,
  },
  {
    id: 'thousands_separated',
    description: 'Thousands-separated integers',
    source: 'brand',
    emphasis: 'plain',
    note: 'Handled before the plain integer rule so 45.000 is forty-five thousand and not forty-five point zero.',
    pattern: /\b\d{1,3}(?:\.\d{3})+\b/g,
    render: (match, _groups, lang) => intToWords(Number(match.replace(/\./g, '')), lang),
  },
  {
    id: 'plain_integer',
    description: 'Remaining integers',
    source: 'brand',
    emphasis: 'plain',
    note: 'Catch-all. Runs last so every more specific construct has already been claimed.',
    pattern: /\b\d+\b/g,
    render: (match, _groups, lang) => intToWords(Number(match), lang),
  },
];

export interface NormalizeResult {
  raw: string;
  spoken: string;
  ssml: string;
  hits: RuleHit[];
}

const PUA_START = 0xe000;

/**
 * Placeholders use Private Use Area characters, not digits.
 *
 * The obvious implementation - a numeric marker like \u0000 12 \u0000 - is silently
 * destroyed by the plain-integer rule, which sees the digits inside the marker as a
 * number to verbalise. Using non-word code points makes every placeholder immune to
 * every rule, including rules added later.
 */
function marker(index: number): string {
  return `\uE000${String.fromCharCode(PUA_START + 1 + index)}\uE001`;
}

const PLACEHOLDER = /\uE000([\s\S])\uE001/g;

function placeholderIndex(char: string): number {
  return char.charCodeAt(0) - PUA_START - 1;
}

function ssmlFor(hit: RuleHit): string {
  const parts = hit.spoken.split(/,\s*/).filter(Boolean);
  const body = parts.join('<break time="200ms"/>');
  switch (hit.emphasis) {
    case 'identifier':
      return `<prosody rate="94%">${body}</prosody>`;
    case 'money':
      return `<prosody rate="97%">${body}</prosody>`;
    case 'date':
      return `<prosody rate="97%">${body}</prosody>`;
    default:
      return body;
  }
}

/**
 * Applies every rule once, in order, replacing each match with a placeholder so a
 * later rule can never re-process an earlier rule's output. Without this, the
 * "euro" produced by the money rule gets re-read as a plain word by nothing, and the
 * digits produced by the date rule get read as a cardinal by the integer rule.
 */
export function normalize(raw: string, lang: Lang): NormalizeResult {
  const hits: RuleHit[] = [];
  let text = raw;

  for (const rule of RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    text = text.replace(re, (...args: unknown[]) => {
      const match = String(args[0]);
      const groups = args.slice(1, -2).map((g) => (g === undefined ? '' : String(g)));
      const spoken = rule.render(match, groups, lang);
      hits.push({
        ruleId: rule.id,
        matched: match,
        spoken,
        source: rule.source,
        emphasis: rule.emphasis,
        note: rule.note,
      });
      return marker(hits.length - 1);
    });
  }

  const spoken = text.replace(PLACEHOLDER, (_m, char: string) => hits[placeholderIndex(char)]?.spoken ?? '');
  const ssml = `<speak version="1.1" xml:lang="${lang}">${text.replace(
    PLACEHOLDER,
    (_m, char: string) => ssmlFor(hits[placeholderIndex(char)]!),
  )}</speak>`;

  return { raw, spoken, ssml, hits };
}

/** Convenience for a single identifier, used by the read-back checks. */
export function readBack(value: string, lang: Lang): string {
  return spellIdentifier(value, lang);
}

export function letterSpelling(value: string, lang: Lang): string {
  return value
    .split('')
    .map((c) => letterName(c, lang))
    .join(' ');
}
