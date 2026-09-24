/**
 * Pronunciation lexicon.
 *
 * Every acronym in this file is a word the engine will otherwise guess. "IT" becomes
 * the English word "it", "SAP" becomes "sap", "IVA" becomes a name. The lexicon is
 * emitted as W3C PLS so it can be uploaded to the TTS vendor, and as a flat map for
 * platforms that take a key/value pronunciation list instead.
 */
import type { Lang } from './numbers';

export interface LexiconEntry {
  grapheme: string;
  /** IPA target, where a vendor accepts phonemes. */
  phoneme?: string;
  /** Plain replacement, for vendors that only accept text substitution. */
  alias?: string;
  note: string;
  source: 'brand' | 'legal' | 'asr_recovery';
}

export const LEXICON: LexiconEntry[] = [
  {
    grapheme: 'IT',
    alias: 'i ti',
    note: 'Country prefix in policy numbers. Without this the engine says the English word "it".',
    source: 'legal',
  },
  {
    grapheme: 'SAP',
    alias: 'esse a pi',
    note: 'Partner product name. Spelled in Italian, not pronounced as a word.',
    source: 'brand',
  },
  {
    grapheme: 'TUI',
    alias: 'tu i',
    note: 'Customer brand. Spelled letter by letter in Italian markets.',
    source: 'brand',
  },
  {
    grapheme: 'IVA',
    alias: 'i va',
    note: 'Imposta sul valore aggiunto. Must never be read as a word.',
    source: 'legal',
  },
  {
    grapheme: 'OTP',
    alias: 'o ti pi',
    note: 'One-time passcode. Spelled, never read as a word.',
    source: 'legal',
  },
  {
    grapheme: 'PIN',
    alias: 'pin',
    note: 'Read as a word in Italian, unlike OTP.',
    source: 'asr_recovery',
  },
  {
    grapheme: 'IBAN',
    alias: 'i ban',
    note: 'Read as a word. Callers recognise it instantly.',
    source: 'legal',
  },
  {
    grapheme: 'SPID',
    alias: 'spid',
    note: 'Digital identity scheme. Read as a word.',
    source: 'legal',
  },
  {
    grapheme: 'PEC',
    alias: 'pec',
    note: 'Certified email. Read as a word.',
    source: 'legal',
  },
  {
    grapheme: 'RCA',
    alias: 'erre ci a',
    note: 'Responsabilita civile auto. Spelled, because "rca" reads as a word.',
    source: 'brand',
  },
  {
    grapheme: 'KPI',
    alias: 'ca pi i',
    note: 'Internal reporting term that leaks into agent speech during escalations.',
    source: 'brand',
  },
  {
    grapheme: 'SLA',
    alias: 'esse elle a',
    note: 'Never say this to a customer. Listed so the lint rule can flag it.',
    source: 'brand',
  },
  {
    grapheme: 'BarmeniaGothaer',
    alias: 'Barmenia Gothaer',
    note: 'Customer brand. The concatenation confuses word segmentation.',
    source: 'brand',
  },
  {
    grapheme: 'Gothaer',
    phoneme: 'ˈɡoːtaɐ',
    note: 'German brand. Italian voices default to an Italianised reading.',
    source: 'brand',
  },
  {
    grapheme: 'Polaris',
    phoneme: 'poˈlaːris',
    note: 'Client brand, stressed on the second syllable. Italian voices default to the English reading.',
    source: 'brand',
  },
];

export function toDictionary(entries: LexiconEntry[] = LEXICON): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries) {
    if (e.alias) out[e.grapheme] = e.alias;
  }
  return out;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** W3C Pronunciation Lexicon Specification document, ready to upload to the vendor. */
export function toPls(entries: LexiconEntry[] = LEXICON, lang: Lang = 'it-IT'): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<lexicon version="1.0" xmlns="http://www.w3.org/2005/01/pronunciation-lexicon"`,
    `  xml:lang="${lang}" alphabet="ipa"`,
    '  xmlns:fk="https://example.invalid/fieldkit">',
  ];
  for (const e of entries) {
    lines.push(`  <lexeme>`);
    lines.push(`    <grapheme>${escapeXml(e.grapheme)}</grapheme>`);
    if (e.phoneme) lines.push(`    <phoneme>${escapeXml(e.phoneme)}</phoneme>`);
    if (e.alias) lines.push(`    <alias>${escapeXml(e.alias)}</alias>`);
    lines.push(`    <fk:note source="${e.source}">${escapeXml(e.note)}</fk:note>`);
    lines.push(`  </lexeme>`);
  }
  lines.push('</lexicon>');
  return lines.join('\n');
}

/**
 * Terms that must never reach a customer, regardless of what the model produces.
 * This is the "brand standard" half of the rule set: not how to say things, but what
 * not to say.
 */
export const FORBIDDEN_IN_AGENT_SPEECH = [
  'SLA',
  'KPI',
  'ticket',
  'backend',
  'API',
  'prompt',
  'token',
  'fallback',
] as const;

export interface SpeechLintFinding {
  term: string;
  index: number;
  advice: string;
}

export function lintAgentSpeech(text: string): SpeechLintFinding[] {
  const findings: SpeechLintFinding[] = [];
  for (const term of FORBIDDEN_IN_AGENT_SPEECH) {
    const re = new RegExp(`\\b${term}\\b`, 'gi');
    for (const m of text.matchAll(re)) {
      findings.push({
        term: m[0],
        index: m.index ?? 0,
        advice: `Internal vocabulary. Say what the customer gets instead of how it is built.`,
      });
    }
  }
  return findings;
}
