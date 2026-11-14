// The maths behind the document scanner: finding a sheet of paper in a photo, straightening it
// (a perspective transform) and writing the pages into a PDF. No libraries.

export type Pt = { x: number; y: number };
export type Quad = [Pt, Pt, Pt, Pt]; // top-left, top-right, bottom-right, bottom-left

/** Otsu's threshold of a greyscale image. */
function otsu(grey: Uint8ClampedArray): number {
  const hist = new Array<number>(256).fill(0);
  for (const g of grey) hist[g]++;
  const total = grey.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, at = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; at = t; }
  }
  return at;
}

/**
 * Where the sheet is: paper is lighter than what it lies on. The largest light region's extreme
 * corners (smallest x+y, largest x-y, ...) give the four corners. Falls back to an inset frame.
 */
export function findSheet(img: ImageData): Quad {
  const { width: w, height: h, data } = img;
  const grey = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) grey[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
  const t = otsu(grey);
  // the largest light region (4-connected), found with a flood fill
  const seen = new Uint8Array(w * h);
  let bestPixels: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || grey[start] <= t) continue;
    const pixels: number[] = [];
    stack.push(start); seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      pixels.push(p);
      const x = p % w, y = (p - x) / w;
      if (x > 0 && !seen[p - 1] && grey[p - 1] > t) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < w - 1 && !seen[p + 1] && grey[p + 1] > t) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && !seen[p - w] && grey[p - w] > t) { seen[p - w] = 1; stack.push(p - w); }
      if (y < h - 1 && !seen[p + w] && grey[p + w] > t) { seen[p + w] = 1; stack.push(p + w); }
    }
    if (pixels.length > bestPixels.length) bestPixels = pixels;
  }
  const inset: Quad = [{ x: w * 0.08, y: h * 0.08 }, { x: w * 0.92, y: h * 0.08 }, { x: w * 0.92, y: h * 0.92 }, { x: w * 0.08, y: h * 0.92 }];
  if (bestPixels.length < w * h * 0.12) return inset;
  let tl = bestPixels[0], tr = tl, br = tl, bl = tl;
  const v = (p: number) => ({ x: p % w, y: Math.floor(p / w) });
  for (const p of bestPixels) {
    const a = v(p);
    const [TL, TR, BR, BL] = [v(tl), v(tr), v(br), v(bl)];
    if (a.x + a.y < TL.x + TL.y) tl = p;
    if (a.x - a.y > TR.x - TR.y) tr = p;
    if (a.x + a.y > BR.x + BR.y) br = p;
    if (a.y - a.x > BL.y - BL.x) bl = p;
  }
  return [v(tl), v(tr), v(br), v(bl)];
}

/** The 3×3 homography that maps the unit square's corners onto the quad (as 8 numbers, h33 = 1). */
function squareToQuad(q: Quad): number[] {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = den === 0 ? 0 : (dx3 * dy2 - dx2 * dy3) / den;
  const hh = den === 0 ? 0 : (dx1 * dy3 - dx3 * dy1) / den;
  return [
    p1.x - p0.x + g * p1.x, p3.x - p0.x + hh * p3.x, p0.x,
    p1.y - p0.y + g * p1.y, p3.y - p0.y + hh * p3.y, p0.y,
    g, hh,
  ];
}

/** Straighten the quad from the source into an upright page of outW × outH (bilinear sampling). */
export function warp(src: ImageData, q: Quad, outW: number, outH: number): ImageData {
  const m = squareToQuad(q);
  const out = new ImageData(outW, outH);
  const s = src.data, d = out.data, sw = src.width, sh = src.height;
  for (let y = 0; y < outH; y++) {
    const v = (y + 0.5) / outH;
    for (let x = 0; x < outW; x++) {
      const u = (x + 0.5) / outW;
      const z = m[6] * u + m[7] * v + 1;
      const fx = (m[0] * u + m[1] * v + m[2]) / z;
      const fy = (m[3] * u + m[4] * v + m[5]) / z;
      const x0 = Math.max(0, Math.min(sw - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(sh - 2, Math.floor(fy)));
      const ax = Math.min(1, Math.max(0, fx - x0)), ay = Math.min(1, Math.max(0, fy - y0));
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const o = (y * outW + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = s[i00 + c] * (1 - ax) + s[i10 + c] * ax;
        const bot = s[i01 + c] * (1 - ax) + s[i11 + c] * ax;
        d[o + c] = top * (1 - ay) + bot * ay;
      }
      d[o + 3] = 255;
    }
  }
  return out;
}

/** "Document" look: grey, the paper white and the ink dark (local contrast over 32-px tiles). */
export function cleanUp(img: ImageData): ImageData {
  const { width: w, height: h, data } = img;
  const grey = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) grey[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
  // the paper's brightness around each point (box blur via an integral image)
  const r = 24;
  const integ = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += grey[y * w + x]; integ[(y + 1) * (w + 1) + x + 1] = integ[y * (w + 1) + x + 1] + row; }
  }
  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const sum = integ[y1 * (w + 1) + x1] - integ[y0 * (w + 1) + x1] - integ[y1 * (w + 1) + x0] + integ[y0 * (w + 1) + x0];
      const bg = sum / ((x1 - x0) * (y1 - y0));
      const v = Math.max(0, Math.min(255, 255 * Math.pow(Math.min(1, grey[y * w + x] / Math.max(1, bg * 0.92)), 2.2)));
      const o = (y * w + x) * 4;
      out.data[o] = out.data[o + 1] = out.data[o + 2] = v;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** A PDF of JPEG pages, each on an A4 sheet (portrait or landscape to suit it). */
export function pagesToPdf(pages: Array<{ jpeg: Uint8Array; width: number; height: number }>): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const push = (b: Uint8Array | string) => { const u = typeof b === 'string' ? enc.encode(b) : b; parts.push(u); pos += u.length; };
  const obj = (n: number, body: string | Uint8Array[]) => {
    offsets[n] = pos;
    push(`${n} 0 obj\n`);
    if (typeof body === 'string') push(body); else for (const b of body) push(b);
    push('\nendobj\n');
  };
  push('%PDF-1.4\n%âãÏÓ\n');
  const n = pages.length;
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${kids}] >>`);
  pages.forEach((p, i) => {
    const pageN = 3 + i * 3, imgN = pageN + 1, contN = pageN + 2;
    const land = p.width > p.height;
    const [pw, ph] = land ? [842, 595] : [595, 842];
    const scale = Math.min(pw / p.width, ph / p.height);
    const dw = p.width * scale, dh = p.height * scale;
    const ox = (pw - dw) / 2, oy = (ph - dh) / 2;
    obj(pageN, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im${i} ${imgN} 0 R >> >> /Contents ${contN} 0 R >>`);
    obj(imgN, [enc.encode(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`), p.jpeg, enc.encode('\nendstream')]);
    const content = `q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${ox.toFixed(2)} ${oy.toFixed(2)} cm /Im${i} Do Q`;
    obj(contN, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  const xref = pos;
  const count = 3 + n * 3;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let i = 1; i < count; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(pos);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
