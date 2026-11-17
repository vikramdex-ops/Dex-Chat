// Nib's mark: the nib of a drafting pen, drawn on our 24 px grid (the tapered blade, the collar,
// the slit and the breather hole), on a square bot tile. When Nib wants something an ink drop
// forms at the tip: hollow teal for something quiet to look at, solid amber when it needs you.

export const NIB_PATH = 'M8.5 3.5h7v3l2.5 4L12 20.5 6 10.5l2.5-4zM8.5 6.5h7M12 20.5v-7.6';

export function NibGlyph({ size = 20, stroke = 1.6 }: { size?: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={NIB_PATH} />
      <circle cx="12" cy="11.4" r="1.5" />
    </svg>
  );
}

export type Ink = 'none' | 'quiet' | 'needs';

/** The tile, with its ink drop (sizes 20 to 56). */
export function NibTile({ size = 28, ink = 'none', title }: { size?: number; ink?: Ink; title?: string }) {
  return (
    <span className={`nib-tile ink-${ink}`} style={{ width: size, height: size }} title={title} aria-hidden={title ? undefined : true} translate="no">
      <NibGlyph size={Math.round(size * 0.68)} stroke={size >= 40 ? 1.4 : 1.7} />
      {ink !== 'none' && (
        <svg className="nib-drop" width={Math.max(8, Math.round(size * 0.34))} height={Math.max(10, Math.round(size * 0.42))} viewBox="0 0 10 12" aria-hidden="true">
          <path d="M5 .8C6.6 3.4 8.6 5.6 8.6 7.8a3.6 3.6 0 0 1-7.2 0C1.4 5.6 3.4 3.4 5 .8z" />
        </svg>
      )}
    </span>
  );
}
