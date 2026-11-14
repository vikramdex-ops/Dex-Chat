// Data-loss prevention: rules an administrator sets so that sensitive numbers and words don't leave
// in messages. The hub applies them to everything it can read; for end-to-end encrypted Direct
// messages the sender's own device applies them before sealing (the hub cannot read those).
// Also: which internet addresses may connect from outside the office (CIDR lists).

export type DlpDetector = 'card' | 'aadhaar' | 'pan' | 'bank' | 'words';

export interface DlpRule {
  id: string;
  /** Shown to the writer when a message is stopped, e.g. "Card numbers". */
  name: string;
  detector: DlpDetector;
  /** For 'words': comma- or line-separated words and phrases (matched whole, any case). */
  words?: string;
  /** block: the message is not sent; mask: the match is replaced with •••• */
  action: 'block' | 'mask';
  /** everywhere, or only in conversations that include a guest from outside the company */
  scope: 'everywhere' | 'with-guests';
}

export const DLP_DETECTORS: Record<DlpDetector, string> = {
  card: 'Payment card numbers',
  aadhaar: 'Aadhaar numbers',
  pan: 'PAN numbers',
  bank: 'Bank account and IFSC details',
  words: 'Words and phrases you choose',
};

const luhn = (digits: string): boolean => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};

// Verhoeff checksum (Aadhaar's last digit)
const VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
const verhoeff = (digits: string): boolean => {
  let c = 0;
  const r = digits.split('').reverse();
  for (let i = 0; i < r.length; i++) c = VD[c][VP[i % 8][r[i].charCodeAt(0) - 48]];
  return c === 0;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every match of one rule in the text, as [start, end) ranges. */
export function dlpMatches(text: string, rule: DlpRule): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const each = (re: RegExp, ok: (m: RegExpExecArray) => boolean = () => true) => {
    for (const m of text.matchAll(re)) if (ok(m as RegExpExecArray)) out.push([m.index!, m.index! + m[0].length]);
  };
  switch (rule.detector) {
    case 'card':
      each(/(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g, (m) => { const d = m[0].replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d) && !/^(\d)\1+$/.test(d); });
      break;
    case 'aadhaar':
      each(/(?<![\d-])[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}(?![\d-])/g, (m) => verhoeff(m[0].replace(/\D/g, '')));
      break;
    case 'pan':
      each(/\b[A-Z]{3}[PCHFATBLJG][A-Z]\d{4}[A-Z]\b/g);
      break;
    case 'bank':
      each(/\b[A-Z]{4}0[A-Z0-9]{6}\b/g); // IFSC
      each(/(?:a\/?c|account)(?:\s*(?:no|number|#)\.?)?\s*[:.-]?\s*\d{9,18}\b/gi);
      break;
    case 'words': {
      const words = (rule.words ?? '').split(/[,\n]/).map((w) => w.trim()).filter((w) => w.length >= 2).slice(0, 200);
      if (!words.length) break;
      each(new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'giu'));
      break;
    }
  }
  return out;
}

export interface DlpResult { text: string; blockedBy: DlpRule | null; masked: string[] }

/** Apply the rules that are in scope. A block wins over masking. */
export function applyDlp(text: string, rules: DlpRule[] | undefined, ctx: { withGuests: boolean }): DlpResult {
  if (!text || !rules?.length) return { text, blockedBy: null, masked: [] };
  const live = rules.filter((r) => r.scope === 'everywhere' || ctx.withGuests);
  for (const r of live) if (r.action === 'block' && dlpMatches(text, r).length) return { text, blockedBy: r, masked: [] };
  const ranges: Array<[number, number]> = [];
  const masked: string[] = [];
  for (const r of live) {
    if (r.action !== 'mask') continue;
    const m = dlpMatches(text, r);
    if (m.length) { ranges.push(...m); masked.push(r.name); }
  }
  if (!ranges.length) return { text, blockedBy: null, masked: [] };
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let at = 0;
  for (const [s, e] of ranges) {
    if (e <= at) continue;
    out += text.slice(at, Math.max(at, s)) + '••••';
    at = e;
  }
  return { text: out + text.slice(at), blockedBy: null, masked };
}

export const dlpBlockedMessage = (r: DlpRule) => `Not sent: your office doesn't allow ${r.name.toLowerCase()} in messages${r.scope === 'with-guests' ? ' that guests can see' : ''}.`;

/** Check rules an administrator typed. */
export function validDlpRules(raw: unknown): DlpRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).flatMap((x): DlpRule[] => {
    const r = x as Partial<DlpRule>;
    if (!r || typeof r !== 'object' || !(r.detector && r.detector in DLP_DETECTORS)) return [];
    const words = r.detector === 'words' ? String(r.words ?? '').slice(0, 4000) : undefined;
    if (r.detector === 'words' && !words?.trim()) return [];
    return [{
      id: typeof r.id === 'string' && /^[\w-]{1,40}$/.test(r.id) ? r.id : Math.random().toString(36).slice(2, 10),
      name: String(r.name ?? DLP_DETECTORS[r.detector]).trim().slice(0, 60) || DLP_DETECTORS[r.detector],
      detector: r.detector,
      ...(words !== undefined ? { words } : {}),
      action: r.action === 'mask' ? 'mask' : 'block',
      scope: r.scope === 'with-guests' ? 'with-guests' : 'everywhere',
    }];
  });
}

// ------------------------------------------------------------------ networks
const v4 = (ip: string): number | null => {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.some((x) => x > 255) ? null : ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
};
const v6 = (ip: string): bigint | null => {
  if (!ip.includes(':')) return null;
  const [head, tail] = ip.split('::');
  if (ip.split('::').length > 2) return null;
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.reduce((n, g) => (n << 16n) + BigInt(parseInt(g, 16)), 0n);
};

/** "203.0.113.0/24", "2001:db8::/32" or a single address. */
export function validCidr(s: string): boolean {
  const [ip, bits] = s.trim().split('/');
  const four = v4(ip);
  if (four !== null) return bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= 32);
  return v6(ip) !== null && (bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= 128));
}

export function ipAllowed(ip: string, cidrs: string[] | undefined): boolean {
  if (!cidrs?.length) return true;
  const addr = ip.replace(/^::ffff:/i, '').trim();
  const a4 = v4(addr);
  const a6 = a4 === null ? v6(addr) : null;
  for (const c of cidrs) {
    const [net, bitsRaw] = c.trim().split('/');
    const n4 = v4(net);
    if (n4 !== null && a4 !== null) {
      const bits = bitsRaw === undefined ? 32 : Number(bits4(bitsRaw));
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if (((a4 & mask) >>> 0) === ((n4 & mask) >>> 0)) return true;
    }
    const n6 = n4 === null ? v6(net) : null;
    if (n6 !== null && a6 !== null) {
      const bits = BigInt(bitsRaw === undefined ? 128 : Math.min(128, Number(bitsRaw)));
      const shift = 128n - bits;
      if ((a6 >> shift) === (n6 >> shift)) return true;
    }
  }
  return false;
}
const bits4 = (s: string) => Math.max(0, Math.min(32, Number(s) || 0));
