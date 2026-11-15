// Live streaming a webinar: where the hub looks for ffmpeg (a configured path, PATH, the usual
// Windows places), reading ffmpeg's progress for the stream's health, and a real stream: a WebM
// recording like the one the stage's PC sends, piped through ffmpeg to a local RTMP listener (an
// ffmpeg in listen mode), which must receive frames. The stream key never appears in a message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import type { StreamStatus } from '@dex/core';
import { LiveStream, RTMP_RE, STREAM_KEY_RE, ffmpegCandidates, findFfmpeg, parseProgress, streamTarget } from '../src/webinar-stream.ts';

test('ffmpeg is looked for in a configured path, then PATH, then where Windows installers put it', () => {
  const win = ffmpegCandidates('D:\\tools\\ffmpeg.exe', { PATH: 'C:\\Windows;C:\\bin', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\hub\\AppData\\Local', ProgramData: 'C:\\ProgramData', USERPROFILE: 'C:\\Users\\hub' }, 'win32');
  assert.equal(win[0], 'D:\\tools\\ffmpeg.exe');
  for (const p of ['C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Users\\hub\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe', 'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe', 'C:\\Users\\hub\\scoop\\shims\\ffmpeg.exe']) assert.ok(win.includes(p), p);
  const nix = ffmpegCandidates(null, { PATH: '/usr/local/bin:/usr/bin', DEX_FFMPEG: '/opt/ff/ffmpeg' }, 'linux');
  assert.deepEqual(nix.slice(0, 3), ['/opt/ff/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']);
});

test('stream addresses and keys, and ffmpeg\'s progress lines as health', () => {
  assert.ok(RTMP_RE.test('rtmp://a.rtmp.youtube.com/live2'));
  assert.ok(RTMP_RE.test('rtmps://live-api-s.facebook.com:443/rtmp/'));
  assert.ok(!RTMP_RE.test('http://a.rtmp.youtube.com/live2'));
  assert.ok(!RTMP_RE.test('rtmp://host/live2 -f null'));
  assert.ok(STREAM_KEY_RE.test('abcd-efgh-ijkl-mnop-qrst'));
  assert.ok(!STREAM_KEY_RE.test('abc def'));
  assert.equal(streamTarget('rtmp://a.rtmp.youtube.com/live2/', 'k-1'), 'rtmp://a.rtmp.youtube.com/live2/k-1');
  const p = parseProgress('frame=152\nfps=29.97\nstream_0_0_q=23.0\nbitrate=2481.6kbits/s\ntotal_size=1572864\nout_time_us=5066667\ndup_frames=0\ndrop_frames=3\nspeed=1.01x\nprogress=continue\n');
  assert.deepEqual(p, { frames: 152, fps: 29.97, bitrate: 2481.6, dropped: 3, speed: 1.01, seconds: 5 });
  assert.equal(parseProgress('bitrate=N/A\nprogress=end\n').bitrate, null);
  assert.equal(parseProgress('progress=end\n').end, true);
});

/** A WebM recording like the stage's (VP8 and Opus), made by ffmpeg from a test pattern and a tone. */
const stageRecording = (bin: string) => new Promise<Buffer>((resolve, reject) => {
  execFile(bin, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4',
    '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '800k', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30_000 }, (err, out) => (err ? reject(err) : resolve(out)));
});

const free = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); const port = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return port; };

test('a stream reaches a local RTMP listener: frames arrive, health is reported, the key stays hidden', async (t) => {
  const ff = await findFfmpeg(null);
  if (!ff) { t.skip('ffmpeg is not installed on this machine'); return; }
  // the stage's recording: WebM with VP8 and Opus, as Chromium's MediaRecorder makes it
  const webm = await stageRecording(ff.path);
  assert.ok(webm.length > 50_000);
  // the sink: ffmpeg listening for RTMP, writing nothing, counting frames
  const port = await free();
  const key = 'secret-stream-key-1234';
  const sink = spawn(ff.path, ['-hide_banner', '-listen', '1', '-i', `rtmp://127.0.0.1:${port}/live/${key}`, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let sinkLog = '';
  sink.stderr!.on('data', (b: Buffer) => { sinkLog += b.toString(); });
  t.after(() => { try { sink.kill('SIGKILL'); } catch { /* gone */ } });
  // it takes one connection (a probe would use it up): give it a moment to listen
  await new Promise((r) => setTimeout(r, 1500));
  const seen: StreamStatus[] = [];
  const stream = new LiveStream(ff, streamTarget(`rtmp://127.0.0.1:${port}/live`, key), key, (s) => seen.push(s), 1200);
  const PIECE = 48 * 1024;
  // the listener may take a moment to be ready on a busy machine: start again while it refuses
  let started = false;
  for (let attempt = 0; attempt < 8 && !started; attempt++) {
    seen.length = 0;
    stream.start();
    stream.write(webm.subarray(0, PIECE * 4));
    const until = Date.now() + 4000;
    while (Date.now() < until && !seen.some((s) => s.state === 'failed' || s.frames > 0)) await new Promise((r) => setTimeout(r, 50));
    started = !seen.some((s) => s.state === 'failed');
    if (!started) await new Promise((r) => setTimeout(r, 700));
  }
  assert.ok(started, `ffmpeg reached the listener (${JSON.stringify(seen.at(-1))}; listener: ${sinkLog.slice(-300)})`);
  // the stage sends one-second pieces
  for (let off = PIECE * 4; off < webm.length; off += PIECE) {
    assert.ok(stream.write(webm.subarray(off, off + PIECE)), `ffmpeg took the stage's video (${JSON.stringify(seen.at(-1))})`);
    await new Promise((r) => setTimeout(r, 30));
  }
  const end = Date.now() + 20_000;
  while (!seen.some((s) => s.state === 'live' && s.frames > 30) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  const live = seen.find((s) => s.state === 'live' && s.frames > 30);
  assert.ok(live, `the stream went live (${seen.map((s) => s.state).join(', ')})`);
  assert.ok(live!.ffmpeg && /libx264|openh264|h264/.test(live!.ffmpeg));
  stream.stop();
  // the listener received video: its own progress counts frames
  await new Promise<void>((r) => { sink.once('exit', () => r()); setTimeout(r, 8000); });
  const frames = Math.max(0, ...[...sinkLog.matchAll(/frame=\s*(\d+)/g)].map((m) => Number(m[1])));
  assert.ok(frames >= 60, `the RTMP listener got ${frames} frames`);
  assert.match(sinkLog, /Video: h264/);
  assert.match(sinkLog, /Audio: aac/);
  assert.equal(seen[seen.length - 1].state, 'stopped');
  assert.ok(!JSON.stringify(seen).includes(key), 'the key is never in a status');
});

test('a stream to an address nobody listens on fails with a message, without the key', async (t) => {
  const ff = await findFfmpeg(null);
  if (!ff) { t.skip('ffmpeg is not installed on this machine'); return; }
  const port = await free();
  const key = 'another-secret-key';
  const seen: StreamStatus[] = [];
  const stream = new LiveStream(ff, streamTarget(`rtmp://127.0.0.1:${port}/live`, key), key, (s) => seen.push(s));
  stream.start();
  stream.write(await stageRecording(ff.path));
  const end = Date.now() + 15_000;
  while (!seen.some((s) => s.state === 'failed') && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  const failed = seen.find((s) => s.state === 'failed');
  assert.ok(failed, 'it fails');
  assert.ok(failed!.message);
  assert.ok(!JSON.stringify(seen).includes(key));
  stream.stop();
});
