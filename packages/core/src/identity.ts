// Device identity: an Ed25519 key pair generated on first launch. The private key never leaves
// the PC (the desktop app seals it with Windows DPAPI); the hub only ever stores the public key.
import crypto from 'node:crypto';

export interface DeviceIdentity {
  deviceId: string;
  /** SPKI DER, base64 */
  publicKey: string;
  /** PKCS8 DER, base64 — keep secret */
  privateKey: string;
}

export function deviceIdFor(publicKeyB64: string): string {
  return crypto.createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').slice(0, 32);
}

export function createIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  return { deviceId: deviceIdFor(pub), publicKey: pub, privateKey: priv };
}

export function signWith(identity: DeviceIdentity, payload: Uint8Array): string {
  const key = crypto.createPrivateKey({ key: Buffer.from(identity.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, payload, key).toString('base64');
}

export function verifySignature(publicKeyB64: string, payload: Uint8Array, signatureB64: string): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return crypto.verify(null, payload, key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

export function isValidIdentity(value: unknown): value is DeviceIdentity {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.deviceId === 'string' && typeof v.publicKey === 'string' && typeof v.privateKey === 'string'
    && deviceIdFor(v.publicKey) === v.deviceId;
}
