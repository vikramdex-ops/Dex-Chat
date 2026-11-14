// Remote control on Windows: a small long-lived helper. PowerShell (built into Windows) compiles
// the C# class below with Add-Type and runs it; it reads one JSON command per line on stdin and
// moves the pointer with SetCursorPos, presses buttons and keys and turns the wheel with SendInput.
// It declares itself per-monitor DPI aware, so coordinates are physical pixels on the virtual
// screen (every monitor, which may start left of or above the primary). No native Node modules,
// no third-party programs, nothing written to disk: the script travels as -EncodedCommand.
// This file has no Electron imports so CI can run the helper on its own (scripts/assist-helper-smoke.ts).
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { KEYS, toScreen } from '@dex/core/assist';
import type { InputEvent, Rect } from '@dex/core/assist';

/**
 * The helper's C# source. Written for the C# 5 compiler that Windows PowerShell 5.1's Add-Type uses
 * (no string interpolation, no expression-bodied members, no "?.").
 */
export function helperSource(): string {
  return String.raw`using System;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Collections.Generic;
using System.Globalization;

namespace DexAssist {
  public static class Helper {
    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion {
      [FieldOffset(0)] public MOUSEINPUT mi;
      [FieldOffset(0)] public KEYBDINPUT ki;
      [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion U; }

    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    const uint INPUT_MOUSE = 0;
    const uint INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800;
    const uint MOUSEEVENTF_HWHEEL = 0x1000;
    const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const int SM_XVIRTUALSCREEN = 76;
    const int SM_YVIRTUALSCREEN = 77;
    const int SM_CXVIRTUALSCREEN = 78;
    const int SM_CYVIRTUALSCREEN = 79;
    static readonly IntPtr PER_MONITOR_AWARE_V2 = new IntPtr(-4);

    static readonly Regex Field = new Regex("\"(\\w+)\"\\s*:\\s*(\"([^\"\\\\]*)\"|-?\\d+(?:\\.\\d+)?|true|false)", RegexOptions.Compiled);

    static Dictionary<string, string> Parse(string line) {
      Dictionary<string, string> d = new Dictionary<string, string>();
      foreach (Match m in Field.Matches(line)) {
        d[m.Groups[1].Value] = m.Groups[3].Success ? m.Groups[3].Value : m.Groups[2].Value;
      }
      return d;
    }

    static int Int(Dictionary<string, string> d, string key) {
      string v;
      if (!d.TryGetValue(key, out v)) return 0;
      double n;
      if (!double.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out n)) return 0;
      return (int)Math.Round(n);
    }

    static bool Flag(Dictionary<string, string> d, string key) {
      string v;
      return d.TryGetValue(key, out v) && v == "true";
    }

    static void Mouse(int dx, int dy, uint data, uint flags) {
      INPUT[] input = new INPUT[1];
      input[0].type = INPUT_MOUSE;
      input[0].U.mi.dx = dx;
      input[0].U.mi.dy = dy;
      input[0].U.mi.mouseData = data;
      input[0].U.mi.dwFlags = flags;
      if (SendInput(1, input, Marshal.SizeOf(typeof(INPUT))) != 1) Error("SendInput (mouse) failed: " + Marshal.GetLastWin32Error());
    }

    static void Key(ushort vk, bool extended, bool down) {
      INPUT[] input = new INPUT[1];
      input[0].type = INPUT_KEYBOARD;
      input[0].U.ki.wVk = vk;
      input[0].U.ki.wScan = (ushort)MapVirtualKey(vk, 0);
      input[0].U.ki.dwFlags = (extended ? KEYEVENTF_EXTENDEDKEY : 0) | (down ? 0 : KEYEVENTF_KEYUP);
      if (SendInput(1, input, Marshal.SizeOf(typeof(INPUT))) != 1) Error("SendInput (key) failed: " + Marshal.GetLastWin32Error());
    }

    static void Move(int x, int y) {
      int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
      int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
      int vw = Math.Max(2, GetSystemMetrics(SM_CXVIRTUALSCREEN));
      int vh = Math.Max(2, GetSystemMetrics(SM_CYVIRTUALSCREEN));
      x = Math.Max(vx, Math.Min(vx + vw - 1, x));
      y = Math.Max(vy, Math.Min(vy + vh - 1, y));
      int nx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1));
      int ny = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));
      Mouse(nx, ny, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK);
      // the absolute move rounds to 1/65535 of the desk: land on the exact pixel
      if (!SetCursorPos(x, y)) Error("SetCursorPos failed: " + Marshal.GetLastWin32Error());
    }

    static void Button(string b, bool down) {
      uint f = b == "right" ? (down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP)
        : b == "middle" ? (down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP)
        : (down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP);
      Mouse(0, 0, 0, f);
    }

    static void Out(string json) { Console.Out.WriteLine(json); Console.Out.Flush(); }
    static void Error(string msg) { Out("{\"t\":\"error\",\"msg\":\"" + msg.Replace("\\", "/").Replace("\"", "'") + "\"}"); }

    public static void Run() {
      string dpi = "none";
      try {
        if (SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)) dpi = "per-monitor-v2";
        else if (Marshal.GetLastWin32Error() == 5) dpi = "already-set";
        else if (SetProcessDPIAware()) dpi = "system";
      } catch (EntryPointNotFoundException) {
        if (SetProcessDPIAware()) dpi = "system";
      }
      Out("{\"t\":\"ready\",\"dpi\":\"" + dpi + "\"}");
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        Dictionary<string, string> c = Parse(line);
        string t;
        if (!c.TryGetValue("t", out t)) continue;
        try {
          if (t == "move") Move(Int(c, "x"), Int(c, "y"));
          else if (t == "button") Button(c.ContainsKey("b") ? c["b"] : "left", Flag(c, "down"));
          else if (t == "wheel") {
            int dy = Int(c, "dy");
            int dx = Int(c, "dx");
            if (dy != 0) Mouse(0, 0, unchecked((uint)(-dy * 120)), MOUSEEVENTF_WHEEL);
            if (dx != 0) Mouse(0, 0, unchecked((uint)(dx * 120)), MOUSEEVENTF_HWHEEL);
          }
          else if (t == "key") Key((ushort)Int(c, "vk"), Flag(c, "ext"), Flag(c, "down"));
          else if (t == "pos") {
            POINT p;
            if (GetCursorPos(out p)) Out("{\"t\":\"pos\",\"x\":" + p.X + ",\"y\":" + p.Y + "}");
            else Error("GetCursorPos failed: " + Marshal.GetLastWin32Error());
          }
          else if (t == "screen") {
            Out("{\"t\":\"screen\",\"x\":" + GetSystemMetrics(SM_XVIRTUALSCREEN) + ",\"y\":" + GetSystemMetrics(SM_YVIRTUALSCREEN)
              + ",\"width\":" + GetSystemMetrics(SM_CXVIRTUALSCREEN) + ",\"height\":" + GetSystemMetrics(SM_CYVIRTUALSCREEN) + "}");
          }
          else if (t == "quit") return;
        } catch (Exception e) {
          Error(e.GetType().Name + ": " + e.Message);
        }
      }
    }
  }
}
`;
}

/** The PowerShell that compiles and runs the helper. */
export function helperScript(source = helperSource()): string {
  if (/^'@/m.test(source)) throw new Error('The helper source cannot hold a here-string terminator.');
  return [
    // commands and replies are plain ASCII JSON, so the console's code page does not matter
    "$ErrorActionPreference = 'Stop'",
    "if (-not ('DexAssist.Helper' -as [type])) {",
    "Add-Type -Language CSharp -TypeDefinition @'",
    source,
    "'@",
    '}',
    '[DexAssist.Helper]::Run()',
  ].join('\n');
}

/** -EncodedCommand takes the script as base64 of its UTF-16LE text (and is not subject to the script execution policy). */
export function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** powershell.exe of this Windows (always present on Windows 10 and 11). */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Arguments for powershell.exe; the command line stays under Windows' 32,767-character limit. */
export function helperArgs(script = helperScript()): string[] {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)];
  if (args.join(' ').length > 32_000) throw new Error('The helper script is too long for a command line.');
  return args;
}

/**
 * The helper's commands for one input event, for a shared display at `rect` (physical pixels on
 * the virtual screen). A pointer event moves first, then acts; a release with no position (-1)
 * acts where the pointer is.
 */
export function helperCommands(ev: InputEvent, rect: Rect): string[] {
  const at = (x: number, y: number) => (x < 0 || y < 0 ? null : toScreen(x, y, rect));
  const move = (p: { x: number; y: number } | null) => (p ? [JSON.stringify({ t: 'move', x: p.x, y: p.y })] : []);
  switch (ev.t) {
    case 'move': return move(at(ev.x, ev.y));
    case 'button': return [...move(at(ev.x, ev.y)), JSON.stringify({ t: 'button', b: ev.b, down: ev.down })];
    case 'wheel': return [...move(at(ev.x, ev.y)), JSON.stringify({ t: 'wheel', dx: ev.dx, dy: ev.dy })];
    case 'key': {
      const k = KEYS[ev.code];
      return k ? [JSON.stringify({ t: 'key', vk: k.vk, ext: !!k.ext, down: ev.down })] : [];
    }
  }
}

type Reply = { t: string; [k: string]: unknown };

/** The running helper: start it, send it commands, ask it where the pointer is. */
export class WindowsHelper {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<Reply> | null = null;
  private waiting: Array<{ t: string; resolve: (r: Reply) => void }> = [];
  private buf = '';
  onError: (msg: string) => void = () => {};
  private readonly exe: string;

  constructor(exe = powershellPath()) { this.exe = exe; }

  /** Start the helper (compiling it takes a second or two the first time). Resolves with its ready line. */
  start(timeoutMs = 30_000): Promise<Reply> {
    if (this.ready) return this.ready;
    const p = spawn(this.exe, helperArgs(), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    let err = '';
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d: string) => { err = (err + d).slice(-2000); });
    p.stdout.on('data', (d: string) => this.onData(d));
    this.ready = new Promise<Reply>((resolve, reject) => {
      const t = setTimeout(() => { reject(new Error('The input helper did not start in time.')); this.stop(); }, timeoutMs);
      this.waiting.push({ t: 'ready', resolve: (r) => { clearTimeout(t); resolve(r); } });
      p.on('error', (e) => { clearTimeout(t); reject(e); });
      p.on('exit', (code) => {
        clearTimeout(t);
        this.proc = null;
        this.ready = null;
        reject(new Error(`The input helper stopped (${code ?? 'signal'}). ${err.trim().split('\n').slice(-3).join(' ')}`.trim()));
        for (const w of this.waiting.splice(0)) w.resolve({ t: 'error', msg: 'stopped' });
      });
    });
    return this.ready;
  }

  private onData(d: string): void {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let r: Reply;
      try { r = JSON.parse(line) as Reply; } catch { continue; }
      if (r.t === 'error') this.onError(String(r.msg ?? 'error'));
      const at = this.waiting.findIndex((w) => w.t === r.t);
      if (at >= 0) this.waiting.splice(at, 1)[0].resolve(r);
    }
    if (this.buf.length > 64 * 1024) this.buf = '';
  }

  send(lines: string[]): void {
    if (!this.proc || !lines.length) return;
    this.proc.stdin.write(`${lines.join('\n')}\n`);
  }

  private ask(t: 'pos' | 'screen', timeoutMs = 3000): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No answer to ${t}.`)), timeoutMs);
      this.waiting.push({ t, resolve: (r) => { clearTimeout(timer); resolve(r); } });
      this.send([JSON.stringify({ t })]);
    });
  }

  async position(): Promise<{ x: number; y: number }> {
    const r = await this.ask('pos');
    return { x: Number(r.x), y: Number(r.y) };
  }

  async virtualScreen(): Promise<Rect> {
    const r = await this.ask('screen');
    return { x: Number(r.x), y: Number(r.y), width: Number(r.width), height: Number(r.height) };
  }

  stop(): void {
    const p = this.proc;
    this.proc = null;
    this.ready = null;
    if (!p) return;
    try { p.stdin.write('{"t":"quit"}\n'); p.stdin.end(); } catch { /* already gone */ }
    setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 1500).unref();
  }
}
