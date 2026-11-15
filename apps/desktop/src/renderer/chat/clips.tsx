// Video messages and screen recordings: record in a dialog, watch it back, then send it as a
// video file that plays inline in the conversation.
import { useEffect, useRef, useState } from 'react';
import type { FileInfo } from '@dex/core';
import { Dialog, Icon, confirmAction, useToast } from '../ui.tsx';
import { ScreenPicker } from '../rooms/RoomUi.tsx';
import { sendMessage } from './store.ts';
import { useFileSrc } from './files.tsx';
import { policyNow } from '../policy.ts';

const MAX_MS = 15 * 60_000;
const tag = (ms: number) => { const s = Math.max(1, Math.round(ms / 1000)); return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
const mmss = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export const clipsSupported = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof window.dex.uploadFile === 'function';
export const screenClipsSupported = () => clipsSupported() && !!window.dex.listScreens && !!navigator.mediaDevices?.getDisplayMedia;

type Phase = 'pick' | 'ready' | 'recording' | 'review';

export function ClipRecorder({ mode, convId, parentId, onClose }: { mode: 'camera' | 'screen'; convId: string; parentId: string | null; onClose: () => void }) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>(mode === 'screen' ? 'pick' : 'ready');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [withMic, setWithMic] = useState(true);
  const [started, setStarted] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [clip, setClip] = useState<{ blob: Blob; url: string; ms: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef<HTMLVideoElement>(null);
  const rec = useRef<{ r: MediaRecorder; chunks: Blob[] } | null>(null);
  const streams = useRef<MediaStream[]>([]);

  const stopAll = () => { for (const s of streams.current) s.getTracks().forEach((t) => t.stop()); streams.current = []; };
  useEffect(() => () => { stopAll(); if (clip) URL.revokeObjectURL(clip.url); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const open = async (sourceId?: string) => {
    try {
      let s: MediaStream;
      if (mode === 'camera') {
        s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24 } }, audio: { echoCancellation: true, noiseSuppression: true } });
        streams.current.push(s);
      } else {
        if (sourceId) await window.dex.chooseScreen?.(sourceId);
        const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false });
        streams.current.push(screen);
        s = new MediaStream(screen.getVideoTracks());
        try {
          const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
          streams.current.push(mic);
          for (const t of mic.getAudioTracks()) s.addTrack(t);
        } catch { setWithMic(false); }
        screen.getVideoTracks()[0]?.addEventListener('ended', () => { if (rec.current?.r.state === 'recording') rec.current.r.stop(); });
      }
      setStream(s);
      setPhase('ready');
    } catch (e) {
      toast((e as Error).name === 'NotAllowedError' ? 'Access to the camera or screen was blocked.' : mode === 'camera' ? 'No camera was found.' : 'The screen could not be captured.', true);
      onClose();
    }
  };
  useEffect(() => { if (mode === 'camera') void open(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (live.current && stream) live.current.srcObject = stream; }, [stream, phase]);
  useEffect(() => {
    if (phase !== 'recording') return;
    const t = setInterval(() => { setNow(Date.now()); if (Date.now() - started > MAX_MS) rec.current?.r.stop(); }, 200);
    return () => clearInterval(t);
  }, [phase, started]);
  useEffect(() => { for (const t of stream?.getAudioTracks() ?? []) t.enabled = withMic; }, [withMic, stream]);

  const record = () => {
    if (!stream) return;
    const types = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? 'video/webm';
    const r = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: mode === 'screen' ? 1_500_000 : 1_000_000, audioBitsPerSecond: 48_000 });
    const chunks: Blob[] = [];
    const t0 = Date.now();
    r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    r.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const ms = Date.now() - t0;
      stopAll();
      setStream(null);
      setClip({ blob, url: URL.createObjectURL(blob), ms });
      setPhase('review');
    };
    rec.current = { r, chunks };
    r.start(500);
    setStarted(t0);
    setNow(t0);
    setPhase('recording');
  };

  const send = async () => {
    if (!clip) return;
    const limit = policyNow().maxUploadMb * 1024 * 1024;
    if (clip.blob.size > limit) { toast(`The recording is larger than the office limit of ${policyNow().maxUploadMb} MB. Record a shorter one.`, true); return; }
    setBusy(true);
    try {
      const name = `${mode === 'camera' ? 'Video message' : 'Screen recording'} ${tag(clip.ms)}.webm`;
      const info = await window.dex.uploadFile!(`clip-${Date.now().toString(36)}`, { data: await clip.blob.arrayBuffer(), name, mime: 'video/webm', convId });
      await sendMessage(convId, '', parentId, [info]);
      onClose();
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };

  if (phase === 'pick') return <ScreenPicker offerSound={false} onPick={(id) => void open(id)} onClose={onClose} />;
  return (
    <Dialog title={mode === 'camera' ? 'Video message' : 'Screen recording'} onClose={() => { const end = () => { if (rec.current?.r.state === 'recording') rec.current.r.stop(); stopAll(); onClose(); }; if (phase !== 'recording') end(); else void confirmAction({ title: 'Stop and discard this recording?', confirm: 'Discard', danger: true }).then((ok) => { if (ok) end(); }); }}>
      <div className={`clip-stage${mode === 'camera' ? ' camera' : ''}`}>
        {phase === 'review' && clip
          ? <video key="review" src={clip.url} controls autoPlay playsInline />
          : <video key="live" ref={live} autoPlay muted playsInline />}
        {phase === 'recording' && <span className="clip-rec"><span className="rec-dot" />{mmss(now - started)}<span className="faint"> / {mmss(MAX_MS)}</span></span>}
        {!stream && phase !== 'review' && <span className="clip-wait"><span className="spinner" /></span>}
      </div>
      <div className="dialog-actions">
        <span>
          {phase !== 'review' && (
            <button className={`btn ghost sm${withMic ? '' : ' off'}`} onClick={() => setWithMic(!withMic)} disabled={!stream?.getAudioTracks().length} aria-pressed={withMic}>
              <Icon name="mic" size={14} />{withMic ? 'Microphone on' : 'Microphone off'}
            </button>
          )}
          {phase === 'review' && clip && <span className="faint">{mmss(clip.ms)} · {(clip.blob.size / 1024 / 1024).toFixed(1)} MB</span>}
        </span>
        {phase === 'ready' && <button className="btn primary" disabled={!stream} onClick={record}><span className="rec-dot" />Start recording</button>}
        {phase === 'recording' && <button className="btn primary" onClick={() => rec.current?.r.stop()}><Icon name="pause" size={15} />Stop</button>}
        {phase === 'review' && (
          <>
            <button className="btn ghost" disabled={busy} onClick={() => { if (clip) URL.revokeObjectURL(clip.url); setClip(null); if (mode === 'screen') setPhase('pick'); else { setPhase('ready'); void open(); } }}>Record again</button>
            <button className="btn primary" disabled={busy} onClick={() => void send()}>{busy ? <span className="spinner" /> : <Icon name="send" size={15} />}Send</button>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** A video message or screen recording, playing inline. */
export function VideoClip({ f }: { f: FileInfo }) {
  const src = useFileSrc(f);
  const url = src && src.startsWith('dexfile:') ? `${src}?as=video` : src;
  return (
    <div className="video-clip">
      {url ? <video src={url} controls preload="metadata" playsInline /> : <span className="img-loading"><span className="spinner" /></span>}
      <span className="video-name"><Icon name="video" size={13} />{f.name.replace(/\.webm$/i, '')}</span>
    </div>
  );
}
