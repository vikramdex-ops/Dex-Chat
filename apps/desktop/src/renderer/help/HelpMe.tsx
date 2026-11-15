// "Help me…": ask IT from inside the app. Say what is wrong in a line, choose what it is about,
// add details and, if it helps, a picture of the screen; it goes to the IT desk's queue. Your
// earlier requests are listed underneath with where they stand.
import { useEffect, useState } from 'react';
import { HELP_CATEGORIES, ticketRef } from '@dex/core';
import type { HelpCategory, HelpTicket, PublicUser } from '@dex/core';
import { Dialog, Icon, useToast } from '../ui.tsx';
import { StatusStamp, ticketMeta } from './parts.tsx';
import { createRequest, useHelp } from './store.ts';

const GLYPH: Record<HelpCategory, string> = {
  software: 'M4 5h16v11H4zM9 19.5h6M8 9.5l2 2-2 2M12.5 13.5h3',
  hardware: 'M4.5 6h15v9.5h-15zM2.5 18.5h19M10 15.5v3',
  network: 'M12 3.5v5M5.5 15.5v-3.5h13v3.5M12 8.5v3.5M3 15.5h5v5H3zM9.5 15.5h5v5h-5zM16 15.5h5v5h-5z',
  printing: 'M7 9V3.5h10V9M5 17.5H3.5V9h17v8.5H19M7 14h10v6.5H7z',
  account: 'M8 10.5V8a4 4 0 0 1 8 0v2.5M5.5 10.5h13v10h-13zM12 14.5v2.5',
  drawings: 'M4 3.5h11l5 5v12H4zM15 3.5v5h5M7.5 17l3-6 2.5 4 1.5-2 2 4z',
  other: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4v.6M12 17h.01',
};

function CatGlyph({ id }: { id: HelpCategory }) {
  return <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={GLYPH[id]} /></svg>;
}

type Picture = { data: ArrayBuffer; name: string; mime: string; url: string };

export function HelpMe({ users, onClose, onOpenTicket }: { users: Map<string, PublicUser>; onClose: () => void; onOpenTicket: (id: string) => void }) {
  const toast = useToast();
  const staff = useHelp((s) => s.staff);
  const mine = useHelp((s) => s.mine);
  const [summary, setSummary] = useState('');
  const [category, setCategory] = useState<HelpCategory | null>(null);
  const [detail, setDetail] = useState('');
  const [picture, setPicture] = useState<Picture | null>(null);
  const [busy, setBusy] = useState<'shot' | 'send' | null>(null);
  const [sent, setSent] = useState<HelpTicket | null>(null);
  useEffect(() => () => { if (picture) URL.revokeObjectURL(picture.url); }, [picture]);
  const grab = async () => {
    setBusy('shot');
    try {
      const shot = await window.dex.assist!.screenshot();
      if (!shot) { toast('The screen could not be pictured on this PC.', true); return; }
      setPicture({ ...shot, mime: 'image/png', url: URL.createObjectURL(new Blob([shot.data], { type: 'image/png' })) });
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(null); }
  };
  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) { toast('Choose a picture.', true); return; }
    if (f.size > 20 * 1024 * 1024) { toast('That picture is larger than 20 MB.', true); return; }
    setPicture({ data: await f.arrayBuffer(), name: f.name, mime: f.type, url: URL.createObjectURL(f) });
  };
  const send = async () => {
    if (!category) return;
    setBusy('send');
    try {
      const t = await createRequest({ summary, detail, category, screenshot: picture });
      setSent(t);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(null); }
  };
  const ready = summary.trim().length >= 3 && !!category;
  const earlier = mine.filter((t) => t.id !== sent?.id).slice(0, 6);
  return (
    <Dialog title={sent ? 'Sent to the IT desk' : 'Ask IT for help'} onClose={onClose}>
      {sent ? (
        <div className="hm-sent">
          <div className="hm-ref"><span className="label">Your request</span><b className="mono">{ticketRef(sent.number)}</b><StatusStamp t={sent} /></div>
          <p>It is in the IT desk's queue{staff.length ? ` (${staff.length} ${staff.length === 1 ? 'person' : 'people'})` : ''}. You hear here when someone takes it, and they may ask to open a support session with you.</p>
          <div className="dialog-actions">
            <button className="btn ghost" onClick={() => onOpenTicket(sent.id)}>Open the request</button>
            <button className="btn primary" onClick={onClose}>Done</button>
          </div>
        </div>
      ) : (
        <form className="hm-form" onSubmit={(e) => { e.preventDefault(); if (ready) void send(); }}>
          {!staff.length && <p className="hm-warn"><Icon name="info" size={15} />No one is on the IT desk yet. Your request waits until an administrator gives someone the IT role.</p>}
          <div className="field">
            <label htmlFor="hm-summary">What is wrong?</label>
            <input id="hm-summary" className="input" autoFocus maxLength={140} placeholder="The plotter on the 2nd floor will not print A1 sheets" value={summary} onChange={(e) => setSummary(e.target.value)} />
          </div>
          <div className="field">
            <span className="label-like" id="hm-cat">It is about</span>
            <div className="hm-cats" role="radiogroup" aria-labelledby="hm-cat">
              {HELP_CATEGORIES.map((c) => (
                <button type="button" key={c.id} role="radio" aria-checked={category === c.id} className={`hm-cat${category === c.id ? ' on' : ''}`} onClick={() => setCategory(c.id)}>
                  <CatGlyph id={c.id} /><span className="hm-cat-label">{c.label}</span>{c.hint && <span className="hm-cat-hint">{c.hint}</span>}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label htmlFor="hm-detail">Details <span className="faint">(optional)</span></label>
            <textarea id="hm-detail" className="input" rows={3} maxLength={4000} placeholder="What you were doing, what you see, since when" value={detail} onChange={(e) => setDetail(e.target.value)} />
          </div>
          <div className="hm-pic">
            {picture ? (
              <figure className="hm-thumb">
                <img src={picture.url} alt="The picture you are sending" />
                <figcaption><span className="mono" translate="no">{picture.name}</span><button type="button" className="btn ghost sm" onClick={() => setPicture(null)}>Remove</button></figcaption>
              </figure>
            ) : (
              <>
                {window.dex.assist && <button type="button" className="btn" disabled={busy === 'shot'} onClick={() => void grab()}>{busy === 'shot' ? <span className="spinner" /> : <Icon name="screen" size={15} />}Add a picture of my screen</button>}
                <label className="btn ghost">
                  <Icon name="paperclip" size={15} />{window.dex.assist ? 'Or a picture from a file' : 'Attach a picture'}
                  <input type="file" accept="image/*" hidden onChange={(e) => void pick(e.target.files?.[0])} />
                </label>
              </>
            )}
          </div>
          <div className="dialog-actions">
            <span className="faint hm-who">IT sees your name, your request and your PC's system.</span>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!ready || busy === 'send'}>{busy === 'send' ? <span className="spinner" /> : <Icon name="send" size={15} />}Send to IT</button>
          </div>
        </form>
      )}
      {earlier.length > 0 && (
        <section className="hm-mine">
          <div className="label">Your requests</div>
          {earlier.map((t) => (
            <button key={t.id} className="hm-row" onClick={() => onOpenTicket(t.id)}>
              <span className="hm-row-main"><span translate="no">{t.summary}</span><span className="mono faint">{ticketMeta(t)}{t.techId ? ` · ${(users.get(t.techId)?.displayName ?? '').toUpperCase()}` : ''}</span></span>
              <StatusStamp t={t} />
            </button>
          ))}
        </section>
      )}
    </Dialog>
  );
}
