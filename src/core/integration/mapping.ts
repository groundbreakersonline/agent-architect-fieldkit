/**
 * Field mapping and XML handling.
 *
 * Agent platforms speak slots; enterprises speak nested JSON, namespaced XML, and
 * codes nobody wrote down. This is the layer where "we will just map the fields"
 * turns into three weeks, so it is worth making declarative, testable, and explicit
 * about what it could not find.
 */

export type TransformName =
  | 'trim'
  | 'upper'
  | 'lower'
  | 'titleCase'
  | 'digitsOnly'
  | 'isoToItDate'
  | 'isoToItDateTime'
  | 'maskTaxCode'
  | 'maskIban'
  | 'joinAddress'
  | 'eur';

export interface FieldMap {
  /** Slot name the agent will use. */
  to: string;
  /** Dotted path into the source document. */
  from: string;
  transform?: TransformName | TransformName[];
  required?: boolean;
}

export interface MappingResult {
  values: Record<string, unknown>;
  missingRequired: string[];
  applied: Array<{ to: string; from: string; raw: unknown; value: unknown }>;
}

export function getPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    if (typeof acc !== 'object') return undefined;
    const idx = /^\d+$/.test(key) ? Number(key) : key;
    return (acc as Record<string | number, unknown>)[idx];
  }, source);
}

const TRANSFORMS: Record<TransformName, (v: unknown) => unknown> = {
  trim: (v) => String(v ?? '').trim(),
  upper: (v) => String(v ?? '').toUpperCase(),
  lower: (v) => String(v ?? '').toLowerCase(),
  titleCase: (v) =>
    String(v ?? '')
      .toLowerCase()
      .replace(/(^|[\s'-])(\p{L})/gu, (_m, sep, ch) => sep + ch.toUpperCase()),
  digitsOnly: (v) => String(v ?? '').replace(/\D+/g, ''),
  isoToItDate: (v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v ?? '');
  },
  isoToItDateTime: (v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(v ?? ''));
    return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : String(v ?? '');
  },
  maskTaxCode: (v) => {
    const s = String(v ?? '');
    return s.length > 6 ? `${s.slice(0, 3)}**********${s.slice(-2)}` : '**********';
  },
  maskIban: (v) => {
    const s = String(v ?? '').replace(/\s+/g, '');
    return s.length > 4 ? `****${s.slice(-4)}` : '****';
  },
  joinAddress: (v) => {
    if (typeof v !== 'object' || v === null) return '';
    const a = v as Record<string, string>;
    return [a.street, a.civic, a.postalCode, a.city, a.province]
      .filter(Boolean)
      .join(', ');
  },
  eur: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v ?? '');
    return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(n);
  },
};

export function mapFields(source: unknown, maps: FieldMap[]): MappingResult {
  const values: Record<string, unknown> = {};
  const missingRequired: string[] = [];
  const applied: MappingResult['applied'] = [];

  for (const map of maps) {
    const raw = getPath(source, map.from);
    if (raw === undefined || raw === null || raw === '') {
      if (map.required) missingRequired.push(map.to);
      continue;
    }
    const names = map.transform
      ? Array.isArray(map.transform)
        ? map.transform
        : [map.transform]
      : [];
    const value = names.reduce<unknown>((acc, name) => TRANSFORMS[name](acc), raw);
    values[map.to] = value;
    applied.push({ to: map.to, from: map.from, raw, value });
  }

  return { values, missingRequired, applied };
}

// ---------------------------------------------------------------------------
// Minimal XML reader
// ---------------------------------------------------------------------------

export interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
}

/**
 * Namespace-tolerant XML reader. Enterprise SOAP and "REST" endpoints return
 * documents like this constantly, and pulling a 200KB parser into an edge runtime
 * is rarely the right trade.
 */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#document', attributes: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const tokens = xml.match(/<[^>]+>|[^<]+/g) ?? [];

  for (const token of tokens) {
    if (token.startsWith('<?') || token.startsWith('<!')) continue;

    if (token.startsWith('</')) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    if (token.startsWith('<')) {
      const selfClosing = token.endsWith('/>');
      const inner = token.slice(1, selfClosing ? -1 : -1).trim();
      const spaceAt = inner.search(/\s/);
      const rawName = spaceAt === -1 ? inner : inner.slice(0, spaceAt);
      const name = rawName.replace(/^[^:]+:/, ''); // strip namespace prefix
      const attrText = spaceAt === -1 ? '' : inner.slice(spaceAt);

      const attributes: Record<string, string> = {};
      for (const m of attrText.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
        attributes[m[1]!.replace(/^[^:]+:/, '')] = m[2]!;
      }

      const node: XmlNode = { name, attributes, children: [], text: '' };
      stack[stack.length - 1]!.children.push(node);
      if (!selfClosing) stack.push(node);
      continue;
    }

    const text = token.trim();
    if (text) stack[stack.length - 1]!.text += text;
  }

  return root;
}

export function findAll(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    if (n.name === name) out.push(n);
    n.children.forEach(walk);
  };
  walk(node);
  return out;
}

/** Flattens a node's attributes plus text into a plain object. */
export function nodeToRecord(node: XmlNode): Record<string, unknown> {
  return { ...node.attributes, text: node.text || undefined };
}
