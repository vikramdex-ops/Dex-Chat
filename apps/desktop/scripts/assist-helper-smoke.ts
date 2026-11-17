// Windows only (CI's windows-latest runner): compile and start the real remote-control helper
// (PowerShell's Add-Type on the generated C#), then speak its JSON protocol: read the virtual
// screen, move the pointer with SetCursorPos and read it back with GetCursorPos.
//   node apps/desktop/scripts/assist-helper-smoke.ts
import { WindowsHelper } from '../src/main/assist/windows.ts';

if (process.platform !== 'win32') {
  console.log('The input helper runs on Windows only; nothing to check here.');
  process.exit(0);
}

const helper = new WindowsHelper();
const errors: string[] = [];
helper.onError = (m) => errors.push(m);
try {
  const ready = await helper.start(120_000);
  console.log('helper ready:', JSON.stringify(ready));
  const vs = await helper.virtualScreen();
  console.log('virtual screen:', JSON.stringify(vs));
  if (!(vs.width > 0 && vs.height > 0)) throw new Error('The virtual screen has no size.');
  const targets = [
    { x: vs.x + 10, y: vs.y + 10 },
    { x: vs.x + Math.floor(vs.width / 2), y: vs.y + Math.floor(vs.height / 2) },
    { x: vs.x + vs.width - 11, y: vs.y + vs.height - 11 },
  ];
  for (const t of targets) {
    helper.send([JSON.stringify({ t: 'move', x: t.x, y: t.y })]);
    const at = await helper.position();
    console.log(`moved to ${t.x},${t.y}; GetCursorPos says ${at.x},${at.y}`);
    if (at.x !== t.x || at.y !== t.y) throw new Error(`The pointer is at ${at.x},${at.y}, not ${t.x},${t.y}.`);
  }
  if (errors.length) throw new Error(`The helper reported: ${errors.join('; ')}`);
  console.log('INPUT HELPER SMOKE TEST PASSED');
} finally {
  helper.stop();
}
