// The IT Support service on this PC (docs/HELP-DESK.md, "Elevated control"): is it installed and
// running, and install or remove it. Installing needs administrator rights: Windows asks (UAC) and
// DexSupport.exe --install copies itself to Program Files, pins this office hub and starts. The
// app never runs anything elevated without that prompt.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import { powershellPath } from './windows.ts';
import { trustedExe } from './trust.ts';

export interface SupportServiceDeps {
  /** The office hub this app is connected to on the office network (null through the internet gateway). */
  endpoint(): { host: string; port: number; fp: string } | null;
  fromMain(e: Electron.IpcMainInvokeEvent): boolean;
  log(level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>): void;
}

const NAME = 'DexConnectSupport';

/** DexSupport.exe as shipped (resources/support) or as built for development (build/support). */
export function supportExe(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'support', 'DexSupport.exe') : path.join(app.getAppPath(), 'build', 'support', 'DexSupport.exe');
}

/** Program Files as HKLM records it (an environment variable could be set by anyone running as the user). */
async function programFiles(): Promise<string[]> {
  const reg = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
  const r = await run(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion', '/v', 'ProgramFilesDir'], 10_000);
  const m = r.out.match(/ProgramFilesDir\s+REG_SZ\s+(.+)/);
  return m ? [m[1].trim()] : [];
}

const run = (file: string, args: string[], timeout = 120_000) => new Promise<{ code: number; out: string }>((resolve) => {
  execFile(file, args, { windowsHide: true, timeout }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
    resolve({ code, out: `${stdout}${stderr}`.trim() });
  });
});

export async function serviceStatus(): Promise<{ available: boolean; installed: boolean; running: boolean }> {
  if (process.platform !== 'win32') return { available: false, installed: false, running: false };
  const r = await run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'sc.exe'), ['query', NAME], 10_000);
  return { available: true, installed: r.code === 0, running: r.code === 0 && /RUNNING/.test(r.out) };
}

/** Run DexSupport.exe with these arguments as administrator (Windows asks); resolves with its exit code. */
async function elevated(args: string[]): Promise<{ ok: boolean; error: string | null }> {
  if (!trustedExe(supportExe(), await programFiles(), app.isPackaged)) return { ok: false, error: 'Dexterity Connect is installed for one person on this PC, so its files can be changed without administrator rights. Install the IT Support service with the setup run as an administrator instead: DexterityConnect-Setup.exe /S /SUPPORTHUB=hub:port /SUPPORTFP=fingerprint (Control room shows both).' };
  const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
  // a declined prompt (or a missing file) is an error from Start-Process, never "success"
  // declined: Win32 error 1223 (ERROR_CANCELLED) in any language of Windows
  const script = `try { $p = Start-Process -FilePath ${quote(supportExe())} -ArgumentList ${quote(args.map((a) => `"${a}"`).join(' '))} -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop } catch { $e = $_.Exception; while ($e) { if ($e.NativeErrorCode -eq 1223) { exit 1223 }; $e = $e.InnerException }; [Console]::Error.WriteLine($_.Exception.Message); exit 1 }; if ($null -eq $p) { exit 1 }; exit $p.ExitCode`;
  // no time limit: an administrator may take a while at the prompt, and the install then runs
  const r = await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], 0);
  if (r.code === 0) return { ok: true, error: null };
  if (r.code === 1223) return { ok: false, error: 'Windows did not get administrator approval, so nothing was changed.' };
  if (r.code === 5) return { ok: false, error: 'This needs an administrator account on this PC.' };
  return { ok: false, error: `The IT Support service setup stopped (${r.code}). ${r.out.split(/\r?\n/).slice(-2).join(' ')}`.trim() };
}

export function wireSupportService(deps: SupportServiceDeps): void {
  ipcMain.handle('support:status', async (e) => (deps.fromMain(e) ? serviceStatus() : { available: false, installed: false, running: false }));
  ipcMain.handle('support:install', async (e) => {
    if (!deps.fromMain(e)) return { ok: false, error: 'Not allowed from this window.' };
    if (process.platform !== 'win32') return { ok: false, error: 'The IT Support service is for Windows PCs.' };
    const ep = deps.endpoint();
    if (!ep) return { ok: false, error: 'Install it while this PC is on the office network (connected to the hub directly, not through the internet gateway).' };
    deps.log('info', 'installing the IT Support service', { hub: `${ep.host}:${ep.port}` });
    const r = await elevated(['--install', '--hub', `${ep.host}:${ep.port}`, '--fingerprint', ep.fp]);
    deps.log(r.ok ? 'info' : 'warn', r.ok ? 'IT Support service installed' : 'IT Support service not installed', r.error ? { error: r.error } : undefined);
    return r;
  });
  ipcMain.handle('support:uninstall', async (e) => {
    if (!deps.fromMain(e)) return { ok: false, error: 'Not allowed from this window.' };
    const r = await elevated(['--uninstall']);
    deps.log(r.ok ? 'info' : 'warn', r.ok ? 'IT Support service removed' : 'IT Support service not removed', r.error ? { error: r.error } : undefined);
    return r;
  });
}
