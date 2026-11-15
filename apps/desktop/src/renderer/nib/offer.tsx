// "Add to my day sheet", offered in place under a message that reads like work given to you: a
// Direct message, or an @mention in a Space or side-track, from a colleague, written today, with a
// request in it ("please check the GA for P-12 by Friday"). It runs in your app, on the text as your
// app shows it (Direct messages only once decrypted on this device). Once per message; × hides it.
import { useState } from 'react';
import type { Conversation, Message, PublicUser } from '@dex/core';
import { Icon, useToast } from '../ui.tsx';
import { nibSave, readWords, useNib } from './store.ts';
import { firstName, qtyWords } from './words.ts';

const REQUEST = /\b(?:please|pls|plz|kindly|can you|could you|would you|need you to|need (?:it|this|them)|by (?:today|tomorrow|tmrw|eod|mon|tue|wed|thu|fri|sat|end of)|take (?:this|it) up|look into|kar (?:do|dena|dijiye|lo)|bhej (?:do|dena)|dekh (?:lo|lena)|chahiye)\b/i;
const WORK = /\b(?:check|prepare|send|update|revise|issue|complete|finish|review|model|route|draw|mark ?up|markup|take off|isos?|isometrics?|sheets?|drawings?|dwgs?|gas?|mtos?|line ?list|spools?|supports?|bom|report|calc(?:ulation)?s?|stress)\b/i;
const KEY = 'dex-nib-offers-hidden';
let hidden: Set<string> | null = null;
const hiddenSet = (): Set<string> => {
  if (hidden) return hidden;
  try { hidden = new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]); } catch { hidden = new Set(); }
  return hidden;
};
const hide = (id: string) => { const s = hiddenSet(); s.add(id); try { localStorage.setItem(KEY, JSON.stringify([...s].slice(-300))); } catch { /* storage off */ } };

export function NibOffer({ m, conv, meId, users }: { m: Message; conv: Conversation; meId: string; users: Map<string, PublicUser> }) {
  const me = useNib((s) => s.me);
  const toast = useToast();
  const [gone, setGone] = useState(false);
  if (!me || !me.enabled || me.exempt || gone) return null;
  if (m.authorId === meId || m.deleted || !m.body || m.e2e === 'locked' || m.nib || m.system || m.poll || m.form) return null;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  if (m.createdAt < start.getTime()) return null;
  const author = users.get(m.authorId);
  if (!author || author.role === 'bot' || author.role === 'guest') return null;
  const direct = conv.kind === 'direct' && conv.members.length === 2;
  if (!direct && !m.mentions.includes(meId)) return null;
  const taken = me.items.find((x) => x.messageId === m.id);
  if (taken) return <div className="nib-offer done" role="note"><Icon name="check" size={13} /><span>On your day sheet</span></div>;
  if (hiddenSet().has(m.id)) return null;
  const mine = firstName(users.get(meId)?.displayName ?? '').replace(/[.*+?^${}()|[\]\\]/g, '');
  // "Karthik, please check…": the greeting is not part of the work
  const text = m.body.replace(/<@[\w-]+>/g, ' ').replace(/[*_~`>#]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(mine ? new RegExp(`^(?:hi |hey |dear )?${mine}\\b[,:!]?\\s*`, 'i') : /^$/, '').replace(/^(?:hi|hey|hello)[,!]?\s+/i, '');
  if (!REQUEST.test(text) || !WORK.test(text)) return null;
  const p = readWords(text);
  const giver = p.giver?.id && p.giver.id !== meId ? p.giver.id : author.id;
  const bits = [p.project, qtyWords(p.qty), p.due ? new Date(`${p.due}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : null].filter(Boolean).join(' · ');
  const add = () => void nibSave({ giverId: giver, project: p.project, activity: (p.activity || text).slice(0, 160), qty: p.qty, note: p.note, status: 'going', due: p.due, source: 'offer', messageId: m.id })
    .then(() => toast(`On your day sheet, from ${firstName(users.get(giver)?.displayName ?? '')}`)).catch((e: Error) => toast(e.message, true));
  return (
    <div className="nib-offer" role="group" aria-label="Nib">
      <button className="nib-offer-add" onClick={add}>
        <Icon name="daysheet" size={14} /><span>Add to my day sheet</span>
        {bits && <span className="mono faint" translate="no">{bits}</span>}
      </button>
      <button className="icon-btn sm" aria-label="Don’t offer this one" title="Don’t offer this one" onClick={() => { hide(m.id); setGone(true); }}><Icon name="x" size={12} /></button>
    </div>
  );
}
