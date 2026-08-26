export const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

export const cx = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ');

export function normServer(s: string) {
  const t = (s || '').trim();
  if (!t) return '';
  if (!/^https?:\/\//i.test(t)) return `http://${t}`.replace(/\/+$/, '');
  return t.replace(/\/+$/, '');
}

export function fmtTime(ts: number) {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function decodePossiblyBase64Utf8(value: unknown): string {
  const raw = value == null ? '' : String(value);
  if (!raw) return '';

  const looksBase64 = /^[A-Za-z0-9+/=\r\n]+$/.test(raw) && raw.replace(/\s+/g, '').length % 4 === 0;
  if (looksBase64) {
    try {
      const bin = atob(raw.replace(/\s+/g, ''));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
      // fall through
    }
  }

  // Repair common UTF-8-as-Latin1 mojibake sequences, e.g. "NjÃ«"
  if (raw.includes('Ã') || raw.includes('Â')) {
    try {
      const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0) & 0xff);
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
      // noop
    }
  }

  return raw;
}

export function parseEpgTs(value: unknown): number {
  const s = value == null ? '' : String(value).trim();
  if (!s) return 0;

  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }

  // XMLTV timestamps: YYYYMMDDHHMMSS +0000 / -0300 / Z
  const xmltv = s.match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*(Z|[+-]\d{4}))?$/,
  );
  if (xmltv) {
    const [, yy, mm, dd, hh, mi, ss, tzRaw] = xmltv;
    const baseUtcSec = Date.UTC(
      Number(yy),
      Number(mm) - 1,
      Number(dd),
      Number(hh),
      Number(mi),
      Number(ss),
    ) / 1000;
    if (!Number.isFinite(baseUtcSec)) return 0;

    if (!tzRaw || tzRaw === 'Z') return Math.floor(baseUtcSec);

    const sign = tzRaw.startsWith('+') ? 1 : -1;
    const tzh = Number(tzRaw.slice(1, 3));
    const tzm = Number(tzRaw.slice(3, 5));
    if (!Number.isFinite(tzh) || !Number.isFinite(tzm)) return 0;
    const offsetSec = sign * ((tzh * 60 + tzm) * 60);
    return Math.floor(baseUtcSec - offsetSec);
  }

  const normalized = s.includes('T') ? s : s.replace(' ', 'T');
  const ms = Date.parse(normalized);
  if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  return 0;
}
