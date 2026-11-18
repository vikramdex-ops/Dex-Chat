// The web app's own storage: one small IndexedDB key-value store for the device keys and the
// settings. A web app added to the Home Screen has storage of its own, apart from Safari's, and
// Safari does not clear it after a week unused as it may for a page in a tab; the app also asks
// for persistent storage. The keys never leave the iPhone: the hub only ever sees the public halves.
const DB = 'dexconnect';
const STORE = 'kv';

let opening: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { opening = null; reject(r.error ?? new Error('This browser\'s storage could not be opened.')); };
  });
  return opening;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result as T);
    tx.onerror = () => reject(tx.error ?? new Error('Storage failed'));
    tx.onabort = () => reject(tx.error ?? new Error('Storage failed'));
  }));
}

export const kv = {
  get: <T>(key: string) => run<T | undefined>('readonly', (s) => s.get(key)),
  set: (key: string, value: unknown) => run<void>('readwrite', (s) => s.put(value, key)),
  del: (key: string) => run<void>('readwrite', (s) => s.delete(key)),
};

/** Asks the browser to keep this app's data (Safari grants it to Home Screen web apps). */
export async function persist(): Promise<boolean> {
  try { return (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false; } catch { return false; }
}
