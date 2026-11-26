// The IT Support service on this PC (docs/HELP-DESK.md, "Elevated control"): is it installed and
// running, and install or remove it. Installing needs administrator rights: Windows asks (UAC) and
// DexSupport.exe --install copies itself to Program Files, pins this office hub and starts. The
// app never runs anything elevated without that prompt.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import { powershellPath } from './windows.ts';

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
  const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const script = `$p = Start-Process -FilePath ${quote(supportExe())} -ArgumentList ${quote(args.map((a) => `"${a}"`).join(' '))} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`;
  const r = await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (r.code === 0) return { ok: true, error: null };
  if (/canceled by the user|cancelled by the user/i.test(r.out)) return { ok: false, error: 'Windows did not get administrator approval, so nothing was changed.' };
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
