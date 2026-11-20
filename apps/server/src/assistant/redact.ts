const SECRET_KEY = /(token|secret|password|signature|authorization|api_?key|cookie)/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const WALLET = /0x[0-9a-fA-F]{40}/g;
const MAX_STRING = 2000;
const MAX_ITEMS = 50;

export interface RedactSelf {
  email: string | null;
  wallets: string[];
}

export function redact(value: unknown, self: RedactSelf, extraKeys: string[] = []): unknown {
  const ownEmail = self.email?.toLowerCase() ?? null;
  const ownWallets = new Set(self.wallets.map((w) => w.toLowerCase()));
  const extra = new Set(extraKeys);

  const str = (s: string): string => {
    let out = s
      .replace(EMAIL, (m) => (ownEmail && m.toLowerCase() === ownEmail ? m : '[email]'))
      .replace(WALLET, (m) => (ownWallets.has(m.toLowerCase()) ? m : '[wallet]'));
    if (out.length > MAX_STRING) out = out.slice(0, MAX_STRING) + '…';
    return out;
  };

  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return str(v);
    if (Array.isArray(v)) {
      const items = v.slice(0, MAX_ITEMS).map(walk);
      if (v.length > MAX_ITEMS) items.push(`…and ${v.length - MAX_ITEMS} more`);
      return items;
    }
    if (v && typeof v === 'object') {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return v;
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        if (SECRET_KEY.test(k) || extra.has(k)) continue;
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };

  return walk(value);
}

export function untrusted(tool: string, data: unknown): string {
  return `<untrusted_data tool="${tool}">\n${JSON.stringify(data).replace(/</g, '\\u003c')}\n</untrusted_data>`;
}
