// Encrypted records in IndexedDB for the on-device search index. Every record is sealed with
// AES-256-GCM under a key held by the system's secure storage (through the bridge), with the
// record's name as additional data so records cannot be swapped. A "check" record proves the key:
// when the key changed (it was dropped on sign-out, or the files came from another PC) everything
// is cleared rather than read. Without a key (a phone whose bridge has no secure storage) the
// records stay in memory for this run only, never on disk.

export interface Vault {
  readonly persistent: boolean;
  get(name: string): Promise<Uint8Array | null>;
  getMany(names: string[]): Promise<Array<Uint8Array | null>>;
  put(entries: Array<[string, Uint8Array]>): Promise<void>;
  del(names: string[]): Promise<void>;
  close(): void;
}

const STORE = 'records';
const enc = new TextEncoder();
const CHECK = enc.encode('dexterity-connect search index');

class MemoryVault implements Vault {
  readonly persistent = false;
  private readonly map = new Map<string, Uint8Array>();
  async get(name: string) { return this.map.get(name) ?? null; }
  async getMany(names: string[]) { return names.map((n) => this.map.get(n) ?? null); }
  async put(entries: Array<[string, Uint8Array]>) { for (const [k, v] of entries) this.map.set(k, v); }
  async del(names: string[]) { for (const n of names) this.map.delete(n); }
  close() { this.map.clear(); }
}

type Sealed = { iv: Uint8Array; ct: ArrayBuffer };

const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error ?? new Error('IndexedDB failed')); });
const done = (t: IDBTransaction) => new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onabort = t.onerror = () => rej(t.error ?? new Error('IndexedDB failed')); });

class IdbVault implements Vault {
  readonly persistent = true;
  private readonly db: IDBDatabase;
  private readonly key: CryptoKey;
  constructor(db: IDBDatabase, key: CryptoKey) { this.db = db; this.key = key; }

  async seal(name: string, data: Uint8Array): Promise<Sealed> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(name) }, this.key, data as Uint8Array<ArrayBuffer>);
    return { iv, ct };
  }

  async open(name: string, v: unknown): Promise<Uint8Array | null> {
    const s = v as Sealed | undefined;
    if (!s || !(s.iv instanceof Uint8Array) || !(s.ct instanceof ArrayBuffer)) return null;
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: s.iv as Uint8Array<ArrayBuffer>, additionalData: enc.encode(name) }, this.key, s.ct));
    } catch { return null; }
  }

  async get(name: string) { return (await this.getMany([name]))[0]; }

  async getMany(names: string[]) {
    const t = this.db.transaction(STORE, 'readonly');
    const os = t.objectStore(STORE);
    const raw = await Promise.all(names.map((n) => req(os.get(n))));
    return Promise.all(raw.map((v, i) => this.open(names[i], v)));
  }

  async put(entries: Array<[string, Uint8Array]>) {
    if (!entries.length) return;
    // seal first: a transaction closes when its task has nothing more to do
    const sealed = await Promise.all(entries.map(async ([k, v]) => [k, await this.seal(k, v)] as const));
    const t = this.db.transaction(STORE, 'readwrite');
    const os = t.objectStore(STORE);
    for (const [k, v] of sealed) os.put(v, k);
    await done(t);
  }

  async del(names: string[]) {
    if (!names.length) return;
    const t = this.db.transaction(STORE, 'readwrite');
    const os = t.objectStore(STORE);
    for (const n of names) os.delete(n);
    await done(t);
  }

  async clear() {
    const t = this.db.transaction(STORE, 'readwrite');
    t.objectStore(STORE).clear();
    await done(t);
  }

  close() { this.db.close(); }
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error ?? new Error('IndexedDB failed'));
    r.onblocked = () => rej(new Error('The search index is open elsewhere.'));
  });
}

/** Open the vault `name` with this raw 256-bit key; null (or no IndexedDB) keeps it in memory. */
export async function openVault(name: string, rawKey: Uint8Array | null): Promise<Vault> {
  if (!rawKey || rawKey.length !== 32 || typeof indexedDB === 'undefined' || !globalThis.crypto?.subtle) return new MemoryVault();
  try {
    const key = await crypto.subtle.importKey('raw', rawKey as Uint8Array<ArrayBuffer>, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const v = new IdbVault(await openDb(name), key);
    const check = await v.get('check');
    if (!check || check.length !== CHECK.length || check.some((b, i) => b !== CHECK[i])) {
      // another key sealed what is here (or nothing is): start empty
      await v.clear();
      await v.put([['check', CHECK]]);
    }
    return v;
  } catch (e) {
    console.warn('The search index stays in memory on this device:', (e as Error).message);
    return new MemoryVault();
  }
}

/** Delete every vault whose name starts with `prefix`. */
export async function deleteVaults(prefix: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  let names: string[] = [];
  try { names = (await indexedDB.databases()).map((d) => d.name ?? '').filter((n) => n.startsWith(prefix)); } catch { /* listing not supported */ }
  await Promise.all(names.map((n) => new Promise<void>((res) => { const r = indexedDB.deleteDatabase(n); r.onsuccess = r.onerror = r.onblocked = () => res(); })));
}
