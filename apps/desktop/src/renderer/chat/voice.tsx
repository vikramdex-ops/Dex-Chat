// Voice notes: hold a short recording in the Dock and send it as an audio file; audio in
// messages plays inline with a waveform-style progress bar.
import { useEffect, useRef, useState } from 'react';
import type { FileInfo } from '@dex/core';
import { Icon, useToast } from '../ui.tsx';
import { useFileSrc } from './files.tsx';
import { sendMessage } from './store.ts';

const MAX_MS = 15 * 60_000;
/** "12s" or "1m05s": file names cannot contain a colon on Windows. */
const tag = (ms: number) => { const s = Math.max(1, Math.round(ms / 1000)); return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
const mmss = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function voiceSupported(): boolean {
  return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof window.dex.uploadFile === 'function';
}

export function VoiceRecorder({ convId, parentId, onActive }: { convId: string; parentId: string | null; onActive: (on: boolean) => void }) {
  const toast = useToast();
  const [rec, setRec] = useState<{ started: number; levels: number[] } | null>(null);
  const [now, setNow] = useState(Date.now());
  const media = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; cancel: boolean; ctx: AudioContext | null; started: number } | null>(null);

  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - rec.started > MAX_MS) stop(false);
    }, 100);
    return () => clearInterval(t);
  });
  useEffect(() => () => { media.current?.stream.getTracks().forEach((t) => t.stop()); void media.current?.ctx?.close(); }, []);

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      let ctx: AudioContext | null = null;
      const levels: number[] = [];
      try {
        ctx = new AudioContext();
        const an = ctx.createAnalyser();
        an.fftSize = 256;
        ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Uint8Array(an.fftSize);
        const sample = () => {
          if (!media.current || media.current.recorder.state !== 'recording') return;
          an.getByteTimeDomainData(buf);
          let peak = 0;
          for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
          levels.push(peak / 128);
          if (levels.length > 48) levels.shift();
          setRec((r) => (r ? { ...r, levels: [...levels] } : r));
          setTimeout(sample, 90);
        };
        setTimeout(sample, 90);
      } catch { /* level meter is optional */ }
      const started = Date.now();
      media.current = { recorder, stream, chunks, cancel: false, ctx, started };
      recorder.onstop = () => void finish();
      recorder.start(250);
      setRec({ started, levels: [] });
      onActive(true);
    } catch (e) {
      toast((e as Error).name === 'NotAllowedError' ? 'Microphone access was blocked.' : 'No microphone was found.', true);
    }
  };

  const stop = (cancel: boolean) => {
    const m = media.current;
    if (!m || m.recorder.state === 'inactive') return;
    m.cancel = cancel;
    m.recorder.stop();
  };

  const finish = async () => {
    const m = media.current;
    media.current = null;
    setRec(null);
    onActive(false);
    if (!m) return;
    m.stream.getTracks().forEach((t) => t.stop());
    void m.ctx?.close();
    const ms = Date.now() - m.started;
    if (m.cancel) return;
    if (ms < 700) { toast('Hold on a little longer to record a voice note'); return; }
    const blob = new Blob(m.chunks, { type: 'audio/webm' });
    try {
      const info = await window.dex.uploadFile!(`voice-${Date.now().toString(36)}`, { data: await blob.arrayBuffer(), name: `Voice note ${tag(ms)}.webm`, mime: 'audio/webm' });
      await sendMessage(convId, '', parentId, [info]);
    } catch (e) { toast((e as Error).message, true); }
  };

  if (!voiceSupported()) return null;
  if (!rec) return <button className="icon-btn" title="Record a voice note" onClick={() => void start()}><Icon name="mic" size={18} /></button>;
  return (
    <div className="voice-rec" role="status">
      <span className="rec-dot" />
      <span className="mono">{mmss(now - rec.started)}</span>
      <span className="rec-wave">{Array.from({ length: 48 }, (_, i) => <i key={i} style={{ height: `${Math.max(8, (rec.levels[i - (48 - rec.levels.length)] ?? 0) * 100)}%` }} />)}</span>
      <button className="btn ghost sm" onClick={() => stop(true)}>Cancel</button>
      <button className="btn primary sm" onClick={() => stop(false)}><Icon name="send" size={14} />Send</button>
    </div>
  );
}

export function VoicePlayer({ f }: { f: FileInfo }) {
  const audio = useRef<HTMLAudioElement>(null);
  const src = useFileSrc(f);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [rate, setRate] = useState(1);
  const [dur, setDur] = useState(() => { const m = f.name.match(/(?:(\d+)m)?(\d+)s\.\w+$/); return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : 0; });
  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) void a.play(); else a.pause();
  };
  const bars = 36;
  const seed = [...f.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);
  const heights = Array.from({ length: bars }, (_, i) => 30 + (((seed >> (i % 24)) ^ (i * 2654435761)) >>> 0) % 70);
  const progress = dur ? pos / dur : 0;
  return (
    <div className={`voice-note${playing ? ' playing' : ''}`}>
      <button className="voice-play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play voice note'}><Icon name={playing ? 'pause' : 'play'} size={16} /></button>
      <span className="voice-bars" onClick={(e) => {
        const a = audio.current;
        if (!a || !dur) return;
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        a.currentTime = ((e.clientX - r.left) / r.width) * dur;
      }}>
        {heights.map((h, i) => <i key={i} className={i / bars < progress ? 'on' : ''} style={{ height: `${h}%` }} />)}
      </span>
      <span className="mono voice-time">{mmss((playing || pos ? pos : dur) * 1000)}</span>
      <button className="voice-rate" title="Playback speed" onClick={() => { const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1; setRate(next); if (audio.current) audio.current.playbackRate = next; }}>{rate}×</button>
      <audio ref={audio} src={src} preload="none"
        onPlay={(e) => { e.currentTarget.playbackRate = rate; setPlaying(true); }} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setPos(0); }}
        onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => { if (Number.isFinite(e.currentTarget.duration)) setDur(e.currentTarget.duration); }} />
    </div>
  );
}
