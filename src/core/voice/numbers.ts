/**
 * Number and identifier verbalisation for Italian and English.
 *
 * Text-to-speech engines read "IT-2026-004571" as something between a word and a
 * sneeze, and "€1.234,56" as a date. In a regulated contact centre a misread policy
 * number is not a cosmetic defect, it is a failed identification and a potential
 * data-protection incident. This module is the deterministic layer that decides how
 * every construct is spoken, so it can be reviewed by a linguist and asserted in CI.
 */

export type Lang = 'it-IT' | 'en-GB';

// ---------------------------------------------------------------------------
// Italian cardinals
// ---------------------------------------------------------------------------

const IT_UNITS = [
  'zero',
  'uno',
  'due',
  'tre',
  'quattro',
  'cinque',
  'sei',
  'sette',
  'otto',
  'nove',
] as const;

const IT_TEENS = [
  'dieci',
  'undici',
  'dodici',
  'tredici',
  'quattordici',
  'quindici',
  'sedici',
  'diciassette',
  'diciotto',
  'diciannove',
] as const;

const IT_TENS = [
  '',
  '',
  'venti',
  'trenta',
  'quaranta',
  'cinquanta',
  'sessanta',
  'settanta',
  'ottanta',
  'novanta',
] as const;

function itUnder100(n: number): string {
  if (n < 10) return IT_UNITS[n]!;
  if (n < 20) return IT_TEENS[n - 10]!;
  const t = Math.floor(n / 10);
  const u = n % 10;
  if (u === 0) return IT_TENS[t]!;
  // venti/trenta lose their final vowel before uno and otto: ventuno, ventotto.
  if (u === 1 || u === 8) return `${IT_TENS[t]!.slice(0, -1)}${IT_UNITS[u]}`;
  // Tre takes an accent in compounds: ventitre -> ventitré.
  if (u === 3) return `${IT_TENS[t]}tré`;
  return `${IT_TENS[t]}${IT_UNITS[u]}`;
}

function itUnder1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h === 0) return itUnder100(r);

  const stem = h === 1 ? 'cento' : `${IT_UNITS[h]}cento`;
  if (r === 0) return stem;

  // cento elides before a vowel except before "uno": centotto, centottanta, but centouno.
  const tail = itUnder100(r);
  const elides = /^[aeiou]/.test(tail) && tail !== 'uno';
  return `${elides ? stem.slice(0, -1) : stem}${tail}`;
}

function itUnder1e6(n: number): string {
  if (n < 1000) return itUnder1000(n);
  const th = Math.floor(n / 1000);
  const rest = n % 1000;
  const stem = th === 1 ? 'mille' : `${itUnder1000(th)}mila`;
  return rest === 0 ? stem : `${stem}${itUnder1000(rest)}`;
}

export function intToItalian(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const value = Math.trunc(n);
  if (value === 0) return 'zero';
  if (value < 0) return `meno ${intToItalian(-value)}`;

  const parts: string[] = [];
  const miliardi = Math.floor(value / 1e9);
  const milioni = Math.floor((value % 1e9) / 1e6);
  const resto = value % 1e6;

  if (miliardi > 0) {
    parts.push(miliardi === 1 ? 'un miliardo' : `${itUnder1e6(miliardi)} miliardi`);
  }
  if (milioni > 0) {
    parts.push(milioni === 1 ? 'un milione' : `${itUnder1e6(milioni)} milioni`);
  }
  if (resto > 0) parts.push(itUnder1e6(resto));

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// English cardinals (en-GB)
// ---------------------------------------------------------------------------

const EN_SMALL = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
] as const;

const EN_TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
] as const;

function enUnder1000(n: number): string {
  if (n < 20) return EN_SMALL[n]!;
  if (n < 100) {
    const t = Math.floor(n / 10);
    const u = n % 10;
    return u === 0 ? EN_TENS[t]! : `${EN_TENS[t]}-${EN_SMALL[u]}`;
  }
  const h = Math.floor(n / 100);
  const r = n % 100;
  const head = `${EN_SMALL[h]} hundred`;
  return r === 0 ? head : `${head} and ${enUnder1000(r)}`;
}

export function intToEnglish(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const value = Math.trunc(n);
  if (value === 0) return 'zero';
  if (value < 0) return `minus ${intToEnglish(-value)}`;

  const scales: Array<[number, string]> = [
    [1e9, 'billion'],
    [1e6, 'million'],
    [1e3, 'thousand'],
    [1, ''],
  ];

  const parts: string[] = [];
  let rest = value;
  for (const [size, name] of scales) {
    const count = Math.floor(rest / size);
    if (count === 0) continue;
    rest %= size;
    if (size === 1) {
      parts.push(enUnder1000(count));
    } else {
      parts.push(`${enUnder1000(count)} ${name}`);
    }
  }
  return parts.join(' ');
}

export function intToWords(n: number, lang: Lang): string {
  return lang === 'it-IT' ? intToItalian(n) : intToEnglish(n);
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** Splits a digit string into spoken groups, e.g. 004571 -> ["004", "571"]. */
export function groupDigits(digits: string, size = 3): string[] {
  const groups: string[] = [];
  for (let i = 0; i < digits.length; i += size) {
    groups.push(digits.slice(i, i + size));
  }
  return groups;
}

/**
 * Groups from the left but never leaves a trailing group of a single digit.
 *
 * A lone trailing digit is the worst possible thing to read aloud: the listener
 * hears the cadence stop one beat early and writes the number down wrong. Moving one
 * digit down from the previous group costs nothing and fixes it.
 * 0255501188 -> [025][550][11][88], not [025][550][118][8].
 */
export function groupDigitsBalanced(digits: string, size = 3): string[] {
  if (digits.length <= size) return digits ? [digits] : [];
  const groups = groupDigits(digits, size);
  const last = groups[groups.length - 1]!;
  if (last.length === 1 && groups.length > 1) {
    const prev = groups[groups.length - 2]!;
    groups[groups.length - 2] = prev.slice(0, -1);
    groups[groups.length - 1] = prev.slice(-1) + last;
  }
  return groups.filter(Boolean);
}

/**
 * Reads a digit string digit-by-digit, in groups.
 *
 * Grouping is the whole point. "zero zero quattro cinque sette uno" is a wall of
 * noise; "zero zero quattro, cinque sette uno" is a number a human can write down
 * while listening. The comma becomes a 220ms break in the SSML layer.
 */
export function digitsToWords(digits: string, lang: Lang, groupSize = 3): string {
  const words = groupDigitsBalanced(digits.replace(/\D+/g, ''), groupSize).map((group) =>
    group
      .split('')
      .map((d) => (lang === 'it-IT' ? IT_UNITS[Number(d)]! : EN_SMALL[Number(d)]!))
      .join(' '),
  );
  return words.join(', ');
}

/**
 * Italian letter names.
 *
 * An Italian TTS engine handed the bare token "IT" will happily say the English
 * word "it". Spelling has to be explicit, and it has to use the Italian names,
 * because that is what the caller hears and repeats back to a human colleague.
 */
const IT_LETTERS: Record<string, string> = {
  A: 'a',
  B: 'bi',
  C: 'ci',
  D: 'di',
  E: 'e',
  F: 'effe',
  G: 'gi',
  H: 'acca',
  I: 'i',
  J: 'i lunga',
  K: 'cappa',
  L: 'elle',
  M: 'emme',
  N: 'enne',
  O: 'o',
  P: 'pi',
  Q: 'cu',
  R: 'erre',
  S: 'esse',
  T: 'ti',
  U: 'u',
  V: 'vu',
  W: 'doppia vu',
  X: 'ics',
  Y: 'ipsilon',
  Z: 'zeta',
};

export function letterName(char: string, lang: Lang): string {
  if (lang === 'it-IT') return IT_LETTERS[char.toUpperCase()] ?? char;
  return char.toUpperCase();
}

/**
 * Reads a token character by character: letters as letter names, digits as digits.
 *
 * This is the correct treatment for structured identifiers such as an IBAN, where
 * splitting on letter-runs and digit-runs (the natural implementation) produces
 * "i ti, sei zero" instead of the "i ti sei zero" a caller expects to hear as one
 * group.
 */
export function spellChars(value: string, lang: Lang): string {
  return joinSpokenTokens(
    value
      .split('')
      .map((c) => (/\d/.test(c) ? intToWords(Number(c), lang) : letterName(c, lang))),
  );
}

/**
 * Joins spoken tokens, inserting a comma between adjacent single letters.
 *
 * The reason this exists: a TTS engine handed "I T" will say the English word "it".
 * That is the exact failure the lexicon warns about for the token "IT", and the
 * generic spelling path was walking straight into it. A comma becomes a break in the
 * SSML layer, so adjacent letters are always separated by a pause.
 *
 * Italian letter names are whole syllables ("i", "ti", "erre") and do not merge, so
 * this only fires where it is needed.
 */
function joinSpokenTokens(tokens: string[]): string {
  let out = '';
  tokens.forEach((token, i) => {
    if (i === 0) {
      out = token;
      return;
    }
    const prev = tokens[i - 1]!;
    const adjacentSingleLetters = /^[A-Za-z]$/.test(token) && /^[A-Za-z]$/.test(prev);
    out += adjacentSingleLetters ? `, ${token}` : ` ${token}`;
  });
  return out;
}

/** Spells a mixed alphanumeric identifier: letters as letter names, digits in groups. */
export function spellIdentifier(value: string, lang: Lang): string {
  const chunks = value.match(/[A-Za-z]+|\d+/g) ?? [];
  return chunks
    .map((chunk) => {
      if (/^\d+$/.test(chunk)) return digitsToWords(chunk, lang);
      return joinSpokenTokens(chunk.split('').map((c) => letterName(c, lang)));
    })
    .join(', ');
}

// ---------------------------------------------------------------------------
// Money and dates
// ---------------------------------------------------------------------------

export function euroToWords(amount: number, lang: Lang): string {
  const sign = amount < 0 ? 'meno ' : '';
  const abs = Math.abs(amount);
  const whole = Math.floor(abs);
  const cents = Math.round((abs - whole) * 100);

  if (lang === 'it-IT') {
    const major = whole === 1 ? 'un euro' : `${intToItalian(whole)} euro`;
    if (cents === 0) return `${sign}${major}`;
    const minor = cents === 1 ? 'un centesimo' : `${intToItalian(cents)} centesimi`;
    return `${sign}${major} e ${minor}`;
  }

  const major = whole === 1 ? 'one euro' : `${intToEnglish(whole)} euro`;
  if (cents === 0) return `${sign}${major}`;
  const minor = cents === 1 ? 'one cent' : `${intToEnglish(cents)} cents`;
  return `${sign}${major} and ${minor}`;
}

const IT_MONTHS = [
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
] as const;

const EN_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const EN_ORDINAL_IRREGULAR: Record<number, string> = {
  1: 'first',
  2: 'second',
  3: 'third',
  4: 'fourth',
  5: 'fifth',
  6: 'sixth',
  7: 'seventh',
  8: 'eighth',
  9: 'ninth',
  10: 'tenth',
  11: 'eleventh',
  12: 'twelfth',
  13: 'thirteenth',
  14: 'fourteenth',
  15: 'fifteenth',
  16: 'sixteenth',
  17: 'seventeenth',
  18: 'eighteenth',
  19: 'nineteenth',
  20: 'twentieth',
  30: 'thirtieth',
  40: 'fortieth',
  50: 'fiftieth',
  60: 'sixtieth',
  70: 'seventieth',
  80: 'eightieth',
  90: 'ninetieth',
};

/** Spoken ordinals. "thirty" + "th" is "thirtyth", which is why this is a table. */
export function enOrdinal(n: number): string {
  if (EN_ORDINAL_IRREGULAR[n]) return EN_ORDINAL_IRREGULAR[n]!;
  if (n > 20 && n < 100) {
    const t = Math.floor(n / 10) * 10;
    const u = n % 10;
    return `${EN_TENS[t / 10]}-${EN_ORDINAL_IRREGULAR[u]}`;
  }
  return `${intToEnglish(n)}th`;
}

export function dateToWords(
  year: number,
  month: number,
  day: number,
  lang: Lang,
): string {
  const monthName = (lang === 'it-IT' ? IT_MONTHS : EN_MONTHS)[month - 1] ?? '';
  if (lang === 'it-IT') {
    // "il primo marzo" is idiomatic; every other day takes the cardinal.
    const dayWord = day === 1 ? 'primo' : intToItalian(day);
    return `${dayWord} ${monthName} ${intToItalian(year)}`;
  }
  return `${enOrdinal(day)} of ${monthName} ${intToEnglish(year)}`;
}

export function percentToWords(value: number, lang: Lang): string {
  const n = Number.isInteger(value) ? intToWords(value, lang) : String(value).replace('.', lang === 'it-IT' ? ' virgola ' : ' point ');
  return lang === 'it-IT' ? `${n} per cento` : `${n} per cent`;
}

/**
 * Clock times.
 *
 * Italian uses the 24-hour clock and the ordinal is unambiguous. English does not:
 * "fourteen thirty" is transport-announcement English, not the way a customer service
 * agent speaks. The 12-hour form with an explicit period is what a caller expects.
 */
export function timeToWords(hour: number, minute: number, lang: Lang): string {
  if (lang === 'it-IT') {
    if (minute === 0) return `ore ${intToItalian(hour)}`;
    return `ore ${intToItalian(hour)} e ${intToItalian(minute)}`;
  }

  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const period =
    hour < 12 ? 'in the morning' : hour < 18 ? 'in the afternoon' : 'in the evening';
  const nextHour = h12 === 12 ? 1 : h12 + 1;

  if (minute === 0) return `${intToEnglish(h12)} o'clock ${period}`;
  if (minute === 15) return `quarter past ${intToEnglish(h12)} ${period}`;
  if (minute === 30) return `half past ${intToEnglish(h12)} ${period}`;
  if (minute === 45) return `quarter to ${intToEnglish(nextHour)} ${period}`;
  return `${intToEnglish(h12)} ${minute < 10 ? 'oh ' : ''}${intToEnglish(minute)} ${period}`;
}
