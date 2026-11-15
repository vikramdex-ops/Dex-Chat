// The phone's device keys (its identity and its end-to-end encryption key), kept wrapped by an
// AES key that lives in the Android Keystore and never leaves it (DexNative.secureGet/secureSet).
// Older versions kept them as plain JSON in the app's preferences; they are moved on first start.
// No Capacitor import here, so the rules can be tested in Node with a stand-in plugin.

export interface SecureStore {
  secureGet(o: { key: string }): Promise<{ value: string | null }>;
  secureSet(o: { key: string; value: string }): Promise<void>;
}

export interface PlainStore {
  get(o: { key: string }): Promise<{ value: string | null }>;
  set(o: { key: string; value: string }): Promise<void>;
  remove(o: { key: string }): Promise<void>;
}

/**
 * The plugin rejects with code "unreadable" when a stored value cannot be unwrapped any more
 * (the Keystore key was wiped, e.g. by a phone restore): the value is gone for good. Any other
 * error means the Keystore is not usable right now.
 */
const unreadable = (e: unknown) => (e as { code?: string })?.code === 'unreadable';

export async function loadSecret<T>(o: {
  key: string;
  valid: (v: unknown) => v is T;
  create: () => T;
  secure: SecureStore;
  plain: PlainStore;
  log?: (msg: string) => void;
}): Promise<T> {
  const parse = (text: string | null): T | null => {
    if (!text) return null;
    try { const v = JSON.parse(text) as unknown; return o.valid(v) ? v : null; } catch { return null; }
  };
  const legacy = async () => parse((await o.plain.get({ key: o.key })).value);

  let stored: string | null = null;
  let usable = true;
  try {
    stored = (await o.secure.secureGet({ key: o.key })).value;
  } catch (e) {
    if (!unreadable(e)) usable = false;
    o.log?.(unreadable(e) ? `${o.key}: the wrapped key can no longer be opened` : `${o.key}: the Android Keystore is unavailable`);
  }
  const current = parse(stored);
  if (current) {
    // a copy left behind by an interrupted move
    if ((await o.plain.get({ key: o.key })).value !== null) await o.plain.remove({ key: o.key });
    return current;
  }

  const old = await legacy();
  if (!usable) {
    // never replace a key because the Keystore is briefly unavailable: use the old copy, or make
    // one that is moved into the Keystore on a later start
    if (old) return old;
    const fresh = o.create();
    await o.plain.set({ key: o.key, value: JSON.stringify(fresh) });
    return fresh;
  }
  const value = old ?? o.create();
  const text = JSON.stringify(value);
  try {
    await o.secure.secureSet({ key: o.key, value: text });
    // only remove the readable copy once the wrapped one reads back the same
    if ((await o.secure.secureGet({ key: o.key })).value === text) {
      if (old) await o.plain.remove({ key: o.key });
      return value;
    }
    o.log?.(`${o.key}: the wrapped copy did not read back; keeping the old one`);
  } catch {
    o.log?.(`${o.key}: could not wrap the key in the Android Keystore`);
  }
  if (!old) await o.plain.set({ key: o.key, value: text });
  return value;
}
