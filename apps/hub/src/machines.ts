// Office PCs with the Dexterity Connect IT Support service (docs/HELP-DESK.md, "Elevated control"):
// the service connects as a machine device, proven by its own P-256 key, and is accepted without
// approval (an administrator installed it; Control room ▸ Policies ▸ Remote support can remove it). With the policy
// assistElevated on, IT staff connect to a PC through it: the hub opens a ticket held by the
// technician (for the person signed in to the PC when the hub knows them), relays the PC's screen
// pictures to the technician's device and the technician's input to the PC through the same input
// gate as attended control (rate limit, blocked chords, held keys released), and records every
// session on the ticket and in the audit log. The person at the PC sees a banner the service draws
// on whatever desktop is showing and can stop it; that stop is final for the session.
import type { DatabaseSync } from 'node:sqlite';
import { InputGate, decodeInputBatch } from '@dex/core/assist';
import { decodeFrame, machineIdFor, machineInputs, verifyMachineSignature } from '@dex/core/machine';
import type { ElevatedSession, MachineHello, MachineInfo } from '@dex/core/machine';
import { authPayload, ulid } from '@dex/core';
import type { OfficePolicy, PublicUser } from '@dex/core';
import type { Store } from './store.ts';
import type { HelpDesk } from './helpdesk.ts';

export class MachineError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  hostname TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE TABLE IF NOT EXISTS machine_sessions (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  tech_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  why TEXT
);
`;

/** A connection as the machines need it (the hub's Conn). */
export interface MachineConn {
  deviceId: string | null;
  send(frame: unknown): void;
  close(): void;
}

export interface MachineHost {
  store: Store;
  helpdesk: HelpDesk;
  fingerprint: string;
  policy(): OfficePolicy;
  /** Send an event to one device of a person (the technician's app). */
  toDevice(deviceId: string, name: string, data: unknown): void;
  /** Tell the IT desk the list of PCs changed. */
  tellIt(name: string, data: unknown): void;
  log(level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>): void;
}

interface Live extends ElevatedSession {
  techDevice: string;
  gate: InputGate;
  timer: ReturnType<typeof setTimeout> | null;
  /** Pictures sent and not yet drawn by the technician (at most two in flight). */
  inFlight: number;
  frames: number;
}

interface Online { conn: MachineConn; consoleUser: string | null; locked: boolean }

const oneLine = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

export class Machines {
  private readonly db: DatabaseSync;
  private readonly host: MachineHost;
  private readonly online = new Map<string, Online>();
  /** Sessions by session id. */
  private readonly live = new Map<string, Live>();
  /** How long a session waits for its PC to come back (a restart), with policy assistReconnect. */
  reconnectGraceMs = 10 * 60_000;

  constructor(host: MachineHost) {
    this.host = host;
    this.db = host.store.db;
    this.db.exec(SCHEMA);
    // sessions cut short by a hub restart end where they were
    this.db.prepare(`UPDATE machine_sessions SET ended_at = started_at, why = 'The office hub restarted.' WHERE ended_at IS NULL`).run();
  }

  // ------------------------------------------------------------ the service's side
  /** The service's hello on a fresh websocket. Returns the machine id when it is accepted. */
  hello(conn: MachineConn, nonce: string, f: MachineHello): string | null {
    const reject = (reason: string) => { conn.send({ t: 'rejected', reason }); conn.close(); return null; };
    if (typeof f.publicKey !== 'string' || typeof f.sig !== 'string' || typeof f.id !== 'string') return reject('Malformed hello.');
    const id = machineIdFor(f.publicKey);
    if (id !== f.id) return reject('The id does not match the key.');
    if (!verifyMachineSignature(f.publicKey, authPayload(nonce, this.host.fingerprint, id), f.sig)) return reject('This PC could not prove its identity.');
    const row = this.db.prepare('SELECT public_key, removed_at FROM machines WHERE id = ?').get(id) as { public_key: string; removed_at: number | null } | undefined;
    if (row?.removed_at) return reject('An administrator removed this PC from the office. Reinstall the IT Support service to add it again.');
    const hostname = oneLine(f.hostname, 63) || 'PC';
    const version = oneLine(f.version, 32);
    const now = Date.now();
    if (row) this.db.prepare('UPDATE machines SET hostname = ?, version = ?, last_seen = ? WHERE id = ?').run(hostname, version, now, id);
    else {
      this.db.prepare('INSERT INTO machines (id, public_key, hostname, version, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)').run(id, f.publicKey, hostname, version, now, now);
      this.host.store.audit(null, 'machine.added', id, { hostname, version });
    }
    this.online.get(id)?.conn.close();
    this.online.set(id, { conn, consoleUser: oneLine(f.consoleUser, 120) || null, locked: f.locked === true });
    conn.send({ t: 'm.ok', id });
    this.host.log('info', 'IT support service connected', { machine: id.slice(0, 12), hostname });
    // a session waiting for this PC (it restarted) goes on
    for (const s of this.live.values()) if (s.machineId === id && s.pausedAt !== null) this.resume(s);
    this.changed();
    return id;
  }

  /** A frame from a connected service. */
  frame(machineId: string, f: Record<string, unknown>): void {
    const on = this.online.get(machineId);
    if (!on) return;
    switch (f.t) {
      case 'm.state':
        on.consoleUser = oneLine(f.consoleUser, 120) || null;
        on.locked = f.locked === true;
        this.changed();
        return;
      case 'm.frame': {
        const fr = decodeFrame(f);
        const s = fr ? this.live.get(fr.s) : null;
        if (!fr || !s || s.machineId !== machineId || s.pausedAt !== null) return;
        s.inFlight++;
        s.frames++;
        this.host.toDevice(s.techDevice, 'machine.frame', fr);
        return;
      }
      case 'm.ended': {
        const s = typeof f.s === 'string' ? this.live.get(f.s) : null;
        if (s && s.machineId === machineId) this.end(s, null, oneLine(f.why, 200) || 'The person at the PC stopped it.');
        return;
      }
    }
  }

  /** The service's websocket closed. */
  closed(machineId: string, conn: MachineConn): void {
    if (this.online.get(machineId)?.conn !== conn) return;
    this.online.delete(machineId);
    this.db.prepare('UPDATE machines SET last_seen = ? WHERE id = ?').run(Date.now(), machineId);
    for (const s of [...this.live.values()]) if (s.machineId === machineId) this.pause(s, 'The PC went offline (restarting, or the network dropped).');
    this.changed();
  }

  // ------------------------------------------------------------ people's side
  handle(op: string, me: PublicUser, deviceId: string, d: Record<string, unknown>): unknown {
    switch (op) {
      case 'machine.list':
        // IT staff, and administrators (Control room lists the PCs to remove one)
        if (me.role !== 'owner' && me.role !== 'admin') this.requireIt(me);
        return this.list();
      case 'machine.connect': {
        this.requireIt(me);
        if (this.host.policy().assistElevated !== true) throw new MachineError('Elevated control is off for this office. An administrator turns it on in Control room ▸ Policies ▸ Remote support.');
        const id = typeof d.machineId === 'string' ? d.machineId : '';
        const on = this.online.get(id);
        const m = this.machine(id);
        if (!m || !on) throw new MachineError('That PC is not online. Its IT Support service may be stopped, or the PC is off.');
        if ([...this.live.values()].some((s) => s.machineId === id)) throw new MachineError('Someone from IT is already connected to this PC.');
        // the ticket is for the person signed in to the PC, when the hub knows them; otherwise the technician's own
        const user = on.consoleUser ? this.host.store.userByAccount(on.consoleUser.toLowerCase()) ?? this.host.store.userByAccount(on.consoleUser) : null;
        const requester = user && user.id !== me.id && user.role !== 'bot' && user.role !== 'guest' ? user.id : me.id;
        const ticketId = this.host.helpdesk.openForIt(me, requester, `Elevated support on ${m.hostname} from ${me.displayName}`, { elevated: true, machine: m.hostname });
        const s: Live = {
          id: ulid(), machineId: id, hostname: m.hostname, techId: me.id, ticketId, startedAt: Date.now(), endedAt: null, pausedAt: null, why: null,
          techDevice: deviceId, gate: new InputGate(), timer: null, inFlight: 0, frames: 0,
        };
        s.gate.set(true);
        this.live.set(s.id, s);
        this.db.prepare('INSERT INTO machine_sessions (id, machine_id, tech_id, ticket_id, started_at) VALUES (?, ?, ?, ?, ?)').run(s.id, id, me.id, ticketId, s.startedAt);
        const detail = { session: s.id, machine: m.hostname, consoleUser: on.consoleUser, locked: on.locked };
        this.host.helpdesk.record(ticketId, me.id, 'session.started', `Connected to ${m.hostname} with administrator rights (elevated control)${on.consoleUser ? `, ${on.consoleUser} signed in` : ', nobody signed in'}.`, { ...detail, elevated: true });
        this.host.store.audit(me.id, 'help.elevated.started', ticketId, detail);
        on.conn.send({ t: 'm.start', s: s.id, tech: me.displayName });
        this.changed();
        return this.view(s);
      }
      case 'machine.input': {
        const s = this.mine(me, d.s);
        if (s.pausedAt !== null) return { ok: true };
        if (this.host.policy().assistElevated !== true) { this.end(s, null, 'An administrator turned elevated control off.'); throw new MachineError('Elevated control was turned off.'); }
        const now = Date.now();
        const ok = decodeInputBatch(d.msg).flatMap((ev) => { const r = s.gate.accept(ev, now); return r.ok ? [r.ev] : []; });
        if (ok.length) this.online.get(s.machineId)?.conn.send({ t: 'm.input', s: s.id, e: machineInputs(ok) });
        return { ok: true };
      }
      case 'machine.sas': {
        const s = this.mine(me, d.s);
        this.online.get(s.machineId)?.conn.send({ t: 'm.sas', s: s.id });
        this.host.store.audit(me.id, 'help.elevated.sas', s.ticketId, { session: s.id, machine: s.hostname });
        return { ok: true };
      }
      case 'machine.ack': {
        const s = this.mine(me, d.s);
        s.inFlight = Math.max(0, s.inFlight - 1);
        this.online.get(s.machineId)?.conn.send({ t: 'm.ack', s: s.id, seq: typeof d.seq === 'number' ? d.seq : 0 });
        return { ok: true };
      }
      case 'machine.end': {
        const s = this.mine(me, d.s);
        this.end(s, me.id, null);
        return { ok: true };
      }
      case 'admin.machine.remove': {
        if (me.role !== 'owner' && me.role !== 'admin') throw new MachineError('Only administrators remove PCs.');
        const id = typeof d.machineId === 'string' ? d.machineId : '';
        const m = this.machine(id);
        if (!m) throw new MachineError('PC not found.');
        for (const s of [...this.live.values()]) if (s.machineId === id) this.end(s, me.id, 'An administrator removed this PC.');
        this.db.prepare('UPDATE machines SET removed_at = ? WHERE id = ?').run(Date.now(), id);
        const on = this.online.get(id);
        if (on) { on.conn.send({ t: 'rejected', reason: 'An administrator removed this PC from the office.' }); on.conn.close(); this.online.delete(id); }
        this.host.store.audit(me.id, 'machine.removed', id, { hostname: m.hostname });
        this.changed();
        return { ok: true };
      }
    }
    return undefined;
  }

  /** The technician's device went away: their sessions end (the PC is not left open). */
  deviceGone(deviceId: string): void {
    for (const s of [...this.live.values()]) if (s.techDevice === deviceId) this.end(s, null, 'The technician\'s app went offline.');
  }

  list(): MachineInfo[] {
    const rows = this.db.prepare('SELECT id, hostname, version, first_seen, last_seen FROM machines WHERE removed_at IS NULL ORDER BY hostname').all() as Array<{ id: string; hostname: string; version: string; first_seen: number; last_seen: number }>;
    return rows.map((r) => {
      const on = this.online.get(r.id);
      const s = [...this.live.values()].find((x) => x.machineId === r.id) ?? null;
      return { id: r.id, hostname: r.hostname, version: r.version, firstSeen: r.first_seen, lastSeen: on ? Date.now() : r.last_seen, online: !!on, consoleUser: on?.consoleUser ?? null, locked: on?.locked ?? true, session: s ? this.view(s) : null };
    });
  }

  private machine(id: string): { hostname: string } | null {
    return (this.db.prepare('SELECT hostname FROM machines WHERE id = ? AND removed_at IS NULL').get(id) as { hostname: string } | undefined) ?? null;
  }

  private requireIt(me: PublicUser): void {
    if (!this.host.helpdesk.isIt(me.id)) throw new MachineError('Only people on the IT desk can do that.');
  }

  private mine(me: PublicUser, id: unknown): Live {
    const s = typeof id === 'string' ? this.live.get(id) : undefined;
    if (!s || s.techId !== me.id) throw new MachineError('That session has ended.');
    return s;
  }

  private view(s: Live): ElevatedSession {
    return { id: s.id, machineId: s.machineId, hostname: s.hostname, techId: s.techId, ticketId: s.ticketId, startedAt: s.startedAt, endedAt: s.endedAt, pausedAt: s.pausedAt, why: s.why };
  }

  private tell(s: Live): void {
    this.host.toDevice(s.techDevice, 'machine.session', this.view(s));
  }

  private pause(s: Live, why: string): void {
    if (this.host.policy().assistReconnect !== true) { this.end(s, null, why); return; }
    if (s.pausedAt !== null) return;
    s.pausedAt = Date.now();
    s.gate.set(false);
    const minutes = Math.round(this.reconnectGraceMs / 60_000);
    this.host.helpdesk.record(s.ticketId, null, 'session.paused', `${why} The session waits ${minutes} minute${minutes === 1 ? '' : 's'} for it to come back.`, { session: s.id, elevated: true });
    this.host.store.audit(null, 'help.session.paused', s.ticketId, { session: s.id, machine: s.hostname, elevated: true });
    s.timer = setTimeout(() => { if (this.live.get(s.id) === s && s.pausedAt !== null) this.end(s, null, 'The PC did not come back in time.'); }, this.reconnectGraceMs);
    s.timer.unref?.();
    this.tell(s);
  }

  private resume(s: Live): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    const pausedMs = Date.now() - (s.pausedAt ?? Date.now());
    s.pausedAt = null;
    s.inFlight = 0;
    s.gate.set(true);
    const on = this.online.get(s.machineId);
    this.host.helpdesk.record(s.ticketId, null, 'session.resumed', `${s.hostname} is back.`, { session: s.id, pausedMs, elevated: true });
    this.host.store.audit(null, 'help.session.resumed', s.ticketId, { session: s.id, machine: s.hostname, pausedMs, elevated: true });
    on?.conn.send({ t: 'm.start', s: s.id, tech: this.host.store.userById(s.techId)?.displayName ?? 'IT' });
    this.tell(s);
  }

  /** End a session: the PC stops sending and lets go of every key; the duration goes on the ticket and in the audit log. */
  private end(s: Live, actor: string | null, why: string | null): void {
    if (!this.live.delete(s.id)) return;
    if (s.timer) clearTimeout(s.timer);
    s.gate.set(false);
    s.endedAt = Date.now();
    s.why = why;
    this.db.prepare('UPDATE machine_sessions SET ended_at = ?, why = ? WHERE id = ?').run(s.endedAt, why, s.id);
    this.online.get(s.machineId)?.conn.send({ t: 'm.stop', s: s.id, why: why ?? 'IT ended the session.' });
    const durationMs = s.endedAt - s.startedAt;
    this.host.helpdesk.record(s.ticketId, actor, 'session.ended', why, { session: s.id, durationMs, elevated: true, machine: s.hostname });
    this.host.store.audit(actor, 'help.elevated.ended', s.ticketId, { session: s.id, machine: s.hostname, durationMs, frames: s.frames, why });
    this.tell(s);
    this.changed();
  }

  private changed(): void {
    this.host.tellIt('machine.list', this.list());
  }
}
