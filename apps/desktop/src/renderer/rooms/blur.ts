// Background blur for the camera in a Room: MediaPipe's selfie segmenter (Apache-2.0) finds the
// person in each frame on this PC; the background is blurred and the person drawn sharp on top.
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

export interface Blurred { track: MediaStreamTrack; stop(): void }

/** A new video track: the camera with its background blurred. Stopping it leaves the camera running. */
export async function blurTrack(camera: MediaStreamTrack, strength = 14): Promise<Blurred> {
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
      // the background, blurred, then the person on top
      ctx.filter = `blur(${strength}px)`;
      ctx.drawImage(video, -strength, -strength, w + strength * 2, h + strength * 2);
      ctx.filter = 'none';
      ctx.drawImage(person, 0, 0);
    }
    video.requestVideoFrameCallback ? video.requestVideoFrameCallback(frame) : requestAnimationFrame(frame);
  };
  frame();
  const stream = out.captureStream(Math.min(30, s.frameRate ?? 24));
  const track = stream.getVideoTracks()[0];
  return {
    track,
    stop() { live = false; track.stop(); video.srcObject = null; },
  };
}

/** Whether this build carries the segmenter (desktop yes, phones not yet). */
export async function blurAvailable(): Promise<boolean> {
  try { return (await fetch(new URL('./segmenter/selfie_segmenter.tflite', location.href).href, { method: 'HEAD' })).ok; } catch { return false; }
}
