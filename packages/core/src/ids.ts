// Time-sortable, globally unique IDs (ULID, Crockford base32). Monotonic within one process so
// messages created in the same millisecond still sort in creation order on every PC.
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(time: number): string {
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[time % 32] + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function freshRandom(): number[] {
  const bytes = randomBytes(16);
  return Array.from({ length: 16 }, (_, i) => bytes[i] % 32);
}

function increment(random: number[]): number[] {
  const next = random.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i] < 31) { next[i]++; return next; }
    next[i] = 0;
  }
  throw new Error('ULID random component overflow');
}

export function ulid(now: number = Date.now()): string {
  if (now <= lastTime) {
    lastRandom = increment(lastRandom);
    now = lastTime;
  } else {
    lastTime = now;
    lastRandom = freshRandom();
  }
  return encodeTime(now) + lastRandom.map((n) => ALPHABET[n]).join('');
}

export function ulidTime(id: string): number {
  let time = 0;
  for (const ch of id.slice(0, 10)) time = time * 32 + ALPHABET.indexOf(ch);
  return time;
}
