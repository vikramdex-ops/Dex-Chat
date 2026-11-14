// Slash commands typed in the Dock. Built-in ones act inside the app; anything else that an
// integration registered goes to the hub, which calls that tool's webhook.
import type { Availability, SlashCommand, WorkMode } from '@dex/core';
import { startCall } from '../rooms/engine.ts';
import { setWork, workOf } from '../work/store.ts';

export interface CommandInfo { command: string; hint: string; description: string; bot?: boolean }

export const BUILT_INS: CommandInfo[] = [
  { command: 'remind', hint: 'in 30m Call the client', description: 'Set a reminder (in 20m, in 2h, tomorrow, monday, at 5pm)' },
  { command: 'poll', hint: 'Lunch? | Dosa | Biryani', description: 'Ask a question with choices' },
  { command: 'meet', hint: '', description: 'Plan a meeting with the people here' },
  { command: 'call', hint: '', description: 'Start a voice call here' },
  { command: 'video', hint: '', description: 'Start a video call here' },
  { command: 'schedule', hint: '', description: 'Send what you are writing later' },
  { command: 'status', hint: 'At the site till 3', description: 'Set (or clear) your status message' },
  { command: 'available', hint: '', description: 'Show me as available' },
  { command: 'busy', hint: '', description: 'Show me as busy' },
  { command: 'dnd', hint: '', description: 'Do not disturb: no notifications' },
  { command: 'invisible', hint: '', description: 'Appear offline' },
  { command: 'checkin', hint: 'home', description: 'Check in (office, home, site or client)' },
  { command: 'checkout', hint: '', description: 'Check out for the day' },
  { command: 'break', hint: '', description: 'Start or end a break' },
  { command: 'me', hint: 'is reviewing the isometrics', description: 'Say what you are doing, in italics' },
  { command: 'shrug', hint: 'no idea', description: 'Add ¯\\_(ツ)_/¯' },
  { command: 'help', hint: '', description: 'List the commands' },
];

let botCommands: SlashCommand[] = [];
let fetchedAt = 0;
export async function loadBotCommands(): Promise<CommandInfo[]> {
  if (Date.now() - fetchedAt > 60_000) {
    try { botCommands = await window.dex.request('cmd.list'); fetchedAt = Date.now(); } catch { /* offline: keep the last list */ }
  }
  return botCommands.map((c) => ({ command: c.command, hint: '', description: c.description, bot: true }));
}

/** "in 30m", "in 2 hours", "tomorrow", "monday", "at 5pm", "at 17:30" -> time and the rest of the text. */
export function parseWhen(input: string, now = new Date()): { at: number; rest: string } | null {
  const s = input.trim();
  let m = s.match(/^in\s+(\d{1,4})\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\b\s*(.*)$/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2][0].toLowerCase();
    return { at: now.getTime() + n * (unit === 'm' ? 60_000 : unit === 'h' ? 3600_000 : 86400_000), rest: m[3] };
  }
  const at = (d: Date, h: number, min: number) => { const x = new Date(d); x.setHours(h, min, 0, 0); return x; };
  const clock = (t: string): [number, number] | null => {
    const c = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!c) return null;
    let h = Number(c[1]);
    const min = Number(c[2] ?? 0);
    if (c[3]) { const pm = c[3].toLowerCase() === 'pm'; if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
    return h < 24 && min < 60 ? [h, min] : null;
  };
  m = s.match(/^tomorrow(?:\s+at\s+(\S+(?:\s*[ap]m)?))?\b\s*(.*)$/i);
  if (m) {
    const d = new Date(now); d.setDate(d.getDate() + 1);
    const t = m[1] ? clock(m[1]) : [9, 30] as [number, number];
    if (!t) return null;
    return { at: at(d, t[0], t[1]).getTime(), rest: m[2] };
  }
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  m = s.match(/^(sun|mon|tue|wed|thu|fri|sat)[a-z]*(?:\s+at\s+(\S+(?:\s*[ap]m)?))?\b\s*(.*)$/i);
  if (m) {
    const target = days.findIndex((d) => d.startsWith(m![1].toLowerCase()));
    const d = new Date(now);
    d.setDate(d.getDate() + (((target - d.getDay() + 7) % 7) || 7));
    const t = m[2] ? clock(m[2]) : [9, 30] as [number, number];
    if (!t) return null;
    return { at: at(d, t[0], t[1]).getTime(), rest: m[3] };
  }
  m = s.match(/^at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b\s*(.*)$/i);
  if (m) {
    const t = clock(m[1].replace(/\s+/g, ''));
    if (!t) return null;
    let d = at(now, t[0], t[1]);
    if (d.getTime() <= now.getTime()) { d = new Date(d); d.setDate(d.getDate() + 1); }
    return { at: d.getTime(), rest: m[2] };
  }
  return null;
}

export interface RunContext {
  convId: string;
  parentId: string | null;
  displayName: string;
  meId: string;
  send: (body: string) => void;
  toast: (text: string, bad?: boolean) => void;
  open: (dialog: 'poll' | 'schedule' | 'meet' | 'remind' | 'help', seed?: string) => void;
}

/** Run a slash command. Returns false when it is not one (send the text as a message). */
export async function runSlash(input: string, ctx: RunContext): Promise<boolean> {
  const m = input.match(/^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i);
  if (!m || input.startsWith('//')) return false;
  const cmd = m[1].toLowerCase();
  const arg = (m[2] ?? '').trim();
  const req = window.dex.request;
  const avail = (a: Availability, label: string) => req('me.update', { availability: a }).then(() => ctx.toast(`You're now shown as ${label}`));
  try {
    switch (cmd) {
      case 'shrug': ctx.send(`${arg ? `${arg} ` : ''}${String.raw`¯\\\_(ツ)\_/¯`}`); return true;
      case 'me': if (!arg) { ctx.toast('Write what you are doing after /me', true); return true; } ctx.send(`_${ctx.displayName} ${arg}_`); return true;
      case 'status': await req('me.update', { statusText: arg || null }); ctx.toast(arg ? 'Status updated' : 'Status cleared'); return true;
      case 'available': await avail('available', 'available'); return true;
      case 'busy': await avail('busy', 'busy'); return true;
      case 'dnd': await avail('dnd', 'do not disturb'); return true;
      case 'invisible': await avail('invisible', 'invisible'); return true;
      case 'checkin': {
        const mode = (['office', 'home', 'site', 'client'] as WorkMode[]).find((x) => arg.toLowerCase().startsWith(x)) ?? (/wfh|remote/i.test(arg) ? 'home' : 'office');
        setWork(await req('work.checkIn', { mode }));
        ctx.toast(`Checked in (${mode})`);
        return true;
      }
      case 'checkout': setWork(await req('work.checkOut')); ctx.toast('Checked out'); return true;
      case 'break': {
        const onBreak = workOf(ctx.meId)?.status === 'break';
        setWork(await req('work.break', { on: !onBreak }));
        ctx.toast(onBreak ? 'Welcome back' : 'Enjoy your break');
        return true;
      }
      case 'call': case 'video': await startCall(ctx.convId, cmd === 'video'); return true;
      case 'poll': {
        const parts = arg.split('|').map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 3) {
          await req('poll.create', { convId: ctx.convId, question: parts[0], options: parts.slice(1), parentId: ctx.parentId ?? undefined, clientId: `poll-${Date.now().toString(36)}` });
        } else ctx.open('poll', arg);
        return true;
      }
      case 'remind': {
        const when = parseWhen(arg);
        if (when && when.rest.trim()) {
          await req('remind.create', { text: when.rest.trim(), dueAt: when.at });
          ctx.toast(`Reminder set for ${new Date(when.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`);
        } else ctx.open('remind', arg);
        return true;
      }
      case 'meet': ctx.open('meet'); return true;
      case 'schedule': ctx.open('schedule'); return true;
      case 'help': ctx.open('help'); return true;
    }
    const bots = await loadBotCommands();
    if (bots.some((b) => b.command === cmd)) {
      const r = await req('cmd.run', { convId: ctx.convId, command: cmd, text: arg, parentId: ctx.parentId ?? undefined });
      if (r.ephemeral && r.text) ctx.toast(r.text);
      return true;
    }
    ctx.toast(`There is no /${cmd} command. Type /help to see them, or start with // to send a slash.`, true);
    return true;
  } catch (e) {
    ctx.toast((e as Error).message, true);
    return true;
  }
}
