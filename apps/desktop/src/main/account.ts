// Reads who is signed in to Windows: account, domain (or PC name on a workgroup) and full name.
import os from 'node:os';
import { execFile } from 'node:child_process';
import type { WindowsAccount } from '@dex/core';

/** "priya.raman" -> "Priya Raman" when Windows has no full name on record. */
export function prettifyUsername(username: string): string {
  return username
    .split(/[._\-\s]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase())
    .join(' ') || username;
}

function windowsFullName(): Promise<string | null> {
  // UserPrincipal works for both local and domain accounts; it is skipped quietly if the
  // domain controller is unreachable. Bounded so a slow DC never delays start-up.
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.DirectoryServices.AccountManagement',
    '[System.DirectoryServices.AccountManagement.UserPrincipal]::Current.DisplayName',
  ].join('; ');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 4000, windowsHide: true }, (err, stdout) => {
        const name = (stdout || '').trim();
        resolve(err || !name ? null : name.slice(0, 80));
      });
  });
}

export async function detectAccount(): Promise<WindowsAccount> {
  const info = os.userInfo();
  const hostname = os.hostname().toUpperCase();
  const domain = (process.env.USERDOMAIN || hostname).toUpperCase();
  const fullName = process.platform === 'win32' ? await windowsFullName() : null;
  return {
    username: info.username,
    domain,
    hostname,
    displayName: fullName || prettifyUsername(info.username),
  };
}
