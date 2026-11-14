// The other Dexterity office tools on this PC, found by the link schemes their installers
// register, and a safe way to open links meant for them.
import { execFile } from 'node:child_process';
import { shell } from 'electron';

export const TOOL_SCHEMES = { projectopener: 'Project Opener', dexterity: 'Dexterity Sheets', sleuth: 'Sleuth', datum: 'Datum' } as const;
export type ToolScheme = keyof typeof TOOL_SCHEMES;

function registered(scheme: string): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false);
  const ask = (root: string) => new Promise<boolean>((resolve) => {
    execFile('reg', ['query', `${root}\\Software\\Classes\\${scheme}`, '/ve'], { windowsHide: true, timeout: 4000 }, (err) => resolve(!err));
  });
  return ask('HKCU').then((yes) => yes || ask('HKLM'));
}

let cache: Promise<Record<ToolScheme, boolean>> | null = null;
export function installedTools(): Promise<Record<ToolScheme, boolean>> {
  cache ??= Promise.all((Object.keys(TOOL_SCHEMES) as ToolScheme[]).map(async (s) => [s, await registered(s)] as const))
    .then((pairs) => Object.fromEntries(pairs) as Record<ToolScheme, boolean>);
  return cache;
}

/** Open a web link or a link for one of the office tools; anything else is refused. */
export async function openToolLink(url: string): Promise<void> {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error('That link is not valid.'); }
  const scheme = u.protocol.replace(/:$/, '');
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') { await shell.openExternal(url); return; }
  if (!(scheme in TOOL_SCHEMES)) throw new Error('Dexterity Connect does not open that kind of link.');
  const tools = await installedTools();
  if (process.platform === 'win32' && !tools[scheme as ToolScheme]) throw new Error(`${TOOL_SCHEMES[scheme as ToolScheme]} is not installed on this PC.`);
  await shell.openExternal(url);
}
