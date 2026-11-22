const SECRET_KEY = /(token|secret|password|signature|authorization|api_?key|cookie)/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const WALLET = /0x[0-9a-fA-F]{40,}/g;
const MAX_STRING = 2000;
const MAX_ITEMS = 50;

export interface RedactSelf {
  email: string | null;
  wallets: string[];
}

/** Masks other people's emails and every 0x hex run of 40+ chars (wallets, tx hashes, signatures) but an exact own wallet. */
function masker(self: RedactSelf): (s: string) => string {
  const ownEmail = self.email?.toLowerCase() ?? null;
  const ownWallets = new Set(self.wallets.map((w) => w.toLowerCase()));
  return (s) =>
    s
      .replace(EMAIL, (m) => (ownEmail && m.toLowerCase() === ownEmail ? m : '[email]'))
      .replace(WALLET, (m) => (ownWallets.has(m.toLowerCase()) ? m : '[wallet]'));
}

/** One piece of text masked as redact() masks strings, but never shortened: for text the user must see whole (a card). */
export function redactText(text: string, self: RedactSelf): string {
  return masker(self)(text);
}

export function redact(value: unknown, self: RedactSelf, extraKeys: string[] = []): unknown {
  const extra = new Set(extraKeys);
  const mask = masker(self);

  const str = (s: string): string => {
    let out = mask(s);
    if (out.length > MAX_STRING) out = out.slice(0, MAX_STRING) + '…';
    return out;
  };

  const active = new WeakSet<object>();

  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return str(v);
    if (!v || typeof v !== 'object') return v;
    if (v instanceof Date) return v;
    if (active.has(v)) return '[circular]';
    active.add(v);
    try {
      if (Array.isArray(v)) {
        const items = v.slice(0, MAX_ITEMS).map(walk);
        if (v.length > MAX_ITEMS) items.push(`…and ${v.length - MAX_ITEMS} more`);
        return items;
      }
      const withJson = v as { toJSON?: unknown };
      if (typeof withJson.toJSON === 'function') return walk(withJson.toJSON());
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        if (SECRET_KEY.test(k) || extra.has(k)) continue;
        const base = mask(k);
        let key = base;
        for (let n = 2; key in out; n++) key = `${base} ${n}`;
        out[key] = walk(val);
      }
      return out;
    } finally {
      active.delete(v);
    }
  };

  return walk(value);
}

export function untrusted(tool: string, data: unknown): string {
  return `<untrusted_data tool="${tool}">\n${(JSON.stringify(data) ?? 'null').replace(/</g, '\\u003c')}\n</untrusted_data>`;
}
