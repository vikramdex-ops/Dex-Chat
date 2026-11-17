// Remote assistance in the main process: the Windows helper's C# and PowerShell (generated here,
// run on Windows only), the JSON lines both sides speak, xdotool's commands on Linux, the control
// gate between the technician and the injector, and diagnostics (which must hold no secrets).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { encodeCommand, helperArgs, helperCommands, helperScript, helperSource, powershellPath } from '../src/main/assist/windows.ts';
import { xdotoolCommands } from '../src/main/assist/linux.ts';
import { RemoteControl } from '../src/main/assist/control.ts';
import type { InputSink } from '../src/main/assist/control.ts';
import { collectDiagnostics, isStunAnswer, parseIceUrl, probeIce, stunRequest } from '../src/main/assist/diagnostics.ts';
import { AppLog, redact } from '../src/main/applog.ts';
import type { InputEvent, Rect } from '../../../packages/core/src/assist.ts';

test('the helper source: the Windows calls it needs, written for the C# 5 compiler of Windows PowerShell', () => {
  const src = helperSource();
  for (const fn of ['SendInput', 'SetCursorPos', 'GetCursorPos', 'GetSystemMetrics', 'SetProcessDpiAwarenessContext', 'SetProcessDPIAware', 'MapVirtualKey']) {
    assert.match(src, new RegExp(`\\[DllImport\\("user32\\.dll"[^\\]]*\\] static extern \\w+ ${fn}\\(`), fn);
  }
  // the virtual screen (every monitor), and per-monitor DPI awareness v2 (-4)
  for (const c of ['SM_XVIRTUALSCREEN = 76', 'SM_YVIRTUALSCREEN = 77', 'SM_CXVIRTUALSCREEN = 78', 'SM_CYVIRTUALSCREEN = 79', 'MOUSEEVENTF_VIRTUALDESK = 0x4000', 'MOUSEEVENTF_ABSOLUTE = 0x8000', 'new IntPtr(-4)']) assert.ok(src.includes(c), c);
  assert.ok(src.includes('namespace DexAssist') && src.includes('public static void Run()'));
  // C# 6+ syntax would not compile with Add-Type on Windows PowerShell 5.1
  assert.ok(!/\$"/.test(src), 'no string interpolation');
  assert.ok(!/\?\./.test(src), 'no null-conditional');
  assert.ok(!/=>/.test(src), 'no expression bodies or lambdas');
  assert.ok(!/\bnameof\(|\bout var\b/.test(src));
  const count = (ch: string) => [...src].filter((c) => c === ch).length;
  assert.equal(count('{'), count('}'), 'braces balance');
  assert.equal(count('('), count(')'), 'parentheses balance');
});

test('the PowerShell script compiles the source with Add-Type and travels as -EncodedCommand', () => {
  const script = helperScript();
  assert.ok(script.includes("Add-Type -Language CSharp -TypeDefinition @'\n"));
  assert.ok(script.includes(helperSource()), 'the source is embedded as it is');
  assert.ok(script.trimEnd().endsWith('[DexAssist.Helper]::Run()'));
  assert.throws(() => helperScript("class X {}\n'@\nRemove-Item C:\\"), /here-string/);
  const enc = encodeCommand(script);
  assert.equal(Buffer.from(enc, 'base64').toString('utf16le'), script);
  const args = helperArgs();
  assert.deepEqual(args.slice(0, 6), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  assert.ok(args.join(' ').length < 32_000, 'fits a Windows command line');
  assert.equal(powershellPath({ SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

/** The C# parser's own regular expression, taken from the source, to check the lines we write against it. */
function csharpParser(): (line: string) => Record<string, string> {
  const m = helperSource().match(/new Regex\("((?:[^"\\]|\\.)*)"/);
  assert.ok(m, 'the parser regex is in the source');
  const pattern = m![1].replace(/\\(["\\])/g, '$1');
  const re = new RegExp(pattern, 'g');
  return (line) => {
    const out: Record<string, string> = {};
    for (const x of line.matchAll(re)) out[x[1]] = x[3] !== undefined ? x[3] : x[2];
    return out;
  };
}

test('the JSON lines: each input event becomes helper commands the C# side reads back exactly', () => {
  const parse = csharpParser();
  const left: Rect = { x: -2560, y: -200, width: 2560, height: 1440 };
  const lines = (ev: InputEvent) => helperCommands(ev, left).map(parse);
  assert.deepEqual(lines({ t: 'move', x: 0, y: 0 }), [{ t: 'move', x: '-2560', y: '-200' }]);
  assert.deepEqual(lines({ t: 'move', x: 1, y: 1 }), [{ t: 'move', x: '-1', y: '1239' }]);
  assert.deepEqual(lines({ t: 'button', b: 'right', down: true, x: 0.5, y: 0.5 }), [{ t: 'move', x: '-1280', y: '520' }, { t: 'button', b: 'right', down: 'true' }]);
  assert.deepEqual(lines({ t: 'button', b: 'left', down: false, x: -1, y: -1 }), [{ t: 'button', b: 'left', down: 'false' }], 'a release where the pointer is');
  assert.deepEqual(lines({ t: 'wheel', dx: 0, dy: -3, x: 0, y: 0 }), [{ t: 'move', x: '-2560', y: '-200' }, { t: 'wheel', dx: '0', dy: '-3' }]);
  assert.deepEqual(lines({ t: 'key', code: 'ArrowUp', down: true }), [{ t: 'key', vk: '38', ext: 'true', down: 'true' }]);
  assert.deepEqual(lines({ t: 'key', code: 'KeyQ', down: false }), [{ t: 'key', vk: '81', ext: 'false', down: 'false' }]);
  assert.deepEqual(helperCommands({ t: 'key', code: 'LaunchMail', down: true } as InputEvent, left), []);
  for (const l of helperCommands({ t: 'button', b: 'middle', down: true, x: 0.3, y: 0.7 }, left)) assert.doesNotThrow(() => JSON.parse(l));
  assert.deepEqual(parse('{"t":"pos"}'), { t: 'pos' });
});

test('xdotool commands on Linux', () => {
  const r: Rect = { x: 0, y: 0, width: 1280, height: 800 };
  assert.deepEqual(xdotoolCommands({ t: 'move', x: 0.5, y: 0.5 }, r), ['mousemove 640 400']);
  assert.deepEqual(xdotoolCommands({ t: 'button', b: 'left', down: true, x: 0, y: 1 }, r), ['mousemove 0 799', 'mousedown 1']);
  assert.deepEqual(xdotoolCommands({ t: 'button', b: 'right', down: false, x: -1, y: -1 }, r), ['mouseup 3']);
  assert.deepEqual(xdotoolCommands({ t: 'wheel', dx: -1, dy: 2, x: 0, y: 0 }, r), ['mousemove 0 0', 'click --repeat 2 5', 'click --repeat 1 6']);
  assert.deepEqual(xdotoolCommands({ t: 'key', code: 'Enter', down: true }, r), ['keydown Return']);
  assert.deepEqual(xdotoolCommands({ t: 'key', code: 'ShiftLeft', down: false }, r), ['keyup Shift_L']);
});

test('control: nothing reaches the input before consent; chords are blocked; taking it back releases held keys', async () => {
  const sent: Array<{ ev: InputEvent; rect: Rect }> = [];
  let stopped = 0;
  const sink: InputSink = { prepare: async () => {}, send: (ev, rect) => sent.push({ ev, rect }), stop: () => { stopped++; } };
  const logs: string[] = [];
  const rc = new RemoteControl(sink, (_l, msg, extra) => logs.push(`${msg}${extra?.chord ? ` ${extra.chord}` : ''}`));
  const msg = (...e: unknown[]) => ({ k: 'in', e });
  assert.equal(rc.input(msg({ t: 'move', x: 0.5, y: 0.5 })), 0, 'no consent, nothing');
  await assert.rejects(rc.grant(), /whole screen/);
  rc.setDisplay({ x: 0, y: 0, width: 1920, height: 1080 });
  await rc.grant();
  assert.equal(rc.input(msg({ t: 'move', x: 0.5, y: 0.5 }, { t: 'key', code: 'ControlLeft', down: true }, { t: 'key', code: 'AltLeft', down: true }, { t: 'key', code: 'Delete', down: true }, { t: 'exec', cmd: 'x' })), 3);
  assert.ok(logs.some((l) => l.includes('Ctrl+Alt+Del')));
  assert.deepEqual(sent.map((s) => s.ev.t), ['move', 'key', 'key']);
  sent.length = 0;
  rc.revoke('test');
  assert.deepEqual(sent.map((s) => (s.ev as { code: string }).code).sort(), ['AltLeft', 'ControlLeft'], 'held keys released');
  assert.equal(stopped, 1);
  assert.equal(rc.input(msg({ t: 'move', x: 0.1, y: 0.1 })), 0);
  // the shared screen going away also ends control
  await rc.grant();
  rc.setDisplay(null);
  assert.equal(rc.active, false);
});

test('control in a meeting: input is taken only from the device the presenter allowed', async () => {
  const sent: InputEvent[] = [];
  const sink: InputSink = { prepare: async () => {}, send: (ev) => sent.push(ev), stop: () => {} };
  const rc = new RemoteControl(sink, () => {});
  const msg = { k: 'in', e: [{ t: 'move', x: 0.5, y: 0.5 }] };
  rc.setDisplay({ x: 0, y: 0, width: 1280, height: 800 });
  await rc.grant('DEV-RAVI');
  assert.equal(rc.allowed, 'DEV-RAVI');
  assert.equal(rc.input(msg, Date.now(), 'DEV-VIKRAM'), 0, 'someone else in the meeting');
  assert.equal(rc.input(msg, Date.now(), null), 0, 'no sender');
  assert.equal(rc.input(msg, Date.now(), 'DEV-RAVI'), 1);
  // the same 120 events a second as in a support session
  let n = 0;
  const now = Date.now();
  for (let i = 0; i < 10; i++) n += rc.input({ k: 'in', e: Array.from({ length: 30 }, (_, j) => ({ t: 'move', x: (i * 30 + j) / 400, y: 0.5 })) }, now, 'DEV-RAVI');
  assert.equal(n, 119, 'the rate limit (one event was earlier)');
  rc.revoke('stop');
  assert.equal(rc.allowed, null);
  assert.equal(rc.input(msg, Date.now() + 2000, 'DEV-RAVI'), 0, 'nothing after Stop');
  // a support session: the window checks the technician, any device it passes on is taken
  await rc.grant();
  assert.equal(rc.input(msg, Date.now() + 3000, 'ANY'), 1);
  assert.equal(sent.length, 121);
});

test('diagnostics: ICE addresses, a STUN probe that gets an answer, and no secrets in the report', async () => {
  assert.deepEqual(parseIceUrl('turn:turn.example.net:3478?transport=tcp'), { scheme: 'turn', host: 'turn.example.net', port: 3478, transport: 'tcp' });
  assert.deepEqual(parseIceUrl('turns:relay.example.net'), { scheme: 'turns', host: 'relay.example.net', port: 5349, transport: 'tcp' });
  assert.deepEqual(parseIceUrl('stun:[::1]:19302'), { scheme: 'stun', host: '::1', port: 19302, transport: 'udp' });
  assert.equal(parseIceUrl('http://example.com'), null);
  const id = Buffer.alloc(12, 7);
  const req = stunRequest(id);
  assert.equal(req.length, 20);
  assert.equal(req.readUInt32BE(4), 0x2112a442);
  const answer = Buffer.from(req); answer.writeUInt16BE(0x0101, 0);
  assert.ok(isStunAnswer(answer, id));
  assert.ok(!isStunAnswer(req, id), 'a request is not an answer');
  // a tiny STUN server on this PC answers; a closed port does not
  const server = dgram.createSocket('udp4');
  server.on('message', (m, rinfo) => { const a = Buffer.from(m.subarray(0, 20)); a.writeUInt16BE(0x0101, 0); server.send(a, rinfo.port, rinfo.address); });
  await new Promise<void>((r) => server.bind(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const ok = await probeIce(`stun:127.0.0.1:${port}`);
  assert.equal(ok.reachable, true);
  assert.equal(typeof ok.ms, 'number');
  const closed = await probeIce('turn:127.0.0.1:9?transport=tcp', 800);
  assert.equal(closed.reachable, false);
  const log = new AppLog();
  log.warn('hub', 'request failed with token dxc_ABCDEFGHIJKLMNOP and code DXP1-AAAAAAAAAA');
  const report = await collectDiagnostics({
    app: { version: '0.1.0', channel: 'beta', platform: 'win32', arch: 'x64', electron: '45', chrome: '140', packaged: true, locale: 'en-IN' },
    displays: [{ id: '1', primary: true, x: 0, y: 0, width: 1920, height: 1080, scale: 1.25, rotation: 0, internal: false }],
    dataDir: process.cwd(), route: 'office network', hubAddress: '10.0.0.5:47900', gateway: null,
    ping: async () => {}, iceUrls: async () => [`stun:127.0.0.1:${port}`, 'turn:user:secret@bad'],
    log: log.recent(), rendererErrors: [{ at: 1, message: 'TypeError: x is undefined (Bearer abcdefghijklmnop1234)' }],
  });
  server.close();
  assert.equal(report.network.hub.reachable, true);
  assert.equal(report.network.hub.latencyMs.length, 3);
  assert.equal(report.network.turn[0].reachable, true);
  assert.equal(report.network.turn[1].reachable, false);
  assert.ok(report.memory.totalMb > 0 && report.cpu.cores > 0);
  assert.ok(report.disk.freeGb === null || report.disk.freeGb >= 0);
  const text = JSON.stringify(report);
  for (const secret of ['dxc_ABCDEFGHIJKLMNOP', 'DXP1-AAAAAAAAAA', 'abcdefghijklmnop1234', 'secret']) assert.ok(!text.includes(secret), secret);
  assert.equal(redact('see https://hub/files/1?t=SECRETVALUE&x=1'), 'see https://hub/files/1?t=[masked]&x=1');
});
