// Live streaming a webinar (YouTube and any service that takes RTMP): the PC composing the stage
// records it (WebM, VP8/Opus) in one-second pieces and sends them over its hub connection; the
// hub pipes them into ffmpeg, which encodes H.264 and AAC and sends FLV to the address and key
// the organiser entered. ffmpeg is not bundled: the office installs it on the hub PC (a path in
// the Control room or DEX_FFMPEG, else it is found on PATH or in the usual Windows places).
// ffmpeg's progress lines give the health shown to the organiser: bitrate, frames per second,
// dropped frames and the encoder's state. The stream key never appears in a message or a log.
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { StreamStatus } from '@dex/core';

export interface FfmpegInfo { path: string; version: string; h264: string; aac: boolean }

/** Where ffmpeg may be on a hub PC, besides a configured path. */
export function ffmpegCandidates(configured: string | null, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const exe = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const out: string[] = [];
  if (configured) out.push(configured);
  if (env.DEX_FFMPEG) out.push(env.DEX_FFMPEG);
  for (const dir of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':')) if (dir.trim()) out.push((platform === 'win32' ? path.win32 : path.posix).join(dir.trim(), exe));
  if (platform === 'win32') {
    const pf = env.ProgramFiles ?? 'C:\\Program Files';
    out.push(
      path.win32.join(pf, 'ffmpeg', 'bin', exe),
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      ...(env.LOCALAPPDATA ? [path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exe)] : []),
      ...(env.ProgramData ? [path.win32.join(env.ProgramData, 'chocolatey', 'bin', exe)] : []),
      ...(env.USERPROFILE ? [path.win32.join(env.USERPROFILE, 'scoop', 'shims', exe)] : []),
    );
  } else out.push('/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg');
  return [...new Set(out)];
}

const run = (bin: string, args: string[]) => new Promise<string>((resolve, reject) => {
  execFile(bin, args, { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(err) : resolve(`${stdout}${stderr}`)));
});

let cached: { at: number; key: string; info: FfmpegInfo | null } | null = null;

/** The first ffmpeg that runs and can encode H.264 and AAC (checked once a minute at most). */
export async function findFfmpeg(configured: string | null): Promise<FfmpegInfo | null> {
  const key = `${configured ?? ''}|${process.env.DEX_FFMPEG ?? ''}`;
  if (cached && cached.key === key && Date.now() - cached.at < 60_000) return cached.info;
  let info: FfmpegInfo | null = null;
  for (const bin of ffmpegCandidates(configured)) {
    try { if (!fs.statSync(bin).isFile()) continue; } catch { continue; }
    try {
      const version = (await run(bin, ['-hide_banner', '-version'])).split('\n')[0].replace(/^ffmpeg version\s*/, '').split(' ')[0].slice(0, 40);
      const encoders = await run(bin, ['-hide_banner', '-encoders']);
      const h264 = ['libx264', 'libopenh264', 'h264_mf'].find((e) => new RegExp(`\\s${e}\\s`).test(encoders));
      if (!h264) continue;
      info = { path: bin, version, h264, aac: /\saac\s/.test(encoders) };
      break;
    } catch { /* not runnable: try the next */ }
  }
  cached = { at: Date.now(), key, info };
  return info;
}
export function forgetFfmpeg(): void { cached = null; }

/** rtmp://host[:port]/app[/…] or rtmps://… */
export const RTMP_RE = /^rtmps?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~%!$&'()*+,;=:@-]+)+\/?$/;
export const STREAM_KEY_RE = /^[A-Za-z0-9._~%!$&'()*+,;=:@/-]{1,300}$/;

/** The address ffmpeg sends to: the service's address and the key. */
export function streamTarget(url: string, key: string): string {
  return key ? `${url.replace(/\/+$/, '')}/${key.replace(/^\/+/, '')}` : url;
}

export const OFF_STATUS: StreamStatus = { state: 'off', bitrate: null, fps: null, dropped: 0, frames: 0, speed: null, seconds: 0, message: null, ffmpeg: null, since: null };

/** ffmpeg's -progress output: key=value lines, a block ending with progress=continue or end. */
export function parseProgress(block: string): Partial<StreamStatus> & { end?: boolean } {
  const kv = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) { const i = line.indexOf('='); if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim()); }
  const num = (k: string) => { const v = Number.parseFloat(kv.get(k) ?? ''); return Number.isFinite(v) ? v : null; };
  const out: Partial<StreamStatus> & { end?: boolean } = {};
  if (kv.has('frame')) out.frames = Math.max(0, Math.round(num('frame') ?? 0));
  if (kv.has('fps')) out.fps = num('fps');
  const br = kv.get('bitrate');
  if (br !== undefined) out.bitrate = /kbits\/s/.test(br) ? num('bitrate') : null;
  if (kv.has('drop_frames')) out.dropped = Math.max(0, Math.round(num('drop_frames') ?? 0));
  const sp = kv.get('speed');
  if (sp !== undefined) { const v = Number.parseFloat(sp); out.speed = Number.isFinite(v) ? v : null; }
  const us = num('out_time_us') ?? num('out_time_ms');
  if (us !== null) out.seconds = Math.max(0, Math.round(us / 1e6));
  if (kv.get('progress') === 'end') out.end = true;
  return out;
}

/**
 * One live stream: ffmpeg reading WebM pieces on its input and sending FLV to the service. A new
 * recording from the stage (seq 0: the PC composing the stage changed, or started again) starts
 * ffmpeg afresh, since a WebM stream cannot continue another.
 */
export class LiveStream {
  private proc: ChildProcess | null = null;
  private st: StreamStatus;
  private lastProgress = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private errors: string[] = [];
  private lastSent = 0;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly ffmpeg: FfmpegInfo;
  private readonly target: string;
  /** Words that must never be shown (the key). */
  private readonly secret: string;
  private readonly onStatus: (s: StreamStatus) => void;
  private readonly videoKbps: number;

  constructor(ffmpeg: FfmpegInfo, target: string, secret: string, onStatus: (s: StreamStatus) => void, videoKbps = 2500) {
    this.ffmpeg = ffmpeg;
    this.target = target;
    this.secret = secret;
    this.onStatus = onStatus;
    this.videoKbps = videoKbps;
    this.st = { ...OFF_STATUS, state: 'starting', ffmpeg: `${ffmpeg.version} (${ffmpeg.h264})`, since: Date.now() };
  }

  get status(): StreamStatus { return { ...this.st }; }
  get running(): boolean { return !!this.proc; }

  private redact(s: string): string {
    let out = s.replace(/\s+/g, ' ').trim();
    if (this.secret) out = out.split(this.secret).join('••••');
    return out.replace(/(rtmps?:\/\/[^\s/]+\/[^\s/]+\/)[^\s]+/g, '$1••••').slice(0, 200);
  }

  private set(p: Partial<StreamStatus>, now = false): void {
    this.st = { ...this.st, ...p };
    // at most one status a second, except a change of state
    const due = now || Date.now() - this.lastSent >= 1000;
    if (due) { this.lastSent = Date.now(); if (this.sendTimer) { clearTimeout(this.sendTimer); this.sendTimer = null; } this.onStatus(this.status); }
    else if (!this.sendTimer) this.sendTimer = setTimeout(() => { this.sendTimer = null; this.lastSent = Date.now(); this.onStatus(this.status); }, 1000 - (Date.now() - this.lastSent));
  }

  /** Start ffmpeg (again: a fresh WebM stream from the stage). */
  start(): void {
    this.kill();
    this.stopping = false;
    this.errors = [];
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
      '-fflags', '+genpts', '-thread_queue_size', '512', '-f', 'webm', '-i', 'pipe:0',
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', this.ffmpeg.h264, ...(this.ffmpeg.h264 === 'libx264' ? ['-preset', 'veryfast', '-tune', 'zerolatency'] : []),
      '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60', '-keyint_min', '60',
      '-b:v', `${this.videoKbps}k`, '-maxrate', `${this.videoKbps}k`, '-bufsize', `${this.videoKbps * 2}k`,
      ...(this.ffmpeg.aac ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2'] : ['-an']),
      '-f', 'flv', '-flvflags', 'no_duration_filesize', this.target,
    ];
    const p = spawn(this.ffmpeg.path, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = p;
    this.lastProgress = Date.now();
    this.set({ state: 'starting', message: null, since: this.st.since ?? Date.now() }, true);
    let buf = '';
    p.stdout!.setEncoding('utf8');
    p.stdout!.on('data', (chunk: string) => {
      // progress still arriving from a stopped (or replaced) ffmpeg never turns the status back to live
      if (this.proc !== p) return;
      buf += chunk;
      let i: number;
      while ((i = buf.search(/progress=(continue|end)\r?\n/)) >= 0) {
        const end = buf.indexOf('\n', i) + 1;
        const block = buf.slice(0, end);
        buf = buf.slice(end);
        const pr = parseProgress(block);
        this.lastProgress = Date.now();
        const { end: ended, ...rest } = pr;
        const live = (rest.frames ?? this.st.frames) > 0;
        if (!ended) this.set({ ...rest, state: live ? 'live' : 'starting' }, live && this.st.state !== 'live');
      }
      if (buf.length > 64 * 1024) buf = '';
    });
    p.stderr!.setEncoding('utf8');
    p.stderr!.on('data', (s: string) => { for (const line of s.split(/\r?\n/)) if (line.trim()) this.errors.push(this.redact(line)); this.errors = this.errors.slice(-4); });
    p.stdin!.on('error', () => { /* ffmpeg went away: its exit says why */ });
    p.on('error', (err) => { if (this.proc === p) { this.proc = null; this.set({ state: 'failed', message: this.redact(err.message) }, true); } });
    p.on('exit', (code) => {
      if (this.proc !== p) return;
      this.proc = null;
      if (this.stopping) this.set({ state: 'stopped', bitrate: null, fps: null, speed: null }, true);
      else this.set({ state: 'failed', bitrate: null, fps: null, speed: null, message: this.errors[this.errors.length - 1] ?? `ffmpeg stopped (code ${code ?? 'none'}).` }, true);
    });
    if (!this.watchdog) {
      this.watchdog = setInterval(() => {
        if (this.proc && this.st.state === 'live' && Date.now() - this.lastProgress > 8000) this.set({ state: 'stalled', message: 'No video for 8 seconds: is the PC composing the stage still sending?' }, true);
        else if (this.proc && this.st.state === 'starting' && Date.now() - this.lastProgress > 15000) this.set({ state: 'stalled', message: 'Waiting for the stage\'s video: the PC composing the stage has not sent any yet.' }, true);
      }, 2000);
      this.watchdog.unref?.();
    }
  }

  /** A piece of the WebM recording. Returns false when ffmpeg is not taking input. */
  write(data: Buffer): boolean {
    const p = this.proc;
    if (!p || !p.stdin || p.stdin.destroyed) return false;
    // a stream that cannot keep up (the network to the service) is restarted rather than buffered without end
    if (p.stdin.writableLength > 32 * 1024 * 1024) { this.set({ state: 'stalled', message: 'The streaming service is not taking the video fast enough.' }, true); return false; }
    p.stdin.write(data);
    if (this.st.state === 'stalled') this.lastProgress = Date.now();
    return true;
  }

  private kill(): void {
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    try { p.stdin?.end(); } catch { /* closed */ }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
    t.unref?.();
    p.once('exit', () => clearTimeout(t));
    try { p.kill('SIGTERM'); } catch { /* gone */ }
  }

  stop(): void {
    this.stopping = true;
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    if (this.sendTimer) { clearTimeout(this.sendTimer); this.sendTimer = null; }
    this.kill();
    this.st = { ...this.st, state: 'stopped', bitrate: null, fps: null, speed: null };
    this.onStatus(this.status);
  }
}
