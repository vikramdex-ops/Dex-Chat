// The hub's TLS identity: a self-issued certificate created once at install and kept in the data
// folder. Clients pin its SHA-256 fingerprint on first contact (shown in the admin console).
import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import forge from 'node-forge';

export interface HubCertificate {
  key: string;
  cert: string;
  fingerprint: string;
}

export function loadOrCreateCertificate(dir: string, commonName: string): HubCertificate {
  const keyPath = path.join(dir, 'hub-key.pem');
  const certPath = path.join(dir, 'hub-cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const key = fs.readFileSync(keyPath, 'utf8');
    const cert = fs.readFileSync(certPath, 'utf8');
    return { key, cert, fingerprint: new X509Certificate(cert).fingerprint256 };
  }

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const c = forge.pki.createCertificate();
  c.publicKey = keys.publicKey;
  c.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(15));
  c.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  c.validity.notAfter = new Date(Date.now() + 20 * 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: commonName }, { name: 'organizationName', value: 'Dexterity Connect' }];
  c.setSubject(attrs);
  c.setIssuer(attrs);
  c.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
  ]);
  c.sign(keys.privateKey, forge.md.sha256.create());

  const key = forge.pki.privateKeyToPem(keys.privateKey);
  const cert = forge.pki.certificateToPem(c);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  fs.writeFileSync(certPath, cert);
  return { key, cert, fingerprint: new X509Certificate(cert).fingerprint256 };
}
