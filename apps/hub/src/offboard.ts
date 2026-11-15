// Offboarding: someone leaves the office. In one step an administrator signs them out everywhere
// (every device revoked, pairing codes and their calendar feed stopped), hands what they looked
// after to a colleague, and marks them "Left the office" in the Directory.
//
// Handed over: Spaces they created or moderated, automations, integrations they set up and tools
// they uploaded, reminders they set for others (and open ones others set for them), meetings they
// organise in the future (moved to the colleague, or cancelled, with a note to everyone invited),
// help tickets, and webinars they organise. Scheduled messages are cancelled. Their messages stay
// exactly where they are, so the office's retention rules and any legal hold apply as before.
//
// Giving access back (re-activating) re-approves the devices offboarding signed out. What was
// handed over stays with the colleague. Every step is in the audit log.
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '@dex/core';
import type { Departure, LeftPerson, MeetingHandover, OffboardPreview, OffboardSummary, PublicUser, Recurrence } from '@dex/core';
import type { Store } from './store.ts';
import type { Messaging } from './messaging.ts';
import type { Calendar } from './calendar.ts';
import type { HelpDesk } from './helpdesk.ts';
import type { CalendarFeeds } from './calfeed.ts';
import type { SystemBot } from './systembot.ts';

export class OffboardError extends Error {}

export interface OffboardHost {
  store: Store;
  messaging: Messaging;
  calendar: Calendar;
  helpdesk: HelpDesk;
  feeds: CalendarFeeds;
  system: SystemBot;
  /** Close every connection of this person now (and the file links they were using). */
  signOut: (userId: string, reason: string) => void;
  /** An event to everyone signed in, or to administrators only. */
  broadcast: (name: string, data: unknown, adminsOnly?: boolean) => void;
  /** Can this person use the office now (an approved device)? */
  active: (userId: string) => boolean;
}

interface DepartureRow { id: string; user_id: string; left_at: number; by_id: string; to_id: string; meetings: string; note: string | null; summary: string; devices: string; returned_at: number | null; returned_by: string | null }
interface EventRow { id: string; title: string; start_at: number; end_at: number; all_day: number; recurrence: Recurrence; until_at: number | null; organizer_id: string }

const isAdminRole = (r: PublicUser['role']) => r === 'owner' || r === 'admin';
const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

function when(e: Pick<EventRow, 'start_at' | 'end_at' | 'all_day' | 'recurrence'>, now: number): string {
  const repeats = e.recurrence !== 'none';
  const date = new Date(e.start_at).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  const time = e.all_day ? 'all day' : new Date(e.start_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  if (repeats && e.start_at < now) return `repeating, ${e.recurrence === 'weekdays' ? 'every weekday' : e.recurrence} at ${time}`;
  return `${date}, ${time}${repeats ? `, repeating ${e.recurrence === 'weekdays' ? 'every weekday' : e.recurrence}` : ''}`;
}

export class Offboarding {
  private readonly h: OffboardHost;
  private readonly db: DatabaseSync;

  constructor(host: OffboardHost) {
    this.h = host;
    this.db = host.store.db;
  }

  /** The departure in force for someone (not yet given access back). */
  private current(userId: string): DepartureRow | undefined {
    return this.db.prepare('SELECT * FROM departures WHERE user_id = ? AND returned_at IS NULL ORDER BY left_at DESC LIMIT 1').get(userId) as DepartureRow | undefined;
  }

  hasLeft(userId: string): boolean { return !!this.current(userId); }

  private view(r: DepartureRow): Departure {
    let summary: OffboardSummary;
    try { summary = JSON.parse(r.summary) as OffboardSummary; } catch { summary = {} as OffboardSummary; }
    return {
      id: r.id, user: this.h.store.userById(r.user_id)!, leftAt: r.left_at, by: r.by_id, toId: r.to_id,
      meetings: r.meetings === 'cancel' ? 'cancel' : 'reassign', note: r.note, summary, returnedAt: r.returned_at,
    };
  }

  // ------------------------------------------------------------ what they look after
  private futureMeetings(userId: string, now: number): EventRow[] {
    return this.db.prepare(`SELECT id, title, start_at, end_at, all_day, recurrence, until_at, organizer_id FROM events
      WHERE organizer_id = ? AND cancelled = 0 AND (start_at > ? OR (recurrence != 'none' AND (until_at IS NULL OR until_at > ?)))
      ORDER BY start_at`).all(userId, now, now) as unknown as EventRow[];
  }

  private webinars(userId: string): Array<{ id: string; title: string; host_id: string; co_hosts: string; conv_id: string | null; starts_at: number }> {
    return (this.db.prepare(`SELECT m.id, m.title, m.host_id, m.co_hosts, m.conv_id, w.starts_at FROM meetings m JOIN webinars w ON w.meeting_id = m.id
      WHERE m.kind = 'webinar' AND w.state != 'ended' AND (m.host_id = ? OR m.co_hosts LIKE ?) ORDER BY w.starts_at`).all(userId, `%"${userId}"%`) as Array<{ id: string; title: string; host_id: string; co_hosts: string; conv_id: string | null; starts_at: number }>)
      .filter((w) => w.host_id === userId || this.coHosts(w.co_hosts).includes(userId));
  }

  private coHosts(raw: string): string[] {
    try { const v = JSON.parse(raw) as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
  }

  private hasTable(name: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  }

  preview(me: PublicUser, userId: unknown, now = Date.now()): OffboardPreview {
    const u = this.target(me, userId);
    const id = u.id;
    const spaces = (sql: string, ...args: string[]) => (this.db.prepare(sql).all(...args) as Array<{ id: string; name: string | null }>).map((r) => ({ id: r.id, name: r.name ?? 'Space' }));
    const flows = this.db.prepare(`SELECT f.id, f.name, f.conv_id, c.kind FROM flows f LEFT JOIN conversations c ON c.id = f.conv_id WHERE f.owner_id = ? ORDER BY f.name`).all(id) as Array<{ id: string; name: string; conv_id: string | null; kind: string | null }>;
    const holds = this.hasTable('legal_holds') && !!this.db.prepare(`SELECT 1 FROM legal_holds WHERE kind = 'user' AND target_id = ? LIMIT 1`).get(id);
    return {
      user: u,
      devices: this.h.store.devices().filter((d) => d.userId === id && (d.status === 'approved' || d.status === 'pending')).map((d) => ({ id: d.id, hostname: d.hostname, lastSeen: d.lastSeen })),
      pairingCodes: (this.db.prepare('SELECT COUNT(*) AS n FROM pair_tokens WHERE user_id = ? AND used_at IS NULL AND expires_at > ?').get(id, now) as { n: number }).n,
      spacesOwned: spaces(`SELECT id, name FROM conversations WHERE kind = 'space' AND created_by = ? ORDER BY name COLLATE NOCASE`, id),
      spacesModerated: spaces(`SELECT c.id, c.name FROM conv_members cm JOIN conversations c ON c.id = cm.conv_id
        WHERE cm.user_id = ? AND cm.moderator = 1 AND c.kind = 'space' AND c.created_by != ? ORDER BY c.name COLLATE NOCASE`, id, id),
      automations: flows.map((f) => ({ id: f.id, name: f.name, where: !f.conv_id ? 'office' : f.kind === 'direct' ? 'direct' : 'space' })),
      bots: (this.db.prepare(`SELECT DISTINCT u.id, u.display_name FROM users u WHERE u.role = 'bot' AND (
          EXISTS (SELECT 1 FROM bot_tokens t WHERE t.user_id = u.id AND t.created_by = ?) OR EXISTS (SELECT 1 FROM hooks h WHERE h.bot_id = u.id AND h.created_by = ?))
        ORDER BY u.display_name`).all(id, id) as Array<{ id: string; display_name: string }>).map((b) => ({ id: b.id, name: b.display_name })),
      tools: (this.db.prepare(`SELECT id, name FROM miniapps WHERE uploaded_by = ? AND builtin = 0 ORDER BY name`).all(id) as Array<{ id: string; name: string }>),
      scheduled: (this.db.prepare('SELECT COUNT(*) AS n FROM scheduled WHERE user_id = ?').get(id) as { n: number }).n,
      remindersForOthers: (this.db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE created_by = ? AND user_id != ? AND done_at IS NULL').get(id, id) as { n: number }).n,
      remindersFromOthers: (this.db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND created_by != ? AND done_at IS NULL').get(id, id) as { n: number }).n,
      meetings: this.futureMeetings(id, now).map((e) => ({ id: e.id, title: e.title, startAt: e.start_at, repeats: e.recurrence !== 'none' })),
      tickets: (this.db.prepare(`SELECT id, number, summary, CASE WHEN tech_id = ? THEN 'technician' ELSE 'requester' END AS role FROM help_tickets
        WHERE status != 'closed' AND (tech_id = ? OR requester_id = ?) ORDER BY number`).all(id, id, id) as Array<{ id: string; number: number; summary: string; role: 'technician' | 'requester' }>),
      webinars: this.webinars(id).map((w) => ({ meetingId: w.id, title: w.title, startsAt: w.starts_at, role: w.host_id === id ? 'organiser' : 'co-organiser' })),
      messages: (this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE author_id = ? AND deleted = 0').get(id) as { n: number }).n,
      onHold: holds,
    };
  }

  /** Who may be offboarded, by whom. */
  private target(me: PublicUser, userId: unknown): PublicUser {
    if (!isAdminRole(me.role)) throw new OffboardError('Only administrators can do that.');
    const u = typeof userId === 'string' ? this.h.store.userById(userId) : null;
    if (!u || u.role === 'bot') throw new OffboardError('Person not found.');
    if (u.id === me.id) throw new OffboardError('You cannot offboard yourself. Ask another administrator.');
    if (u.role === 'owner') throw new OffboardError('The workspace owner cannot be offboarded.');
    if (u.role === 'admin' && me.role !== 'owner') throw new OffboardError('Only the owner can offboard an administrator.');
    return u;
  }

  // ------------------------------------------------------------ offboarding
  run(me: PublicUser, d: Record<string, unknown>, now = Date.now()): Departure {
    const u = this.target(me, d.userId);
    if (this.current(u.id)) throw new OffboardError(`${u.displayName} has already left the office.`);
    const to = typeof d.toUserId === 'string' ? this.h.store.userById(d.toUserId) : null;
    if (!to || to.id === u.id || to.role === 'bot') throw new OffboardError('Choose the colleague who takes over.');
    if (to.role === 'guest') throw new OffboardError('A guest cannot take over. Choose a member of the office.');
    if (this.current(to.id) || !this.h.active(to.id)) throw new OffboardError(`${to.displayName} cannot use Dexterity Connect now. Choose someone who can.`);
    const mode: MeetingHandover = d.meetings === 'cancel' ? 'cancel' : 'reassign';
    const note = clean(d.note, 300) || null;
    const why = `${u.displayName} has left the office.`;
    const audit = (action: string, target: string | null, detail: unknown) => this.h.store.audit(me.id, action, target, detail);
    const s: OffboardSummary = {
      devicesSignedOut: 0, pairingCodesRevoked: 0, spaces: 0, moderated: 0, automations: 0, automationsTurnedOff: 0, bots: 0, tools: 0,
      scheduledCancelled: 0, reminders: 0, meetingsReassigned: 0, meetingsCancelled: 0, tickets: 0, ticketsClosed: 0, webinars: 0, calendarFeed: false,
    };

    // 1. signed out everywhere: devices revoked, pairing codes and the calendar feed stopped
    const revoked: string[] = [];
    for (const dev of this.h.store.devices().filter((x) => x.userId === u.id && (x.status === 'approved' || x.status === 'pending'))) {
      const updated = this.h.store.setDeviceStatus(dev.id, dev.status === 'approved' ? 'revoked' : 'rejected', me.id);
      if (dev.status === 'approved') revoked.push(dev.id);
      audit('device.revoked', dev.id, { account: dev.account, hostname: dev.hostname, offboarding: true });
      this.h.broadcast('device.updated', updated, true);
    }
    s.devicesSignedOut = revoked.length;
    s.pairingCodesRevoked = Number(this.db.prepare('DELETE FROM pair_tokens WHERE user_id = ? AND used_at IS NULL').run(u.id).changes);
    s.calendarFeed = this.h.feeds.revoke(u.id);
    this.h.signOut(u.id, 'You have been signed out: an administrator recorded that you have left the office.');

    // 2. Spaces they created or moderate
    const owned = this.db.prepare(`SELECT id FROM conversations WHERE kind = 'space' AND created_by = ?`).all(u.id) as Array<{ id: string }>;
    for (const c of owned) {
      this.db.prepare('UPDATE conversations SET created_by = ? WHERE id = ?').run(to.id, c.id);
      this.h.messaging.ensureMember(c.id, to.id);
      this.h.messaging.pushConvTo(c.id);
    }
    const moderated = this.db.prepare(`SELECT cm.conv_id AS id FROM conv_members cm JOIN conversations c ON c.id = cm.conv_id WHERE cm.user_id = ? AND cm.moderator = 1 AND c.kind = 'space'`).all(u.id) as Array<{ id: string }>;
    for (const c of moderated) {
      this.db.prepare('UPDATE conv_members SET moderator = 0 WHERE conv_id = ? AND user_id = ?').run(c.id, u.id);
      this.h.messaging.ensureMember(c.id, to.id);
      this.db.prepare('UPDATE conv_members SET moderator = 1 WHERE conv_id = ? AND user_id = ?').run(c.id, to.id);
      this.h.messaging.pushConvTo(c.id);
    }
    s.spaces = owned.length;
    s.moderated = moderated.filter((m) => !owned.some((o) => o.id === m.id)).length;
    if (owned.length || moderated.length) audit('handover.spaces', u.id, { to: to.id, owned: owned.map((c) => c.id), moderated: moderated.map((c) => c.id) });

    // 3. automations: a Space's and the office's go to the colleague; personal ones (in a Direct) are turned off
    const flows = this.db.prepare(`SELECT f.id, f.conv_id, c.kind FROM flows f LEFT JOIN conversations c ON c.id = f.conv_id WHERE f.owner_id = ?`).all(u.id) as Array<{ id: string; conv_id: string | null; kind: string | null }>;
    const flowsTo: Record<string, string> = {};
    const flowsOff: string[] = [];
    for (const f of flows) {
      if (f.conv_id && f.kind !== 'space') {
        this.db.prepare('UPDATE flows SET enabled = 0, updated_at = ?, updated_by = ? WHERE id = ?').run(now, me.id, f.id);
        flowsOff.push(f.id);
        continue;
      }
      // office-wide rules act for an administrator
      const owner = !f.conv_id && !isAdminRole(to.role) ? me.id : to.id;
      if (f.conv_id) this.h.messaging.ensureMember(f.conv_id, owner);
      this.db.prepare('UPDATE flows SET owner_id = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(owner, now, me.id, f.id);
      flowsTo[f.id] = owner;
    }
    s.automations = Object.keys(flowsTo).length;
    s.automationsTurnedOff = flowsOff.length;
    if (flows.length) audit('handover.automations', u.id, { to: flowsTo, turnedOff: flowsOff });

    // 4. integrations they set up and tools they uploaded
    const bots = this.db.prepare(`SELECT DISTINCT user_id AS id FROM bot_tokens WHERE created_by = ? UNION SELECT DISTINCT bot_id AS id FROM hooks WHERE created_by = ?`).all(u.id, u.id) as Array<{ id: string }>;
    this.db.prepare('UPDATE bot_tokens SET created_by = ? WHERE created_by = ?').run(to.id, u.id);
    this.db.prepare('UPDATE hooks SET created_by = ? WHERE created_by = ?').run(to.id, u.id);
    const tools = this.db.prepare('SELECT id FROM miniapps WHERE uploaded_by = ? AND builtin = 0').all(u.id) as Array<{ id: string }>;
    this.db.prepare('UPDATE miniapps SET uploaded_by = ? WHERE uploaded_by = ? AND builtin = 0').run(to.id, u.id);
    s.bots = bots.length;
    s.tools = tools.length;
    if (bots.length || tools.length) audit('handover.integrations', u.id, { to: to.id, bots: bots.map((b) => b.id), tools: tools.map((t) => t.id) });

    // 5. scheduled messages are cancelled; reminders for and from others move to the colleague
    const scheduled = this.db.prepare('SELECT id FROM scheduled WHERE user_id = ?').all(u.id) as Array<{ id: string }>;
    this.db.prepare('DELETE FROM scheduled WHERE user_id = ?').run(u.id);
    s.scheduledCancelled = scheduled.length;
    if (scheduled.length) audit('handover.scheduled', u.id, { cancelled: scheduled.map((x) => x.id) });
    const forOthers = this.db.prepare('UPDATE reminders SET created_by = ? WHERE created_by = ? AND user_id != ? AND done_at IS NULL').run(to.id, u.id, u.id).changes;
    const fromOthers = this.db.prepare('UPDATE reminders SET user_id = ? WHERE user_id = ? AND created_by != ? AND done_at IS NULL').run(to.id, u.id, u.id).changes;
    s.reminders = Number(forOthers) + Number(fromOthers);
    if (s.reminders) audit('handover.reminders', u.id, { to: to.id, setForOthers: forOthers, setByOthers: fromOthers });

    // 6. meetings they organise from now on: moved to the colleague, or cancelled; everyone invited is told
    const moved: string[] = [];
    const cancelled: string[] = [];
    for (const e of this.futureMeetings(u.id, now)) {
      const invited = (this.db.prepare('SELECT user_id FROM event_attendees WHERE event_id = ? AND user_id != ?').all(e.id, u.id) as Array<{ user_id: string }>).map((r) => r.user_id);
      const label = `**${e.title}** (${when(e, now)})`;
      if (mode === 'reassign') {
        this.db.prepare('UPDATE events SET organizer_id = ? WHERE id = ?').run(to.id, e.id);
        this.db.prepare(`INSERT INTO event_attendees (event_id, user_id, response) VALUES (?, ?, 'yes') ON CONFLICT(event_id, user_id) DO UPDATE SET response = 'yes'`).run(e.id, to.id);
        this.db.prepare('DELETE FROM event_attendees WHERE event_id = ? AND user_id = ?').run(e.id, u.id);
        const m = this.db.prepare('SELECT id, co_hosts FROM meetings WHERE event_id = ?').get(e.id) as { id: string; co_hosts: string } | undefined;
        if (m) this.db.prepare('UPDATE meetings SET host_id = ?, co_hosts = ? WHERE id = ?').run(to.id, JSON.stringify(this.coHosts(m.co_hosts).filter((x) => x !== u.id && x !== to.id)), m.id);
        this.h.calendar.touch(e.id, now);
        this.h.calendar.pushEvent(e.id, [u.id]);
        for (const p of invited.filter((x) => x !== to.id)) this.h.system.tell(p, `${label} is now organised by **${to.displayName}**: ${why}`, `offboard-move-${e.id}-${now}`);
        moved.push(e.id);
      } else {
        // a series that already began keeps its past meetings and stops now
        if (e.recurrence !== 'none' && e.start_at <= now) this.db.prepare('UPDATE events SET until_at = ? WHERE id = ?').run(now, e.id);
        else this.db.prepare('UPDATE events SET cancelled = 1 WHERE id = ?').run(e.id);
        this.h.calendar.touch(e.id, now);
        this.h.calendar.pushEvent(e.id);
        for (const p of invited) this.h.system.tell(p, `${label} is cancelled: ${why} Ask **${to.displayName}** if it should still go ahead.`, `offboard-cancel-${e.id}-${now}`);
        cancelled.push(e.id);
      }
    }
    s.meetingsReassigned = moved.length;
    s.meetingsCancelled = cancelled.length;
    if (moved.length || cancelled.length) audit('handover.meetings', u.id, { to: to.id, mode, moved, cancelled });

    // 7. help tickets
    const help = this.h.helpdesk.handOver(u.id, to.id, me.id, why);
    s.tickets = help.moved.length + help.released.length;
    s.ticketsClosed = help.closed.length;
    if (s.tickets || s.ticketsClosed) audit('handover.tickets', u.id, { to: to.id, ...help });

    // 8. webinars they organise
    const webinars = this.webinars(u.id);
    for (const w of webinars) {
      const host = w.host_id === u.id ? to.id : w.host_id;
      const co = [...new Set(this.coHosts(w.co_hosts).map((x) => (x === u.id ? to.id : x)))].filter((x) => x !== host);
      this.db.prepare('UPDATE meetings SET host_id = ?, co_hosts = ? WHERE id = ?').run(host, JSON.stringify(co), w.id);
      if (w.conv_id) this.h.messaging.ensureMember(w.conv_id, to.id);
    }
    s.webinars = webinars.length;
    if (webinars.length) audit('handover.webinars', u.id, { to: to.id, webinars: webinars.map((w) => w.id) });

    // 9. the departure itself: "Left the office" in the Directory
    const id = ulid();
    this.db.prepare(`INSERT INTO departures (id, user_id, left_at, by_id, to_id, meetings, note, summary, devices) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, u.id, now, me.id, to.id, mode, note, JSON.stringify(s), JSON.stringify(revoked));
    audit('person.offboarded', u.id, { account: u.account, to: to.id, meetings: mode, note, summary: s });
    const dep = this.view(this.current(u.id)!);
    this.h.broadcast('user.left', { userId: u.id, leftAt: now, contactId: to.id });
    this.h.broadcast('admin.offboarded', dep, true);

    const lines = [
      s.spaces + s.moderated ? `- ${s.spaces + s.moderated} Space${s.spaces + s.moderated === 1 ? '' : 's'} to look after` : '',
      s.automations ? `- ${s.automations} automation${s.automations === 1 ? '' : 's'}` : '',
      s.bots + s.tools ? `- ${s.bots + s.tools} integration${s.bots + s.tools === 1 ? '' : 's'} and tool${s.bots + s.tools === 1 ? '' : 's'}` : '',
      s.reminders ? `- ${s.reminders} reminder${s.reminders === 1 ? '' : 's'}` : '',
      s.meetingsReassigned ? `- ${s.meetingsReassigned} meeting${s.meetingsReassigned === 1 ? '' : 's'} you now organise` : '',
      help.moved.length ? `- ${help.moved.length} help ticket${help.moved.length === 1 ? '' : 's'}` : '',
      s.webinars ? `- ${s.webinars} webinar${s.webinars === 1 ? '' : 's'} you now organise` : '',
    ].filter(Boolean);
    this.h.system.tell(to.id, `${why} ${me.displayName} asked you to take over from them.${lines.length ? `\n\n${lines.join('\n')}` : ' They had nothing to hand over.'}${note ? `\n\nNote: ${note}` : ''}`, `offboard-to-${id}`);
    return dep;
  }

  // ------------------------------------------------------------ coming back
  reactivate(me: PublicUser, userId: unknown, now = Date.now()): { user: PublicUser; devices: number } {
    if (!isAdminRole(me.role)) throw new OffboardError('Only administrators can do that.');
    const u = typeof userId === 'string' ? this.h.store.userById(userId) : null;
    if (!u) throw new OffboardError('Person not found.');
    const dep = this.current(u.id);
    if (!dep) throw new OffboardError(`${u.displayName} has not left the office.`);
    if (u.role === 'admin' && me.role !== 'owner') throw new OffboardError('Only the owner can give an administrator access again.');
    let ids: string[] = [];
    try { ids = (JSON.parse(dep.devices) as unknown[]).filter((x): x is string => typeof x === 'string'); } catch { /* none */ }
    let restored = 0;
    for (const id of ids) {
      const dev = this.h.store.device(id);
      if (!dev || dev.status !== 'revoked') continue;
      const updated = this.h.store.setDeviceStatus(id, 'approved', me.id);
      this.h.broadcast('device.updated', updated, true);
      restored++;
    }
    this.db.prepare('UPDATE departures SET returned_at = ?, returned_by = ? WHERE id = ?').run(now, me.id, dep.id);
    this.h.store.audit(me.id, 'person.reactivated', u.id, { account: u.account, devices: restored, departure: dep.id });
    const user = this.h.store.userById(u.id)!;
    this.h.broadcast('user.added', user);
    const colleague = this.h.store.userById(dep.to_id);
    this.h.system.tell(u.id, `Welcome back. ${me.displayName} gave you access to Dexterity Connect again.${colleague ? ` What was handed over to **${colleague.displayName}** when you left stays with them.` : ''}${restored ? '' : ' Your devices were removed, so join again from your PC; an administrator approves it.'}`, `offboard-back-${dep.id}`);
    return { user, devices: restored };
  }

  // ------------------------------------------------------------ lists
  list(me: PublicUser): Departure[] {
    if (!isAdminRole(me.role)) throw new OffboardError('Only administrators can do that.');
    return (this.db.prepare('SELECT * FROM departures ORDER BY left_at DESC LIMIT 200').all() as unknown as DepartureRow[])
      .filter((r) => !!this.h.store.userById(r.user_id)).map((r) => this.view(r));
  }

  /** The Directory's "Left the office": everyone but guests sees who left and who to ask instead. */
  left(me: PublicUser): LeftPerson[] {
    if (me.role === 'guest' || me.role === 'bot') return [];
    return (this.db.prepare('SELECT * FROM departures WHERE returned_at IS NULL ORDER BY left_at DESC LIMIT 500').all() as unknown as DepartureRow[])
      .map((r) => ({ user: this.h.store.userById(r.user_id), leftAt: r.left_at, contactId: r.to_id }))
      .filter((x): x is LeftPerson => !!x.user);
  }

  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    switch (op) {
      case 'admin.offboard.preview': return this.preview(me, d.userId);
      case 'admin.offboard.run': return this.run(me, d);
      case 'admin.offboard.list': return this.list(me);
      case 'admin.offboard.reactivate': return this.reactivate(me, d.userId);
      case 'directory.left': return this.left(me);
    }
    return undefined;
  }
}
