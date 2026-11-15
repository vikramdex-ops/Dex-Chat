// A member-made bot's mark: one of our symbols drawn on the 24 px grid, or two letters set in a
// title-block frame, on a square tile in a colour from our palette. Bots are stamps on the sheet,
// so their tile is square (people's are squircles). The marks of every member-made bot are kept
// here for the app's tiles (ui.tsx asks through setTileArt), loaded from the hub and refreshed
// when the catalogue changes.
import type { BotColour, BotGlyph, BotMark as Mark } from '@dex/core';
import { BOT_COLOURS } from '@dex/core';
import { setTileArt } from '../ui.tsx';

export const GLYPH_PATHS: Record<BotGlyph, string> = {
  /** A drawing sheet with its title block. */
  sheet: 'M5 3.5h14v17H5zM5 15.5h14M12 15.5v5M14.5 18h2.5',
  /** A plotter with its roll. */
  plotter: 'M3.5 9h17v6h-17zM6.5 15v5h11v-5M6.5 9V4h11v5M7 12h4M16.5 12h.01',
  /** A hard hat. */
  helmet: 'M5.5 16.5a6.5 6.5 0 0 1 13 0M10 10.2V7.5h4v2.7M3.5 16.5h17v2.5h-17z',
  /** A level on its tripod. */
  level: 'M7.5 5.5h9v4h-9zM16.5 7.5H19M12 9.5V13M12 13l-5 7.5M12 13l5 7.5M12 13v7.5',
  /** A pipe flange, in section. */
  flange: 'M3 9.5h5v5H3zM8 6.5h3v11H8zM13 6.5h3v11h-3zM16 9.5h5v5h-5z',
  /** An I-beam, end on. */
  beam: 'M6 4.5h12M6 19.5h12M12 4.5v15M6 4.5V7M18 4.5V7M6 19.5V17M18 19.5V17',
  /** A month on the wall. */
  calendar: 'M4.5 6h15v13.5h-15zM4.5 10h15M8.5 4v4M15.5 4v4M8 14h3M8 16.5h6',
  /** An issue stamp. */
  stamp: 'M9.5 3.5h5v6h-5zM6 9.5h12v4H6zM4.5 17h15M8 20h8',
  /** A drawing compass. */
  compass: 'M12 3.5v2.5M12 6l-5 14M12 6l5 14M8.6 15.5h6.8',
  /** A check sheet on a board. */
  clipboard: 'M6.5 5h11v15.5h-11zM9.5 3.5h5v3h-5zM9 11.5l1.5 1.5L13.5 10M9 16.5h6',
  /** A setting-out pin. */
  pin: 'M12 20.5s-6-5.4-6-10.5a6 6 0 0 1 12 0c0 5.1-6 10.5-6 10.5ZM12 12.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z',
  /** A request for information: a revision delta with a question in it. */
  rfi: 'M12 4 3.5 19.5h17zM10.3 11.2a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.9.8-.9 1.4v.3M12 16.8h.01',
};

export const GLYPH_WORDS: Record<BotGlyph, string> = {
  sheet: 'Drawing sheet', plotter: 'Plotter', helmet: 'Hard hat', level: 'Level', flange: 'Flange', beam: 'Beam',
  calendar: 'Calendar', stamp: 'Issue stamp', compass: 'Compass', clipboard: 'Check sheet', pin: 'Setting-out pin', rfi: 'RFI',
};
export const COLOUR_WORDS: Record<BotColour, string> = {
  teal: 'Teal', petrol: 'Petrol', slate: 'Slate', indigo: 'Indigo', plum: 'Plum', rust: 'Rust', olive: 'Olive', ochre: 'Ochre',
};

export function GlyphSvg({ glyph, size = 20 }: { glyph: BotGlyph; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={GLYPH_PATHS[glyph] ?? GLYPH_PATHS.pin} />
    </svg>
  );
}

/** The mark itself, inside its tile (sizes: 20, 28, 36, 56 px). */
function Art({ mark, size }: { mark: Mark; size: number }) {
  if (mark.kind === 'glyph' && mark.glyph) return <GlyphSvg glyph={mark.glyph} size={Math.round(size * 0.62)} />;
  return <span className="bot-mono" style={{ fontSize: Math.round(size * (mark.letters && mark.letters.length > 1 ? 0.36 : 0.44)) }}>{mark.letters || '?'}</span>;
}

export function BotMarkTile({ mark, colour, size = 36, title }: { mark: Mark; colour: BotColour; size?: number; title?: string }) {
  return (
    <span className={`bot-tile${mark.kind === 'monogram' ? ' mono' : ''}`} style={{ width: size, height: size, background: BOT_COLOURS[colour] ?? BOT_COLOURS.teal }} title={title} aria-hidden={title ? undefined : true} translate="no">
      <Art mark={mark} size={size} />
    </span>
  );
}

// ------------------------------------------------------------------ marks of every member-made bot
const marks = new Map<string, { name: string; mark: Mark; colour: BotColour }>();
let started = false;

const SIZE: Record<string, number> = { sm: 28, lg: 56 };

/** Load the marks once and keep them current (called by the app frame). */
export function startBotMarks(): void {
  if (started) return;
  started = true;
  setTileArt((id, size) => {
    const m = marks.get(id);
    if (!m) return null;
    const px = SIZE[size ?? ''] ?? 36;
    return { colour: BOT_COLOURS[m.colour] ?? BOT_COLOURS.teal, node: <Art mark={m.mark} size={px} />, monogram: m.mark.kind === 'monogram' };
  });
  const load = () => void window.dex.request('botflow.marks').then((list) => {
    marks.clear();
    for (const m of list) marks.set(m.botId, { name: m.name, mark: m.mark, colour: m.colour });
    window.dispatchEvent(new CustomEvent('dex-bot-marks'));
  }).catch(() => {});
  load();
  window.dex.onHubEvent((n) => { if (n === 'botflow.catalog') load(); });
}

/** Is this a bot a member made (rather than an integration)? */
export const isMadeBot = (id: string): boolean => marks.has(id);
