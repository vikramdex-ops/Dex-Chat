// Where the hub keeps its database, certificate and files.
//
// 1. DEXCONNECT_DATA_DIR, when set (the Windows service sets it in its XML).
// 2. Packaged as DexterityConnectHub.exe: the folder named in hub-data-location.txt beside the
//    program. The setup puts the program in Program Files and the data elsewhere (by default
//    C:\ProgramData\Dexterity Connect Hub\hub-data) and writes this file, so running the program
//    by hand (DexterityConnectHub.exe --restore ...) finds the same data as the service.
// 3. Otherwise hub-data beside the program (the zip layout), or in the current folder when run
//    from source with node.
import fs from 'node:fs';
import path from 'node:path';

export const DATA_LOCATION_FILE = 'hub-data-location.txt';

export function resolveDataDir(opts: {
  env: Record<string, string | undefined>;
  execPath: string;
  cwd: string;
  readFile?: (file: string) => string | null;
}): string {
  const fromEnv = opts.env.DEXCONNECT_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;
  const isNode = path.basename(opts.execPath).toLowerCase().startsWith('node');
  if (isNode) return path.join(opts.cwd, 'hub-data');
  const exeDir = path.dirname(opts.execPath);
  const read = opts.readFile ?? ((file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } });
  const text = read(path.join(exeDir, DATA_LOCATION_FILE));
  if (text) {
    // the first line that is not empty; a byte-order mark from Notepad is ignored
    const line = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (line && (path.isAbsolute(line) || path.win32.isAbsolute(line))) return line;
  }
  return path.join(exeDir, 'hub-data');
}
