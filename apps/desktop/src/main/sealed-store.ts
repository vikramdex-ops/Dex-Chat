// Device secrets on disk (the identity key and the end-to-end encryption key), sealed by the
// operating system: DPAPI on Windows, the Keychain on macOS, the keyring on Linux, through
// Electron's safeStorage. No Electron import here, so the rules can be tested in Node.
//
// The rules:
// - A sealed key is used whenever the system can unseal it.
// - A key left unsealed (made while sealing was unavailable) is sealed as soon as sealing is
//   available, and the unsealed copy is deleted.
// - A sealed key that cannot be unsealed *right now* (a locked keyring) is never replaced: a new
//   identity would orphan the old one and every message sealed for it. That is an error the app
//   shows; it starts normally once the keyring is unlocked.
// - A sealed key that the system refuses to unseal (copied from another account or PC) is
//   replaced with a new one, which is the point of sealing it.

export interface SealBox {
  /** Real sealing is available (not Linux's "basic_text" fallback, which only obfuscates). */
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface KeyFiles {
  exists(path: string): boolean;
  read(path: string): Buffer;
  /** Atomic: write to a temporary file, then rename. */
  write(path: string, data: string | Buffer): void;
  remove(path: string): void;
}

export class KeyringLockedError extends Error {
  constructor() {
    super("This PC's device key is protected by the system keyring, which is locked or unavailable right now. Unlock it (sign in to the desktop again) and start Dexterity Connect again.");
  }
}

export function loadSealedSecret<T>(o: {
  sealedPath: string; plainPath: string;
  valid: (v: unknown) => v is T; create: () => T;
  box: SealBox; files: KeyFiles;
  log?: (msg: string) => void;
}): T {
  const { box, files } = o;
  const canSeal = box.available();
  const parse = (text: string): T | null => { try { const v = JSON.parse(text) as unknown; return o.valid(v) ? v : null; } catch { return null; } };
  const store = (v: T) => {
    if (canSeal) {
      files.write(o.sealedPath, box.encrypt(JSON.stringify(v)));
      if (files.exists(o.plainPath)) files.remove(o.plainPath);
    } else {
      files.write(o.plainPath, JSON.stringify(v));
    }
  };

  if (files.exists(o.sealedPath)) {
    if (!canSeal) {
      // never fall back to a new key while the real one is only temporarily out of reach
      const plain = files.exists(o.plainPath) ? parse(files.read(o.plainPath).toString('utf8')) : null;
      if (plain) return plain;
      throw new KeyringLockedError();
    }
    let unsealed: T | null = null;
    try { unsealed = parse(box.decrypt(files.read(o.sealedPath))); } catch { unsealed = null; }
    if (unsealed) {
      if (files.exists(o.plainPath)) files.remove(o.plainPath);
      return unsealed;
    }
    o.log?.('the sealed device key could not be unsealed on this account; making a new one');
  } else if (files.exists(o.plainPath)) {
    const plain = parse(files.read(o.plainPath).toString('utf8'));
    if (plain) {
      if (canSeal) {
        // made while sealing was unavailable: seal it now and delete the readable copy
        files.write(o.sealedPath, box.encrypt(JSON.stringify(plain)));
        const back = parse(box.decrypt(files.read(o.sealedPath)));
        if (back && JSON.stringify(back) === JSON.stringify(plain)) files.remove(o.plainPath);
      }
      return plain;
    }
  }
  const fresh = o.create();
  store(fresh);
  return fresh;
}
