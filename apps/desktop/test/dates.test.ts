// Dates and times: the app's toLocale*String keep their formatters (src/renderer/i18n), and must
// read exactly as the browser's own methods do for every kind of call the screens make.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const orig = {
  toLocaleDateString: Date.prototype.toLocaleDateString,
  toLocaleTimeString: Date.prototype.toLocaleTimeString,
  toLocaleString: Date.prototype.toLocaleString,
};
await import('../src/renderer/i18n/index.ts');

const OPTS: Array<Intl.DateTimeFormatOptions | undefined> = [
  undefined, {}, { hour12: true }, { hour12: false }, { hour: '2-digit', minute: '2-digit' }, { hour: 'numeric', minute: '2-digit', hour12: true },
  { day: 'numeric', month: 'short' }, { day: 'numeric', month: 'short', year: undefined }, { day: 'numeric', month: 'short', year: 'numeric' },
  { weekday: 'short' }, { weekday: 'short', hour: 'numeric', minute: '2-digit' }, { dateStyle: 'medium' }, { timeStyle: 'short' },
  { dateStyle: 'full', timeStyle: 'short' }, { month: 'long', year: 'numeric' }, { hour: '2-digit' }, { timeZone: 'Asia/Kolkata', hour: 'numeric' },
  { timeZoneName: 'short' },
];
const DATES = [new Date(2026, 10, 15, 9, 5, 7), new Date(2025, 0, 1, 0, 0, 0), new Date(2026, 6, 4, 23, 59, 59), new Date(Number.NaN)];

test('formatted dates read the same as the methods they replace', () => {
  for (const name of ['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString'] as const) {
    for (const locales of [undefined, [], 'en-GB', 'hi-IN', ['ta-IN']] as Array<string | string[] | undefined>) {
      for (const opts of OPTS) {
        for (const d of DATES) {
          let want: string | Error;
          try { want = orig[name].call(d, locales, opts); } catch (e) { want = e as Error; }
          let got: string | Error;
          try { got = d[name](locales, opts); } catch (e) { got = e as Error; }
          if (want instanceof Error) assert.ok(got instanceof Error, `${name} ${JSON.stringify([locales, opts])} should fail`);
          else assert.equal(got, want, `${name} ${JSON.stringify([locales, opts])} ${d.getTime()}`);
          // and again, from the kept formatter
          if (!(want instanceof Error)) assert.equal(d[name](locales, opts), want);
        }
      }
    }
  }
});
