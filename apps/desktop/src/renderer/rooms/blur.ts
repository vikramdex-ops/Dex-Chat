// The camera's background in a Room: MediaPipe's selfie segmenter (Apache-2.0) finds the person
// in each frame on this PC; what is behind them is blurred, or replaced by a picture (an office
// background drawn in code, or the person's own image), and the person is drawn sharp on top.
// Nothing leaves the PC; the model and engine are bundled (see vite.config.ts).
import type { ImageSegmenter } from '@mediapipe/tasks-vision';

let segmenter: Promise<ImageSegmenter> | null = null;

async function getSegmenter(): Promise<ImageSegmenter> {
  segmenter ??= (async () => {
    const { ImageSegmenter } = await import('@mediapipe/tasks-vision');
    const base = new URL('./segmenter/', location.href).href;
    return ImageSegmenter.createFromOptions({ wasmLoaderPath: `${base}vision_wasm_internal.js`, wasmBinaryPath: `${base}vision_wasm_internal.wasm` }, {
      baseOptions: { modelAssetPath: `${base}selfie_segmenter.tflite`, delegate: 'CPU' },
      runningMode: 'VIDEO',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
  })();
  try { return await segmenter; } catch (err) { segmenter = null; throw err; }
}

/** Cameras using the segmenter now. A minute after the last one stops, it is closed: it holds
 * about 45 MB in the window's process, and loads again in a moment for the next call. */
let users = 0;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
const KEEP_MS = 60_000;
function hold(): () => void {
  users++;
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (--users > 0) return;
    closeTimer = setTimeout(() => {
      closeTimer = null;
      const s = segmenter;
      if (users > 0 || !s) return;
      segmenter = null;
      void s.then((x) => x.close(), () => {});
    }, KEEP_MS);
  };
}

/** What goes behind the person: a blur of the room, or a picture. */
export type BackdropSpec = { kind: 'blur'; strength?: number } | { kind: 'image'; image: HTMLCanvasElement | ImageBitmap };

export interface Blurred {
  track: MediaStreamTrack;
  /** Change what is behind the person without restarting the camera. */
  set(spec: BackdropSpec): void;
  stop(): void;
}

/** Draw an image to fill w x h (cropping the overflow), as CSS object-fit: cover. */
function drawCover(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement | ImageBitmap, w: number, h: number): void {
  const s = Math.max(w / img.width, h / img.height);
  const dw = img.width * s, dh = img.height * s;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/** A new video track: the camera with its background blurred or replaced. Stopping it leaves the camera running. */
export async function backdropTrack(camera: MediaStreamTrack, initial: BackdropSpec): Promise<Blurred> {
  const release = hold();
  try { return await drawBackdrop(camera, initial, release); } catch (err) { release(); throw err; }
}

async function drawBackdrop(camera: MediaStreamTrack, initial: BackdropSpec, release: () => void): Promise<Blurred> {
  const seg = await getSegmenter();
  const s = camera.getSettings();
  const w = s.width ?? 1280;
  const h = s.height ?? 720;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([camera]);
  await video.play();
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d')!;
  const person = document.createElement('canvas');
  person.width = w; person.height = h;
  const pctx = person.getContext('2d')!;
  const mask = document.createElement('canvas');
  const mctx = mask.getContext('2d')!;
  // a replacement picture is scaled once per change, not once per frame
  const backdrop = document.createElement('canvas');
  backdrop.width = w; backdrop.height = h;
  const bctx = backdrop.getContext('2d')!;
  let spec = initial;
  const prepare = () => { if (spec.kind === 'image') { bctx.clearRect(0, 0, w, h); drawCover(bctx, spec.image, w, h); } };
  prepare();
  let live = true;
  let last = -1;
  let maskData: ImageData | null = null;
  const frame = () => {
    if (!live) return;
    if (video.readyState >= 2 && video.currentTime !== last) {
      last = video.currentTime;
      try {
        seg.segmentForVideo(video, performance.now(), (r) => {
          const m = r.confidenceMasks?.[0];
          if (!m) return;
          if (mask.width !== m.width || mask.height !== m.height) { mask.width = m.width; mask.height = m.height; maskData = null; }
          maskData ??= mctx.createImageData(m.width, m.height);
          const conf = m.getAsFloat32Array();
          const px = maskData.data;
          for (let i = 0; i < conf.length; i++) {
            // soften the edge a little: below 0.35 is background, above 0.65 fully person
            const a = Math.min(1, Math.max(0, (conf[i] - 0.35) / 0.3));
            px[i * 4 + 3] = a * 255;
          }
          mctx.putImageData(maskData, 0, 0);
        });
      } catch { /* a dropped frame: keep the last mask */ }
      // the person, cut out by the mask (scaled up smoothly)
      pctx.globalCompositeOperation = 'source-over';
      pctx.clearRect(0, 0, w, h);
      pctx.drawImage(video, 0, 0, w, h);
      pctx.globalCompositeOperation = 'destination-in';
      pctx.imageSmoothingEnabled = true;
      pctx.drawImage(mask, 0, 0, w, h);
      // the background, then the person on top
      if (spec.kind === 'blur') {
        const strength = spec.strength ?? 14;
        ctx.filter = `blur(${strength}px)`;
        ctx.drawImage(video, -strength, -strength, w + strength * 2, h + strength * 2);
        ctx.filter = 'none';
      } else ctx.drawImage(backdrop, 0, 0);
      ctx.drawImage(person, 0, 0);
    }
    video.requestVideoFrameCallback ? video.requestVideoFrameCallback(frame) : requestAnimationFrame(frame);
  };
  frame();
  const stream = out.captureStream(Math.min(30, s.frameRate ?? 24));
  const track = stream.getVideoTracks()[0];
  return {
    track,
    set(next) { spec = next; prepare(); },
    stop() { live = false; track.stop(); video.srcObject = null; release(); },
  };
}

/** A new video track: the camera with its background blurred. */
export function blurTrack(camera: MediaStreamTrack, strength = 14): Promise<Blurred> {
  return backdropTrack(camera, { kind: 'blur', strength });
}

/** Whether this build carries the segmenter (desktop yes, phones not yet). */
export async function blurAvailable(): Promise<boolean> {
  try { return (await fetch(new URL('./segmenter/selfie_segmenter.tflite', location.href).href, { method: 'HEAD' })).ok; } catch { return false; }
}
