// "Share to Dexterity Connect": other office tools open
// dexconnect://share?text=…&file=…&to=…&from=…&title=…&link=… and the desktop app shows what
// will be sent (apps/desktop/src/renderer/views/ShareDialog.tsx). Read here so it can be tested.
import { safeWorkbookLink } from './sheets.ts';

export interface ShareRequest {
  text: string;
  files: string[];
  /** Preselect: a Windows account ("DOMAIN\\name" or "name") or "space:Name". */
  to: string | null;
  /** Which tool asked, shown to the person. */
  from: string | null;
}

/** Words that are safe inside a Markdown link label. */
const linkLabel = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * The link a tool sent, ready to sit in a message. A workbook link keeps its `?at=<Sheet>!<Cell>`
 * whole (spaces and quotes in a sheet name are encoded, so the link does not end early); other
 * links have spaces encoded.
 */
function shareLink(link: string): string {
  const s = link.trim();
  return safeWorkbookLink(s) ?? s.replace(/\s/g, '%20');
}

/** Links the apps draw as a labelled Markdown link (apps/desktop/src/renderer/chat/format.tsx). */
const MARKDOWN_LINK = /^(?:https?|dexconnect|projectopener|dexterity|sleuth|datum):\/\/\S+$/i;

/** Read a dexconnect://share link. Returns null for anything else. */
export function parseShare(url: string): ShareRequest | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'dexconnect:' || !/^\/*share\/?$/.test(`${u.hostname}${u.pathname}`)) return null;
  const p = u.searchParams;
  const link = p.get('link')?.trim() ? shareLink(p.get('link')!) : '';
  const title = linkLabel(p.get('title') ?? '');
  // a titled link is written as a Markdown link (the title shows, the link opens); the card under
  // the message shows the rest (a workbook's sheet and cell)
  const linked = link ? (title && MARKDOWN_LINK.test(link) ? `[${title}](${link.replace(/\)/g, '%29')})` : `${title ? `${title}: ` : ''}${link}`) : '';
  const parts = [p.get('text') ?? '', linked].filter(Boolean);
  return {
    text: parts.join('\n').slice(0, 8000),
    files: p.getAll('file').filter((f) => f.trim()).slice(0, 20),
    to: p.get('to'),
    from: p.get('from')?.slice(0, 40) ?? null,
  };
}
