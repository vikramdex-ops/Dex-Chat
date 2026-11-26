// May the IT Support service's exe be run with administrator rights from where it is? Only when
// people without administrator rights cannot change it: an app installed for everyone (Program
// Files). A copy installed for one person lives in their own folder, where anything running as
// them could swap it before an administrator approves the prompt, and the swapped program would
// become a SYSTEM service. No Electron imports, so the unit tests can load it.
import path from 'node:path';

export function trustedExe(exe: string, env: NodeJS.ProcessEnv, packaged: boolean): boolean {
  // a development build (not packaged) is the developer's own
  if (!packaged) return true;
  const roots = [env.ProgramFiles, env.ProgramW6432].filter((x): x is string => !!x).map((x) => `${path.win32.resolve(x).toLowerCase()}\\`);
  const full = path.win32.resolve(exe).toLowerCase();
  return roots.some((r) => full.startsWith(r));
}
