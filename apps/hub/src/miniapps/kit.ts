// What the tools that come with Dexterity Connect share: the page they are written into, the
// drafting-office styles (title-block captions, ruled cells, sheet tabs) in the host's colours,
// and the shape of the `dex` API they talk through.
//
// Each tool's code is one function that refers to nothing outside itself; helpers it needs are
// passed in as `lib` (plain functions, also tested on their own). The page carries their source.

/** The API inside a tool's frame (see packages/core/src/miniapp.ts). */
export interface DexApi {
  context(): Promise<{
    viewer: { id: string; name: string };
    conversation: { id: string; kind: 'space' | 'direct'; name: string };
    app: { id: string; name: string; version: string };
    instanceId: string;
    permissions: string[];
    theme: { mode: 'light' | 'dark'; colors: Record<string, string> };
  }>;
  members(): Promise<Array<{ id: string; name: string; title: string | null }>>;
  post(text: string): Promise<{ posted: boolean }>;
  state: {
    get(): Promise<{ state: unknown; version: number; updatedBy: string | null; updatedAt: number | null }>;
    set(state: unknown, baseVersion?: number): Promise<{ state: unknown; version: number; conflict: boolean }>;
  };
  files: {
    list(): Promise<Array<{ id: string; name: string; mime: string; size: number; createdAt: number }>>;
    read(fileId: string): Promise<{ id: string; name: string; mime: string; size: number; bytes: ArrayBuffer }>;
  };
  resize(height: number): Promise<unknown>;
  on(event: 'state', cb: (d: { state: unknown; version: number; updatedBy: string | null }) => void): void;
  on(event: 'theme', cb: (d: unknown) => void): void;
}

export interface BuiltinApp {
  manifest: { id: string; name: string; version: string; description: string; permissions: Array<'members' | 'post' | 'state' | 'files' | 'network'>; hosts: string[]; height: number };
  html: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

/** Merge two lists of records by id: everything from both, the newer copy (by `at`) of each. */
export function mergeById<T extends { id: string; at: number }>(a: T[], b: T[]): T[] {
  const m = new Map<string, T>();
  for (const x of [...a, ...b]) { const cur = m.get(x.id); if (!cur || x.at >= cur.at) m.set(x.id, x); }
  return [...m.values()].sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1));
}

/** HTML-escape text written into markup. */
export function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const BASE_CSS = `
:root {
  --dex-bg: #ffffff; --dex-text: #15191b; --dex-text-2: #43585b; --dex-text-3: #6f8386;
  --dex-stroke: rgba(19,43,46,.09); --dex-stroke-strong: rgba(19,43,46,.16); --dex-subtle: rgba(19,43,46,.045);
  --dex-accent: #1c7680; --dex-accent-soft: rgba(42,140,152,.12); --dex-accent-text: #ffffff; --dex-accent-ink: #1e6066;
  --dex-amber: #f7af44; --dex-amber-soft: rgba(247,175,68,.18); --dex-ok: #2b8a4b; --dex-danger: #b23628;
  --dex-font-body: 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif;
  --dex-font-mono: 'Cascadia Mono', 'JetBrains Mono', Consolas, ui-monospace, monospace;
  --dex-font-display: 'Outfit Variable', 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; }
body { font: 13px/1.45 var(--dex-font-body); color: var(--dex-text); background: var(--dex-bg); overflow: hidden; -webkit-font-smoothing: antialiased; }
button, input, select, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--dex-accent); outline-offset: 1px; }
.app { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.cap { font: 600 9.5px/1.2 var(--dex-font-mono); letter-spacing: .12em; text-transform: uppercase; color: var(--dex-text-3); }
.mono { font-family: var(--dex-font-mono); font-variant-numeric: tabular-nums; }
.muted { color: var(--dex-text-2); }
.faint { color: var(--dex-text-3); }
.row { display: flex; align-items: center; gap: 8px; }
.grow { flex: 1; min-width: 0; }
.btn { height: 28px; padding: 0 11px; border-radius: 4px; border: 1px solid var(--dex-stroke-strong); background: var(--dex-bg); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.btn:hover { background: var(--dex-subtle); }
.btn:disabled { opacity: .5; pointer-events: none; }
.btn.primary { background: var(--dex-accent); color: var(--dex-accent-text); border-color: transparent; font-weight: 600; }
.btn.ghost { border-color: transparent; background: none; color: var(--dex-text-2); }
.btn.on { background: var(--dex-accent-soft); border-color: var(--dex-accent); color: var(--dex-accent-ink); }
.input { height: 28px; padding: 0 8px; border-radius: 4px; border: 1px solid var(--dex-stroke-strong); border-bottom-color: var(--dex-text-3); background: var(--dex-bg); outline: none; min-width: 0; }
.input:focus { border-bottom: 2px solid var(--dex-accent); }
/* the title block: ruled cells of mono facts along the top of a tool */
.tblock { display: flex; border-bottom: 1px solid var(--dex-stroke-strong); flex: none; }
.tblock > div { padding: 5px 9px; border-right: 1px solid var(--dex-stroke); min-width: 0; }
.tblock > div:last-child { border-right: 0; }
.tblock b { display: block; font: 600 12px/1.3 var(--dex-font-mono); color: var(--dex-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* sheet tabs, like the tabs along the edge of a drawing set */
.tabs { display: flex; gap: 2px; padding: 0 8px; border-bottom: 1px solid var(--dex-stroke-strong); flex: none; overflow-x: auto; scrollbar-width: none; }
.tab { padding: 5px 10px 4px; border: 1px solid transparent; border-bottom: 0; border-radius: 4px 4px 0 0; background: none; cursor: pointer; color: var(--dex-text-2); font: 600 10px/1.3 var(--dex-font-mono); letter-spacing: .08em; text-transform: uppercase; white-space: nowrap; margin-bottom: -1px; }
.tab[aria-selected="true"] { background: var(--dex-bg); border-color: var(--dex-stroke-strong); color: var(--dex-accent-ink); }
.ruled { border-collapse: collapse; width: 100%; }
.ruled th, .ruled td { border-bottom: 1px solid var(--dex-stroke); padding: 4px 8px; text-align: left; }
.ruled th { font: 600 9.5px/1.2 var(--dex-font-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--dex-text-3); position: sticky; top: 0; background: var(--dex-bg); border-bottom-color: var(--dex-stroke-strong); }
.ruled td.n { text-align: right; font-family: var(--dex-font-mono); font-variant-numeric: tabular-nums; }
.scroll { overflow: auto; min-height: 0; }
.note { padding: 8px 10px; border-left: 2px solid var(--dex-amber); background: var(--dex-amber-soft); font-size: 12px; }
.empty { display: grid; place-items: center; text-align: center; padding: 20px; color: var(--dex-text-3); background-image: linear-gradient(var(--dex-stroke) 1px, transparent 1px), linear-gradient(90deg, var(--dex-stroke) 1px, transparent 1px); background-size: 16px 16px; }
.err { color: var(--dex-danger); }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

/** One tool page: markup, styles, and its code with the helpers it is given. */
export function page(opts: { title: string; css: string; body: string; main: (dex: DexApi, lib: never) => void | Promise<void>; lib?: Record<string, AnyFn | Record<string, unknown>> }): string {
  const lib = Object.entries(opts.lib ?? {}).map(([k, v]) => `${JSON.stringify(k)}: ${typeof v === 'function' ? `(${v.toString()})` : JSON.stringify(v)}`).join(',\n');
  const code = `"use strict";\nconst lib = {\n${lib}\n};\n(${opts.main.toString()})(window.dex, lib);`.replace(/<\/script/gi, '<\\/script');
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(opts.title)}</title><style>${BASE_CSS}${opts.css}</style></head><body>${opts.body}<script>${code}</script></body></html>`;
}
