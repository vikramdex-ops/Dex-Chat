// Pieces the notice board's screens share: words for categories and states, dates, the audience
// in words, a notice's text in the reader's language, the revision cloud (a scalloped outline
// drawn in code round a changed paragraph, with its revision triangle) and the acknowledgement stamp.
import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Department, NoticeAudience, NoticeCategory, NoticeLang, NoticeRevision, NoticeStatus, NoticeRevStatus, NoticeSummary, PublicUser } from '@dex/core';
import { language } from '../i18n/index.ts';

export const CAT_LABEL: Record<NoticeCategory, string> = {
  policy: 'Policy', notice: 'Notice', circular: 'Circular', holiday: 'Holiday', it: 'IT advisory', safety: 'Safety', event: 'Event',
};
export const CATEGORY_ORDER: NoticeCategory[] = ['policy', 'notice', 'circular', 'holiday', 'it', 'safety', 'event'];
export const STATUS_LABEL: Record<NoticeStatus | NoticeRevStatus, string> = {
  draft: 'Draft', scheduled: 'Scheduled', issued: 'Issued', withdrawn: 'Withdrawn', expired: 'Expired', superseded: 'Superseded',
};
export const LANG_NAME: Record<'en' | NoticeLang, string> = { en: 'English', hi: 'हिन्दी', ta: 'தமிழ்' };

export const dateText = (t: number | null | undefined): string => (t ? new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const dateTimeText = (t: number | null | undefined): string => (t ? new Date(t).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

/** The reader's language when the author wrote a version in it, else the original. */
export function readingLang(langs: NoticeLang[]): 'en' | NoticeLang {
  const l = language();
  return (l === 'hi' || l === 'ta') && langs.includes(l) ? l : 'en';
}
/** A register line's title in the reader's language. */
export const titleOf = (n: Pick<NoticeSummary, 'title' | 'titles' | 'langs'>): string => { const l = readingLang(n.langs); return l === 'en' ? n.title : n.titles[l] || n.title; };
/** A revision's text in a language (falling back to the original for what was not translated). */
export function textOf(r: NoticeRevision, lang: 'en' | NoticeLang): { title: string; body: string } {
  if (lang === 'en') return { title: r.title, body: r.body };
  const t = r.translations[lang];
  return { title: t?.title || r.title, body: t?.body || r.body };
}

/** HR-POL-0012 · Rev B, or the number it will get. */
export const refText = (n: Pick<NoticeSummary, 'number' | 'rev'>, next?: string): string => `${n.number ?? next ?? '—'} · Rev ${n.rev}`;

/** Who a notice is for, in words; names of departments and people as they are written. */
export function AudienceWords({ a, departments, users }: { a: NoticeAudience; departments: Department[]; users: Map<string, PublicUser> }) {
  if (a.everyone) return <span>Everyone in the office</span>;
  const deps = a.departments.map((id) => departments.find((d) => d.id === id)?.name).filter((x): x is string => !!x);
  const people = a.people.map((id) => users.get(id)?.displayName).filter((x): x is string => !!x);
  const parts: ReactNode[] = [];
  if (deps.length) parts.push(<span key="d" translate="no">{deps.join(', ')}</span>);
  if (a.roles.includes('admin')) parts.push(<span key="ra">Administrators</span>);
  if (a.roles.includes('member')) parts.push(<span key="rm">Members</span>);
  if (a.locations.length) parts.push(<span key="l" translate="no">{a.locations.join(', ')}</span>);
  if (people.length) parts.push(people.length <= 3 ? <span key="p" translate="no">{people.join(', ')}</span> : <span key="p">{`${people.length} people`}</span>);
  return <>{parts.map((p, i) => <span key={i}>{i ? ' · ' : ''}{p}</span>)}</>;
}

/** How many people an audience reaches now (as the hub works it out), for the composer. */
export function audienceCount(a: NoticeAudience, users: PublicUser[], departments: Department[]): number {
  const deps = new Set(a.departments);
  for (let changed = true, g = 0; changed && g < 50; g++) { changed = false; for (const d of departments) if (d.parentId && deps.has(d.parentId) && !deps.has(d.id)) { deps.add(d.id); changed = true; } }
  return users.filter((u) => {
    if (u.role === 'guest' || u.role === 'bot') return false;
    if (a.everyone || a.people.includes(u.id)) return true;
    if (u.profile.departmentId && deps.has(u.profile.departmentId)) return true;
    const role = u.role === 'owner' ? 'admin' : u.role;
    if ((role === 'admin' || role === 'member') && a.roles.includes(role)) return true;
    const loc = u.profile.location?.trim().toLowerCase();
    return !!loc && a.locations.some((l) => l.trim().toLowerCase() === loc);
  }).length;
}

/** A status as a mono caption in a hairline box; amber only for what needs the reader. */
export function StatusTag({ n }: { n: Pick<NoticeSummary, 'status' | 'needsAck' | 'urgent' | 'acked' | 'ackRequired'> }) {
  if (n.needsAck) return <span className="chip warn">Acknowledge</span>;
  if (n.urgent && n.status === 'issued') return <span className="chip warn">Urgent</span>;
  if (n.status === 'issued' && n.ackRequired && n.acked) return <span className="chip ok">Acknowledged</span>;
  if (n.status === 'issued') return <span className="chip">In force</span>;
  return <span className={`chip nb-st-${n.status}`}>{STATUS_LABEL[n.status]}</span>;
}

/** The scalloped outline of a revision cloud, round a box of w by h (arcs bulge outwards, going clockwise). */
export function cloudPath(w: number, h: number, r = 7): string {
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.round(len / (r * 2)));
    let d = '';
    for (let i = 1; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      const y = y0 + ((y1 - y0) * i) / n;
      const rad = len / n / 2;
      d += ` A${rad.toFixed(1)} ${rad.toFixed(1)} 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    return d;
  };
  return `M0 0${edge(0, 0, w, 0)}${edge(w, 0, w, h)}${edge(w, h, 0, h)}${edge(0, h, 0, 0)}Z`;
}

/** A changed paragraph in a revision cloud, with the revision's triangle. */
export function RevisionCloud({ rev, children }: { rev: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.offsetWidth, h: el.offsetHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pad = 6;
  return (
    <div ref={box} className="nb-cloud">
      {size.w > 0 && (
        <svg className="nb-cloud-line" width={size.w + pad * 2} height={size.h + pad * 2} viewBox={`${-pad} ${-pad} ${size.w + pad * 2} ${size.h + pad * 2}`} aria-hidden="true">
          <path d={cloudPath(size.w, size.h)} />
        </svg>
      )}
      <span className="nb-rev-tri" aria-hidden="true"><svg viewBox="0 0 24 21" aria-hidden="true"><path d="M12 1.5 22.5 19.5h-21z" /></svg><b translate="no">{rev}</b></span>
      <span className="nb-sr">{`Changed in Rev ${rev}.`}</span>
      {children}
    </div>
  );
}

/** The rubber stamp of an acknowledgement: lands once (unless motion is reduced). */
export function AckStamp({ name, at, refLine, landing }: { name: string; at: number; refLine: string; landing: boolean }) {
  return (
    <div className={`nb-stamp${landing ? ' landing' : ''}`} role="img" aria-label={`Acknowledged by ${name} on ${dateText(at)}`}>
      <span className="nb-stamp-head">Read and understood</span>
      <span className="nb-stamp-name" translate="no">{name}</span>
      <span className="nb-stamp-ref mono" translate="no">{`${dateText(at)} · ${refLine}`}</span>
    </div>
  );
}

/** Earlier revisions behind a sheet on the shelf (at most three drawn). */
export const sheetsBehind = (rev: string): number => Math.min(3, rev.length > 1 ? 3 : Math.max(0, rev.charCodeAt(0) - 65));
