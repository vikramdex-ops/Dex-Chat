// The office hub: pinned-TLS WebSocket API, device sign-in with admin approval, presence,
// people directory and an audit trail. Discovery answers LAN probes so apps find it unaided.
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import {
  APP_ID, DEFAULT_HUB_PORT, DISCOVERY_PORT, PROTOCOL_VERSION,
  accountKey, authPayload, deviceIdFor, verifySignature,
} from '@dex/core';
import type { ClientFrame, DeviceRecord, HubInfo, IceConfig, IceServer, OpName, RemoteConfig, RemoteView, Ops, PublicUser, Role, ServerFrame, Session, WindowsAccount } from '@dex/core';
import { HubAnnouncer } from '@dex/core/discovery';
import type { HubBeacon } from '@dex/core/discovery';
import { Store } from './store.ts';
import { UpdateMirror } from './update-mirror.ts';
import { Messaging, MsgError } from './messaging.ts';
import { Desk } from './desk.ts';
import { Org, OrgError } from './org.ts';
import { Work, WorkError } from './work.ts';
import { Calendar, CalError } from './calendar.ts';
import { Guests, GuestError } from './guests.ts';
import { Compliance, ComplianceError } from './compliance.ts';
import { Policies, PolicyError } from './policies.ts';
import { Pairing, lanAddresses } from './pairing.ts';
import { SystemBot } from './systembot.ts';
import { Relay, RelayError } from './relay.ts';
import { ipAllowed } from '@dex/core/dlp';
import { pairCode, pairLink } from '@dex/core/remote';
import { Emoji, EmojiError } from './emoji.ts';
import { RemoteGateway } from './remote.ts';
import { Ice } from './ice.ts';
import { slackToMarkdown } from './slack.ts';
import { Commands, CommandError } from './commands.ts';
import { Workspace, WorkspaceError } from './workspace.ts';
import { encKeyStatement } from '@dex/core/e2e';
import { FileStore } from './files.ts';
import { Rooms, RoomError } from './rooms.ts';
import { MeetingError, Meetings } from './meetings.ts';
import { Flows, FlowError } from './flows.ts';
import { BotFlows, BotFlowsError } from './botflows.ts';
import { BotFlowError } from '@dex/core/botflows';
import { MiniApps, MiniAppError } from './miniapps.ts';
import { MeetGuests } from './meet-guests.ts';
import { MeetReports, ReportError } from './meet-reports.ts';
import { MeetThreads, ThreadError } from './meet-threads.ts';
import { Recordings, RecordingError } from './recordings.ts';
import { Webinars, WebinarError } from './webinars.ts';
import { MEET_ORG_DEFAULT, isWebGuest, isWebGuestDevice, normalizeSlug, siteBase, siteUrlProblem } from '@dex/core';
import { HelpDesk, HelpError } from './helpdesk.ts';
import { LoungeError, Lounges } from './lounges.ts';
import { PointerError, Pointers } from './pointers.ts';
import type { MirrorOptions } from './update-mirror.ts';
import { loadOrCreateCertificate } from './tls.ts';
import { Links, LinkError } from './links.ts';
import { ReactionInsights, InsightError } from './reactions.ts';
import { Decisions, DecisionError } from './decisions.ts';
import { Refs, RefError } from './refs.ts';
import { BackupFailure, Backups, LOCK_FILE } from './backup.ts';
import { OffboardError, Offboarding } from './offboard.ts';
import { CalFeedError, CalendarFeeds } from './calfeed.ts';
import { MeetPublic, PublicPageError } from './meet-public.ts';
import { MissedNotices } from './missed.ts';
import { Nib, NibError } from './nib.ts';
import { NoticeBoard, NoticeError } from './notices.ts';
import { Seating, SeatingError } from './seating.ts';

export const HUB_VERSION = '0.1.0';

export interface HubOptions {
  dataDir: string;
  name?: string;
  port?: number;
  host?: string;
  /** The relay for large Rooms: off to use only PC-to-PC calls (default on when installed). */
  relay?: boolean;
  /** UDP/TCP ports the relay uses for media (default 47910–47999). */
  relayPorts?: [number, number];
  /** Largest file accepted (default 1 GB). */
  maxFileBytes?: number;
  /** Update mirror settings; `false` turns the mirror off. */
  updates?: Omit<MirrorOptions, 'dir' | 'log'> | false;
  /** UDP port for discovery; `false` disables discovery (tests). */
  discoveryPort?: number | false;
  log?: (level: 'info' | 'warn' | 'error' | 'debug', msg: string, extra?: Record<string, unknown>) => void;
}

interface Conn {
  ws: WebSocket;
  nonce: string;
  ip: string;
  /** Came through the internet gateway rather than the office network. */
  remote: boolean;
  alive: boolean;
  deviceId: string | null;
  userId: string | null;
  ready: boolean;
  fileToken: string | null;
  idle: boolean;
}

const isAdminRole = (r: Role) => r === 'owner' || r === 'admin';
const clean = (s: unknown, max: number): string => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');

function validAccount(a: unknown): WindowsAccount | null {
  if (!a || typeof a !== 'object') return null;
  const v = a as Record<string, unknown>;
  const account = {
    username: clean(v.username, 64),
    domain: clean(v.domain, 64),
    displayName: clean(v.displayName, 80),
    hostname: clean(v.hostname, 64),
  };
  if (!account.username || !account.domain || !account.hostname) return null;
  if (!account.displayName) account.displayName = account.username;
  return account;
}

class OpError extends Error {}

export class Hub {
  readonly store: Store;
  info: HubInfo;
  readonly gateway: RemoteGateway;
  /** Marks the hub's own loopback connections for devices on the internet gateway. */
  private readonly gatewaySecret = crypto.randomBytes(24).toString('base64url');
  /** When devices outside the office last asked to join (at most 10 an hour). */
  private remoteJoins: number[] = [];
  readonly fingerprint: string;
  private readonly opts: HubOptions;
  private readonly server: https.Server;
  private readonly wss: WebSocketServer;
  private readonly conns = new Set<Conn>();
  private announcer: HubAnnouncer | null = null;
  readonly mirror: UpdateMirror | null;
  readonly messaging: Messaging;
  readonly files: FileStore;
  /** What a phone missed while disconnected, and its background service's long poll. */
  readonly missed: MissedNotices;
  readonly rooms: Rooms;
  readonly meetings: Meetings;
  readonly meetGuests: MeetGuests;
  /** Every meeting's page on the office's meeting site (Dexterity Meet): names, what a page may learn. */
  readonly meetPublic: MeetPublic;
  readonly reports: MeetReports;
  readonly recordings: Recordings;
  readonly webinars: Webinars;
  readonly desk: Desk;
  readonly org: Org;
  readonly work: Work;
  readonly calendar: Calendar;
  readonly guests: Guests;
  readonly compliance: Compliance;
  readonly policies: Policies;
  readonly pairing: Pairing;
  readonly system: SystemBot;
  readonly relay: Relay;
  readonly emoji: Emoji;
  readonly commands: Commands;
  readonly workspace: Workspace;
  readonly links: Links;
  readonly reactionInsights: ReactionInsights;
  readonly flows: Flows;
  readonly botflows: BotFlows;
  readonly miniapps: MiniApps;
  readonly helpdesk: HelpDesk;
  readonly lounges: Lounges;
  readonly pointers: Pointers;
  readonly decisions: Decisions;
  readonly refs: Refs;
  readonly backups: Backups;
  readonly offboarding: Offboarding;
  readonly feeds: CalendarFeeds;
  /** Nib, the office's companion: day sheets, the register, the leave note (nib.ts). */
  readonly nib: Nib;
  /** Meeting threads, action points and recaps (meet-threads.ts). */
  readonly meetThreads: MeetThreads;
  /** The notice board: the issuing desks' register of notices (notices.ts, docs/ANNOUNCEMENTS.md). */
  readonly notices: NoticeBoard;
  /** The office's floor plan and who sits where (seating.ts, docs/SEATING.md). */
  readonly seating: Seating;
  private lastPurge = 0;
  private deskTimer: NodeJS.Timeout | null = null;
  /** file token -> user, one per signed-in connection */
  private readonly fileTokens = new Map<string, string>();
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();
  private readonly log: NonNullable<HubOptions['log']>;

  constructor(opts: HubOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.store = new Store(opts.dataDir);
    const id = this.store.meta('hub_id', () => crypto.randomBytes(8).toString('hex'));
    const name = opts.name ?? this.store.meta('hub_name', () => 'Dexterity Office Hub');
    this.info = { id, name, version: HUB_VERSION, protocol: PROTOCOL_VERSION };
    const tls = loadOrCreateCertificate(opts.dataDir, `Dexterity Connect Hub ${id}`);
    this.fingerprint = tls.fingerprint;

    this.server = https.createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, (req, res) => this.http(req, res));
    this.files = new FileStore(this.store.db, path.join(opts.dataDir, 'files'), opts.maxFileBytes);
    this.messaging = new Messaging(this.store.db, (userIds, name, data) => this.deliver(userIds, name, data), () => this.store.activeUsers(), this.files);
    this.work = new Work(this.store.db, () => this.store.activeUsers(), (uid) => {
      // a connected device counts as seen now
      if ([...this.conns].some((c) => c.ready && c.userId === uid)) return Date.now();
      const r = this.store.db.prepare('SELECT MAX(last_seen) AS t FROM devices WHERE user_id = ?').get(uid) as { t: number | null };
      return r.t;
    }, (state) => this.emit('work.updated', state));
    this.calendar = new Calendar(this.store.db, this.messaging, () => this.store.activeUsers(), (userIds, name, data) => this.deliver(userIds, name, data), (name, data) => this.emit(name, data));
    this.guests = new Guests(this.store, this.messaging, (uid) => {
      for (const c of this.conns) {
        if (c.userId !== uid) continue;
        this.send(c, { t: 'rejected', reason: 'Your guest access has ended.' });
        c.ws.close();
      }
    });
    this.compliance = new Compliance(this.store, this.messaging, this.files);
    this.policies = new Policies(this.store, this.files, (p) => {
      this.emit('policy.updated', p);
      // a narrower list of outside networks applies at once
      for (const c of [...this.conns]) {
        if (c.remote && !this.outsideAllowed(c)) { this.send(c, { t: 'rejected', reason: 'Your office allows access from outside only from approved networks.' }); c.ws.close(); }
      }
    });
    this.policies.linesChanged = (list) => this.emit('lines.updated', list);
    this.pairing = new Pairing(this.store);
    this.system = new SystemBot(this.store, this.messaging);
    this.missed = new MissedNotices(this.store.db, () => this.store.activeUsers(), (id) => this.files.forMessage(id).map((f) => f.name));
    this.messaging.editWindowMs = () => this.policies.editWindowMs();
    this.messaging.dlpRules = () => this.policies.get().dlp ?? [];
    this.messaging.requireE2E = () => this.policies.get().requireE2E === true;
    this.messaging.keyless = (userIds) => {
      if (!userIds.length) return [];
      const rows = this.store.db.prepare(`SELECT DISTINCT user_id FROM devices WHERE status = 'approved' AND enc_key IS NOT NULL AND user_id IN (${userIds.map(() => '?').join(',')})`).all(...userIds) as Array<{ user_id: string }>;
      const have = new Set(rows.map((r) => r.user_id));
      return userIds.filter((u) => !have.has(u));
    };
    this.messaging.onReport = () => this.emit('admin.reports', { open: this.messaging.openReports() }, (c) => this.isAdminConn(c));
    this.emoji = new Emoji(this.store, this.files, (list) => this.emit('emoji.updated', list));
    this.files.isPublic = (id) => this.emoji.isEmojiFile(id);
    this.emoji.membersMay = () => this.policies.get().memberEmoji !== false;
    this.emoji.stickersChanged = (list) => this.emit('sticker.updated', list);
    this.messaging.customEmoji = (name) => this.emoji.exists(name);
    this.commands = new Commands(this.store, this.messaging);
    this.workspace = new Workspace(this.store.db, this.messaging, (userIds, name, data) => this.deliver(userIds, name, data));
    this.links = new Links({ store: this.store, messaging: this.messaging, files: this.files, visibleUsers: (u) => this.guests.visibleTo(u, this.store.activeUsers()),
      event: (u, id) => { try { return this.calendar.handle('cal.get', u, { eventId: id }) as import('@dex/core').CalEvent; } catch { return null; } },
      meeting: (u, id) => {
        const meetings = this.meetings; // made a little further down; asked only once the hub runs
        const m = meetings.get(id);
        if (!m) return null;
        const live = (this.rooms.handle('room.list', u, '', {}) as import('@dex/core').RoomInfo[]).find((r) => r.meetingId === m.id) ?? null;
        return { info: meetings.info(m, live), insider: meetings.insider(m, u.id) };
      } });
    this.decisions = new Decisions(this.store.db, this.messaging);
    this.refs = new Refs(this.store.db, this.messaging, this.files);
    this.reactionInsights = new ReactionInsights(this.store, this.messaging);
    this.messaging.onReaction = (messageId, convId, userId, emoji, on) => this.reactionInsights.record(messageId, convId, userId, emoji, on);
    this.messaging.afterSend = (msg, author) => this.links.prefetch(msg, author);
    this.org = new Org(this.store, (u) => this.emit('user.updated', u), (info) => this.emit('org.updated', info));
    this.desk = new Desk(this.store.db, this.messaging, this.files, (userIds, name, data) => this.deliver(userIds, name, data), (uid) => {
      const u = this.store.userById(uid);
      return u && this.store.activeUsers().some((a) => a.id === u.id) ? u : null;
    });
    this.flows = new Flows({
      store: this.store, messaging: this.messaging, desk: this.desk, files: this.files, system: this.system,
      deliver: (userIds, name, data) => this.deliver(userIds, name, data),
      log: (level, msg, extra) => this.log(level, msg, extra),
      userAdded: (u) => this.emit('user.added', u),
    });
    this.messaging.observe = (e) => this.flows.onEvent(e);
    this.messaging.keptTags = (id) => this.flows.tagsOf(id);
    // conversations with integrations (flows, sessions) and tools in conversations
    this.botflows = new BotFlows({
      store: this.store, messaging: this.messaging, files: this.files, desk: this.desk, broadcast: (n, d) => this.emit(n, d), log: (l, m, e) => this.log(l, m, e),
      deliver: (userIds, name, data) => this.deliver(userIds, name, () => data),
      // the office's working days are Nib's (made below; read when a job asks)
      calendar: () => ({ workdays: this.nib ? this.nib.workingDay().workdays : [1, 2, 3, 4, 5, 6] }),
    });
    this.miniapps = new MiniApps({ store: this.store, messaging: this.messaging, files: this.files, deliver: (u, n, d) => this.deliver(u, n, d), broadcast: (n, d) => this.emit(n, d) });
    this.messaging.extraView = (r) => ({ ...this.botflows.view(r), ...this.miniapps.view(r) });
    this.messaging.onPosted = (author, convId, msg) => this.botflows.onPosted(author, convId, msg);
    this.commands.extra = { list: () => this.botflows.commandList(), run: (c, me, convId) => this.botflows.runCommand(c, me, convId) };
    this.relay = new Relay({
      // the address PCs use to reach this hub: the one it is bound to, or its office address
      announced: () => (this.opts.host && this.opts.host !== '0.0.0.0' ? this.opts.host : (lanAddresses(this.port)[0] ?? '127.0.0.1:0').split(':')[0]),
      deliverToDevice: (deviceId, name, data) => { for (const c of this.conns) if (c.ready && c.deviceId === deviceId) this.send(c, { t: 'evt', name, data }); },
      log: (level, msg, meta) => this.log(level, msg, meta),
    }, opts.relayPorts);
    this.meetings = new Meetings(this.store.db, this.messaging, (uid) => {
      const u = this.store.userById(uid);
      return u && this.store.activeUsers().some((a) => a.id === u.id) ? u : null;
    });
    this.meetings.defaults = () => { const p = this.policies.get(); return { lobby: p.meetingLobby ?? 'outside', joinBeforeHost: p.joinBeforeHost !== false }; };
    this.reports = new MeetReports(this.store.db);
    this.meetPublic = new MeetPublic({
      db: this.store.db, meetings: this.meetings,
      live: (meetingId) => this.rooms.live(meetingId),
      userById: (uid) => this.store.userById(uid),
      site: () => this.publicSite(),
      org: () => this.remoteConfig().orgName ?? MEET_ORG_DEFAULT,
      zone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
      allowed: () => this.policies.get().guestLinks !== false,
      gatewayOn: () => this.remoteConfig().enabled,
      audit: (actor, action, target, meta) => this.store.audit(actor, action, target, meta ?? {}),
      log: (level, msg, extra) => this.log(level, msg, extra),
    });
    this.meetings.pageUrl = (meetingId) => this.meetPublic.pageUrl(meetingId);
    this.rooms = new Rooms({
      members: (convId) => this.messaging.members(convId),
      deliverToUsers: (userIds, name, data) => {
        // browser guests are not connections of the hub: their events go through the gateway
        const guests = userIds.filter(isWebGuest);
        this.deliver(guests.length ? userIds.filter((u) => !isWebGuest(u)) : userIds, name, () => data);
        for (const g of guests) this.meetGuests.toUser(g, name, data);
      },
      deliverToDevice: (deviceId, name, data) => this.toDevice(deviceId, name, data),
      visitorsOf: (ids) => this.meetGuests.visitors(ids),
      audit: (actor, action, target, meta) => this.store.audit(actor, action, target, meta ?? {}),
      track: this.reports,
      broadcast: (name, data) => this.emit(name, data),
      allowRecording: () => this.policies.get().allowRecording,
      ended: (room, missed, durationMs) => this.policies.logCall(room.id, room.convId, room.startedBy, room.video, missed, durationMs),
      relayAvailable: () => this.opts.relay !== false && this.relay.available(),
      deviceLeft: (_roomId, deviceId) => this.relay.leave(deviceId),
      roomClosed: (roomId) => this.relay.closeRoom(roomId),
      meetings: this.meetings,
      purposeChanged: (room, ended) => {
        this.lounges.roomChanged(room, ended);
        if (ended) this.helpdesk.roomEnded(room); else this.helpdesk.roomChanged(room);
      },
      webinar: { onStage: (m, u) => this.webinars.onStage(m, u), staff: (m, u) => this.webinars.isHost(m, u) || this.webinars.isPanelist(m, u), changed: (r) => this.webinars.roomChanged(r), ended: (r) => this.webinars.roomEnded(r) },
      // made further down; the Rooms call these only once the hub runs
      threads: {
        opened: (r, m) => { const o = this.meetThreads.roomOpened(r, m); return o ? { id: o.id, noteTakerId: o.noteTakerId } : null; },
        ended: (r) => this.meetThreads.roomEnded(r),
        said: (main, me, text, opts) => this.meetThreads.said(main, me, text, opts),
        log: (main) => this.meetThreads.chatLog(main),
        missed: (main, me, before) => this.meetThreads.missed(main, me, before),
        noteTaker: (roomId, userId) => { this.meetThreads.setNoteTaker(roomId, userId); },
      },
    });
    this.recordings = new Recordings({
      db: this.store.db, files: this.files, dir: path.join(opts.dataDir, 'recordings-partial'),
      userById: (id) => this.store.userById(id),
      isMember: (convId, userId) => this.messaging.isMember(convId, userId),
      convKind: (convId) => { const r = this.store.db.prepare('SELECT kind FROM conversations WHERE id = ?').get(convId) as { kind: string } | undefined; return r ? (r.kind === 'direct' ? 'direct' : 'space') : null; },
      session: (roomId) => { const r = this.store.db.prepare('SELECT meeting_id, conv_id, title FROM meeting_sessions WHERE room_id = ?').get(roomId) as { meeting_id: string | null; conv_id: string; title: string } | undefined; return r ? { meetingId: r.meeting_id, convId: r.conv_id, title: r.title } : null; },
      attended: (roomId, userId) => this.reports.attended(roomId, userId),
      maxBytes: () => (this.policies.get().recordingMaxMb ?? 2048) * 1024 * 1024,
      allowed: () => this.policies.get().allowRecording,
      retention: () => { const p = this.compliance.policy(); return { space: p.spaceRetentionDays, direct: p.directRetentionDays }; },
      held: (convId, userId) => !!this.store.db.prepare(`SELECT 1 FROM legal_holds WHERE (kind = 'conv' AND target_id = ?) OR (kind = 'user' AND target_id = ?) LIMIT 1`).get(convId ?? '', userId),
      audit: (actor, action, target, meta) => this.store.audit(actor, action, target, meta ?? {}),
      tell: (userIds, name, data) => this.deliver(userIds, name, () => data),
    });
    this.reports.recordingsFor = (roomId, viewer) => this.recordings.forRoom(roomId, viewer);
    const deliverNow = (userIds: string[], name: string, data: unknown) => this.deliver(userIds, name, () => data);
    this.helpdesk = new HelpDesk({ store: this.store, messaging: this.messaging, files: this.files, rooms: this.rooms, deliver: deliverNow, broadcast: (name, data) => this.emit(name, data) });
    this.lounges = new Lounges({
      db: this.store.db, messaging: this.messaging, rooms: this.rooms, deliver: deliverNow,
      // Space members see the lounge's name; everyone else only that the person is in a lounge
      where: (userId, lounge) => {
        const members = new Set(lounge ? this.messaging.members(lounge.convId) : []);
        this.emit('lounge.where', { userId, loungeId: lounge?.id ?? null, name: lounge?.name ?? null }, (c) => !!c.userId && members.has(c.userId));
        this.emit('lounge.where', { userId, loungeId: lounge?.id ?? null, name: null }, (c) => !c.userId || !members.has(c.userId));
      },
    });
    this.pointers = new Pointers({
      db: this.store.db, files: this.files, messaging: this.messaging, deliver: deliverNow,
      deliverToDevice: (deviceId, name, data) => { for (const c of this.conns) if (c.ready && c.deviceId === deviceId) this.send(c, { t: 'evt', name, data }); },
    });
    // files attached to a help ticket open for the people on it
    const readBefore = this.files.extraRead;
    this.files.extraRead = (userId, fileId) => readBefore(userId, fileId) || this.helpdesk.canRead(userId, fileId);
    this.webinars = new Webinars({
      db: this.store.db, meetings: this.meetings, rooms: this.rooms, messaging: this.messaging, files: this.files,
      userById: (uid) => this.store.userById(uid),
      deliverToUsers: (userIds, name, data) => this.deliver(userIds, name, () => data),
      deliverToDevice: (deviceId, name, data) => this.toDevice(deviceId, name, data),
      isRemote: (deviceId) => [...this.conns].some((c) => c.ready && c.deviceId === deviceId && c.remote),
      relayAvailable: () => this.opts.relay !== false && this.relay.available(),
      relayLeave: (deviceId) => this.relay.leave(deviceId),
      relayClose: (roomId) => this.relay.closeRoom(roomId),
      // registration and watch pages live on the office's meeting site (or the gateway's address)
      gateway: () => this.publicSite(),
      pageRef: (meetingId) => this.meetPublic.slugOf(meetingId),
      office: () => this.info.name,
      tell: (userId, text, key) => this.system.tell(userId, text, key),
      recordingLink: (me, recordingId) => {
        try {
          const r = this.recordings.handle('rec.share', me, { id: recordingId, link: true }) as import('@dex/core').RecordingInfo;
          if (!r.link) throw new WebinarError('That recording cannot be shared by link.');
          return r.link;
        } catch (err) { if (err instanceof RecordingError) throw new WebinarError(err.message); throw err; }
      },
      iceServers: () => this.ice.servers(),
      audit: (actor, action, target, meta) => this.store.audit(actor, action, target, meta ?? {}),
      ffmpegPath: () => this.store.meta('ffmpeg_path', () => '') || null,
      setFfmpegPath: (p) => this.setMeta('ffmpeg_path', p ?? ''),
      log: (level, msg, extra) => this.log(level, msg, extra),
    });
    this.reports.webinarFor = (meetingId) => this.webinars.reportFor(meetingId);
    // keeping the office going: backups, offboarding and calendar feeds (backup.ts, offboard.ts, calfeed.ts)
    this.feeds = new CalendarFeeds({
      db: this.store.db, hubId: () => this.info.id, office: () => this.info.name,
      userById: (uid) => this.store.userById(uid),
      active: (uid) => this.canSignIn(uid),
      lan: () => lanAddresses(this.port),
      gateway: () => { const rc = this.remoteConfig(); return rc.enabled ? rc.url : null; },
      meetingFor: (organizer, eventId) => this.meetings.forEvent(organizer, eventId).id,
      pageUrl: (meetingId) => this.meetPublic.pageUrl(meetingId),
      venueName: (vid) => this.calendar.venues().find((v) => v.id === vid)?.name ?? null,
      audit: (actor, action, target, detail) => this.store.audit(actor, action, target, detail),
    });
    this.backups = new Backups({
      db: this.store.db, dataDir: opts.dataDir, hubId: id, hubName: () => this.info.name, version: HUB_VERSION,
      systemId: () => this.system.id,
      admins: () => this.store.activeUsers().filter((u) => isAdminRole(u.role)),
      tell: (uid, text, key) => this.system.tell(uid, text, key),
      changed: (status) => this.emit('admin.backup', status, (c) => this.isAdminConn(c)),
      audit: (actor, action, target, detail) => this.store.audit(actor, action, target, detail),
      log: (level, msg, extra) => this.log(level, msg, extra),
    });
    this.offboarding = new Offboarding({
      store: this.store, messaging: this.messaging, calendar: this.calendar, helpdesk: this.helpdesk, feeds: this.feeds, system: this.system,
      signOut: (uid, reason) => this.signOut(uid, reason),
      broadcast: (name, data, adminsOnly) => {
        // a leaver's seat is freed on the floor plan
        if (name === 'user.left') { try { this.seating.personLeft((data as { userId: string }).userId); } catch (err) { this.log('warn', 'seat not freed', { error: (err as Error).message }); } }
        this.emit(name, data, adminsOnly ? (c) => this.isAdminConn(c) : undefined);
      },
      forgetNotify: (deviceId) => this.missed.revoke(deviceId),
      active: (uid) => this.canSignIn(uid),
    });
    { const prev = this.files.extraRead; this.files.extraRead = (userId, fileId) => prev(userId, fileId) || this.webinars.mayReadHandout(userId, fileId); }
    this.nib = new Nib({
      db: this.store.db, store: this.store, messaging: this.messaging, desk: this.desk, calendar: this.calendar, work: this.work,
      deliver: (userIds, name, data) => this.deliver(userIds, name, data),
      online: (uid) => [...this.conns].some((c) => c.ready && c.userId === uid),
      busy: (uid) => {
        if (this.rooms.inRoomUsers().includes(uid)) return 'room';
        if (this.inMeeting.has(uid)) return 'meeting';
        const a = this.store.userById(uid)?.availability;
        return a === 'dnd' ? 'dnd' : a === 'busy' ? 'busy' : null;
      },
      departments: () => this.org.info().departments,
      audit: (actor, action, target, detail) => this.store.audit(actor, action, target, detail ?? {}),
      userChanged: (uid) => { const u = this.store.userById(uid); if (u) this.emit('user.updated', u); },
      userAdded: (u) => this.emit('user.added', u),
      log: (level, msg, extra) => this.log(level, msg, extra),
    });
    { const prev = this.messaging.onPosted; this.messaging.onPosted = (author, convId, msg) => { prev?.(author, convId, msg); try { this.nib.onPosted(author, convId, msg); } catch (err) { this.log('warn', 'nib reply failed', { error: (err as Error).message }); } }; }
    this.botflows.away = (me, answers) => {
      const line = this.nib.leaveFromFlow(me, answers);
      if (answers.from) this.botflows.net.emitAway(me.id, answers.from, answers.to ?? null);
      return line;
    };
    // bots asking Nib about leave, and jobs leaving people on leave out
    this.botflows.net.leave = (uid, date) => this.nib.leaveInfo(uid, date);
    this.botflows.jobs.away = (uid, date) => this.nib.awayOn(uid, date);
    this.meetThreads = new MeetThreads({
      db: this.store.db, messaging: this.messaging,
      userById: (uid) => { const u = this.store.userById(uid); return u && this.store.activeUsers().some((a) => a.id === u.id) ? u : null; },
      activeUsers: () => this.store.activeUsers(),
      deliver: (userIds, name, data) => this.deliver(userIds, name, data),
      cardAuthor: () => this.system.user,
      tell: (uid, text, key) => this.system.tell(uid, text, key),
      recordings: (roomIds, viewer) => roomIds.flatMap((id) => this.recordings.forRoom(id, viewer)),
      roomLive: (roomIds) => roomIds.some((id) => this.rooms.rooms.has(id)),
      desk: {
        todo: (owner, messageId, on) => { this.desk.handle('msg.star', owner, { messageId, on, kind: 'todo' }); },
        remind: (by, owner, messageId, text, dueAt) => {
          try { return (this.desk.handle('remind.create', by, { forUserId: owner.id, messageId, text, dueAt: Math.max(dueAt, Date.now() + 60_000) }) as { id: string }).id; } catch { return null; }
        },
        reminderDone: (id, done, dueAt) => {
          const r = this.store.db.prepare('SELECT user_id FROM reminders WHERE id = ?').get(id) as { user_id: string } | undefined;
          const u = r ? this.store.userById(r.user_id) : null;
          if (u) { try { this.desk.handle('remind.update', u, { id, done, ...(dueAt ? { dueAt } : {}) }); } catch { /* gone */ } }
        },
        reminderGone: (id) => {
          const r = this.store.db.prepare('SELECT user_id FROM reminders WHERE id = ?').get(id) as { user_id: string } | undefined;
          const u = r ? this.store.userById(r.user_id) : null;
          if (u) { try { this.desk.handle('remind.delete', u, { id }); } catch { /* gone */ } }
        },
      },
      nib: {
        add: (owner, a) => this.nib.meetingItem(owner, a),
        status: (itemId, status) => this.nib.meetingItemStatus(itemId, status),
        gone: (itemId) => this.nib.meetingItemGone(itemId),
        away: (uid, date) => this.nib.awayOn(uid, date),
        hours: () => this.nib.workingDay(),
      },
      audit: (actor, action, target, meta) => this.store.audit(actor, action, target, meta ?? {}),
      log: (level, msg, extra) => this.log(level, msg, extra),
    });
    this.meetings.eventThread = (eventId) => this.meetThreads.ensureEventThread(eventId, true);
    this.meetings.ownThread = (convId) => this.meetThreads.isOwn(convId);
    this.meetings.occurrenceOf = (roomId) => this.meetThreads.occurrenceOf(roomId);
    this.nib.onMeetingItem = (itemId, status, by) => this.meetThreads.nibChanged(itemId, status, by);
    { const prev = this.files.extraRead; this.files.extraRead = (userId, fileId) => prev(userId, fileId) || this.meetThreads.mayReadFile(userId, fileId); }
    { const prev = this.messaging.beforeChange; this.messaging.beforeChange = (msg, change, actorId) => { prev?.(msg, change, actorId); if (change === 'delete') { try { this.meetThreads.messageDeleted(msg.id); } catch { /* the message still goes */ } } }; }
    this.notices = new NoticeBoard({
      db: this.store.db, store: this.store, files: this.files,
      departments: () => this.org.info().departments,
      deliver: (userIds, name, data) => this.deliver(userIds, name, data),
      // reminders and answers are one quiet line from Nib (or the system bot while Nib is off)
      tell: (uid, key, text) => { if (!this.nib.note(uid, key, text)) this.system.tell(uid, text, key); },
      hasApp: (uid) => this.canSignIn(uid),
      held: (uid) => !!this.store.db.prepare(`SELECT 1 FROM legal_holds WHERE kind = 'user' AND target_id = ? LIMIT 1`).get(uid),
      officePins: () => {
        const office = this.store.db.prepare('SELECT id FROM conversations WHERE everyone = 1 LIMIT 1').get() as { id: string } | undefined;
        if (!office) return [];
        return (this.store.db.prepare('SELECT id, body, author_id, created_at FROM messages WHERE conv_id = ? AND pinned = 1 AND deleted = 0 ORDER BY id DESC LIMIT 50').all(office.id) as Array<{ id: string; body: string; author_id: string; created_at: number }>)
          .map((m) => ({ ...m, files: this.files.forMessage(m.id) }));
      },
      unpin: (messageId) => { this.store.db.prepare('UPDATE messages SET pinned = 0, pin_until = NULL WHERE id = ?').run(messageId); this.messaging.pushUpdate(messageId); },
      audit: (actor, action, target, detail) => this.store.audit(actor, action, target, detail ?? {}),
      log: (level, msg, extra) => this.log(level, msg, extra),
    });
    { const prev = this.files.extraRead; this.files.extraRead = (userId, fileId) => prev(userId, fileId) || this.notices.mayReadFile(userId, fileId); }
    this.seating = new Seating({
      db: this.store.db, store: this.store,
      // guests never see the floor plan
      broadcast: (name, data) => this.emit(name, data, (c) => { const u = c.userId ? this.store.userById(c.userId) : null; return !!u && u.role !== 'guest' && u.role !== 'bot'; }),
      tell: (uid, key, text) => { if (!this.nib.note(uid, key, text)) this.system.tell(uid, text, key); },
      userChanged: (uid) => { const u = this.store.userById(uid); if (u) this.emit('user.updated', u); },
      audit: (actor, action, target, detail) => this.store.audit(actor, action, target, detail ?? {}),
      log: (level, msg, extra) => this.log(level, msg, extra),
    });
    // databases from before messaging existed: create the Office space and add everyone
    const owner = this.store.activeUsers().find((u) => u.role === 'owner');
    if (owner) {
      this.messaging.ensureEveryoneSpace(owner.id);
      for (const u of this.store.activeUsers()) this.messaging.welcome(u.id);
    }
    this.mirror = opts.updates === false ? null
      : new UpdateMirror({ ...(opts.updates ?? {}), dir: path.join(opts.dataDir, 'updates'), log: this.log });
    this.wss = new WebSocketServer({ server: this.server, path: '/ws', maxPayload: 1024 * 1024 });
    this.meetGuests = new MeetGuests({
      rooms: this.rooms, meetings: this.meetings, webinars: () => this.webinars,
      send: (gid, frame) => this.gateway.sendGuest(gid, frame),
      close: (gid, code, reason) => this.gateway.closeGuest(gid, code, reason),
      allowed: () => this.policies.get().guestLinks !== false,
      iceServers: () => this.ice.servers(),
      userById: (uid) => this.store.userById(uid),
      audit: (actor, action, target, meta) => this.store.audit(actor, action, target, meta ?? {}),
      tellHosts: (room, name, reason) => {
        const hosts = [room.hostId, ...(room.coHosts ?? [])].filter((u): u is string => !!u && room.participants.some((p) => p.userId === u));
        this.deliver(hosts, 'meet.guestRefused', () => ({ roomId: room.id, name, reason }));
      },
      log: (level, msg, extra) => this.log(level, msg, extra),
      resolve: (ref) => this.meetPublic.resolveId(ref),
      joinProblem: (m) => this.meetPublic.joinProblem(m),
      // a guest's file follows the office's file rules (blocked types, the upload limit)
      fileProblem: (name, size) => {
        const ext = name.toLowerCase().match(/\.([a-z0-9]{1,10})$/)?.[1];
        if (ext && (this.policies.get().blockedFileTypes ?? []).includes(ext)) return `This office does not allow .${ext} files to be shared.`;
        if (size > this.files.maxBytes) return `Files can be up to ${Math.floor(this.files.maxBytes / 1024 / 1024)} MB.`;
        return null;
      },
      storeFile: (guestId, name, mime, data) => { const f = this.files.storeBuffer(guestId, name, mime, data); return { id: f.id, name: f.name, size: f.size }; },
    });
    this.gateway = new RemoteGateway({
      hubId: id, certPem: tls.cert, keyPem: tls.key, localPort: () => this.port, secret: this.gatewaySecret,
      log: (level, msg, extra) => this.log(level, msg, extra),
      onStatus: () => {},
      guests: this.meetGuests,
      // the meeting site's questions (page.info, page.check), and the webinar pages, which may name a webinar by its name
      web: (op, ref, ip, body) => (op.startsWith('page.') ? this.meetPublic.request(op, ref, ip, body) : this.webinars.webRequest(op, this.meetPublic.resolveId(ref) ?? ref, ip, body)),
      calendar: (token, ip) => this.feeds.fetch(token, ip),
    });
    this.wss.on('connection', (ws, req) => this.accept(ws, req));
  }

  /** Has an approved device and has not left the office: can use Dexterity Connect now. */
  private canSignIn(userId: string): boolean {
    return !!this.store.db.prepare(`SELECT 1 FROM devices WHERE user_id = ? AND status = 'approved' LIMIT 1`).get(userId) && !this.offboarding.hasLeft(userId);
  }

  /** Close every connection of a person at once, and the file links their sessions handed out. */
  private signOut(userId: string, reason: string): void {
    for (const c of [...this.conns]) {
      if (c.userId !== userId) continue;
      this.send(c, { t: 'rejected', reason });
      c.ws.close();
    }
    for (const [t, u] of this.fileTokens) if (u === userId) this.fileTokens.delete(t);
  }

  /** An event to one device: an app's connection, or a browser guest or attendee through the gateway. */
  private toDevice(deviceId: string, name: string, data: unknown): void {
    if (isWebGuestDevice(deviceId)) { this.meetGuests.toDevice(deviceId, name, data); return; }
    for (const c of this.conns) if (c.ready && c.deviceId === deviceId) this.send(c, { t: 'evt', name, data });
  }

  get port(): number {
    return (this.server.address() as AddressInfo | null)?.port ?? 0;
  }

  beacon(): HubBeacon {
    return { app: APP_ID, v: PROTOCOL_VERSION, kind: 'hub', id: this.info.id, name: this.info.name, port: this.port, fp: this.fingerprint, version: HUB_VERSION };
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port ?? DEFAULT_HUB_PORT, this.opts.host ?? '0.0.0.0', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    // a restore (--restore) refuses to run while this is here and the program is alive
    try { fs.writeFileSync(path.join(this.opts.dataDir, LOCK_FILE), JSON.stringify({ pid: process.pid, port: this.port, startedAt: Date.now() })); } catch (err) { this.log('warn', 'could not write the lock file', { error: (err as Error).message }); }
    if (this.opts.discoveryPort !== false) {
      this.announcer = new HubAnnouncer(() => this.beacon(), this.opts.discoveryPort ?? DISCOVERY_PORT);
      try {
        await this.announcer.start();
      } catch (err) {
        this.log('warn', 'discovery unavailable; apps can still connect by address', { error: (err as Error).message });
        this.announcer = null;
      }
    }
    this.mirror?.start();
    // reminders and scheduled messages (also catches up on anything due while the hub was off)
    const tick = () => {
      try { this.desk.tick(); } catch (err) { this.log('error', 'desk timer failed', { error: (err as Error).message }); }
      try { this.work.tick(); } catch (err) { this.log('error', 'attendance timer failed', { error: (err as Error).message }); }
      // retention runs hourly (and on start)
      if (Date.now() - this.lastPurge > 3600_000) {
        this.lastPurge = Date.now();
        try { this.compliance.purge(); } catch (err) { this.log('error', 'retention failed', { error: (err as Error).message }); }
        try { this.recordings.purge(); } catch (err) { this.log('error', 'recording retention failed', { error: (err as Error).message }); }
      }
      try { this.presenceTick(); } catch (err) { this.log('error', 'presence timer failed', { error: (err as Error).message }); }
      try { this.messaging.tick(); } catch (err) { this.log('error', 'mute timer failed', { error: (err as Error).message }); }
      try { this.guests.tick(); } catch (err) { this.log('error', 'guest timer failed', { error: (err as Error).message }); }
      try { this.calendar.tick(); } catch (err) { this.log('error', 'calendar timer failed', { error: (err as Error).message }); }
      try { this.botflows.tick(); } catch (err) { this.log('error', 'flow timer failed', { error: (err as Error).message }); }
      void this.botflows.jobs.tick().catch((err: Error) => this.log('error', 'bot job timer failed', { error: err.message }));
      try { this.backups.tick(); } catch (err) { this.log('error', 'backup timer failed', { error: (err as Error).message }); }
      try { this.nib.tick(); } catch (err) { this.log('error', 'nib timer failed', { error: (err as Error).message }); }
      try { this.meetThreads.tick(); } catch (err) { this.log('error', 'meeting thread timer failed', { error: (err as Error).message }); }
      try { this.notices.tick(); } catch (err) { this.log('error', 'notice board timer failed', { error: (err as Error).message }); }
      try { this.seating.tick(); } catch (err) { this.log('error', 'seating timer failed', { error: (err as Error).message }); }
    };
    tick();
    this.deskTimer = setInterval(tick, 10_000);
    this.heartbeat = setInterval(() => {
      for (const c of this.conns) {
        if (!c.alive) { c.ws.terminate(); continue; }
        c.alive = false;
        try { c.ws.ping(); } catch { /* closing */ }
      }
    }, 20000);
    this.applyRemote();
    this.log('info', 'hub listening', { port: this.port, hubId: this.info.id, fingerprint: this.fingerprint });
  }

  // ------------------------------------------------------------ outside the office
  readonly ice = new Ice(() => this.iceConfig(), () => this.remoteConfig().enabled);

  private iceConfig(): IceConfig & { token?: string } {
    const m = (k: string) => this.store.meta(k, () => '');
    const mode = m('ice_mode');
    let servers: IceServer[] = [];
    try { servers = JSON.parse(m('ice_servers') || '[]'); } catch { /* none */ }
    return { mode: mode === 'cloudflare' || mode === 'custom' ? mode : 'auto', keyId: m('ice_key') || null, token: m('ice_token') || undefined, servers };
  }
  remoteConfig(): RemoteConfig {
    const m = (k: string, d: string) => this.store.meta(k, () => d);
    const url = m('remote_url', '');
    return {
      enabled: m('remote_enabled', '0') === '1' && !!url, url: url || null, allowJoin: m('remote_join', '1') === '1', allowAdmin: m('remote_admin', '0') === '1',
      siteUrl: m('meet_site_url', '') || null, orgName: m('meet_org_name', '') || MEET_ORG_DEFAULT,
    };
  }

  /**
   * The address of meeting pages: the office's meeting site (Dexterity Meet, on Cloudflare Pages or
   * the office's own domain) when it is set, else the gateway's own address; null while access
   * from outside is off.
   */
  publicSite(): string | null {
    const rc = this.remoteConfig();
    if (!rc.enabled || !rc.url) return null;
    return siteBase(rc.siteUrl || rc.url);
  }

  private setMeta(key: string, value: string): void {
    this.store.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  private remoteView(): RemoteView {
    const s = this.gateway.status;
    return { config: this.remoteConfig(), status: { connected: s.connected, since: s.since, error: s.error, devices: s.devices, pinned: s.pinned }, hubId: this.info.id, fingerprint: this.fingerprint, name: this.info.name };
  }

  /** Connect to (or leave) the gateway, tell devices where it is, and drop outside connections if it was turned off. */
  private applyRemote(): void {
    const c = this.remoteConfig();
    this.info = { ...this.info, remote: c.enabled && c.url ? { url: c.url } : null };
    this.gateway.site = c.siteUrl ?? null;
    this.gateway.configure(c.enabled ? c.url : null);
    for (const conn of this.conns) {
      if (!conn.remote) continue;
      if (!c.enabled) conn.ws.close();
    }
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.deskTimer) clearInterval(this.deskTimer);
    this.mirror?.stop();
    this.announcer?.stop();
    this.gateway.stop();
    this.webinars.stop();
    this.missed.close();
    await this.relay.stop();
    for (const c of this.conns) c.ws.terminate();
    // let automations that are running finish before the database closes
    await Promise.race([this.flows.idle(), new Promise((r) => setTimeout(r, 3000).unref())]);
    // a backup copying the database finishes that step; the rest of the run stops
    await this.backups.halt();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.store.close();
    try { fs.rmSync(path.join(this.opts.dataDir, LOCK_FILE), { force: true }); } catch { /* gone */ }
  }

  // --------------------------------------------------------------- http
  private http(req: IncomingMessage, res: ServerResponse): void {
    if (this.mirror?.handle(req, res)) return;
    if ((req.url ?? '').startsWith('/files')) { void this.fileRoute(req, res); return; }
    if ((req.url ?? '').startsWith('/notify/')) { this.missed.route(req, res); return; }
    if ((req.url ?? '').startsWith('/api/bot/')) { void this.botRoute(req, res); return; }
    if ((req.url ?? '').startsWith('/api/hooks/')) { void this.hookRoute(req, res); return; }
    if ((req.url ?? '').startsWith('/cal/')) { this.feeds.route(req, res); return; }
    if (/^\/api\/(flows|sessions)(\/|\?|$)/.test(req.url ?? '')) { void this.botflows.route(req, res); return; }
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'strict-transport-security': 'max-age=31536000',
    };
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        ok: true, hub: this.info, fingerprint: this.fingerprint,
        users: this.store.activeUsers().length, pendingDevices: this.store.pendingCount(),
        online: this.onlineUserIds().length, uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      }));
      return;
    }
    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: 'not found' }));
  }

  /**
   * Bot API for office tools (Hopper, Sheets, Sleuth…):
   *   POST /api/bot/message   Authorization: Bearer <token>
   *   { "text": "…", "to": ["DEXTERITY\\\\priya.raman" | "priya.raman"], "space": "Piping P-12",
   *     "card": { "title": "…", "lines": ["…"], "url": "https://…" } }
   * Delivers a Direct message from the bot to each person in "to", and/or posts into the Space.
   */
  private async botRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : '';
    const bot = token ? this.store.botByTokenHash(crypto.createHash('sha256').update(token).digest('hex')) : null;
    if (!bot || bot.role !== 'bot') { req.resume(); reply(401, { ok: false, error: 'Unknown or revoked integration token.' }); return; }
    if (req.method === 'POST' && req.url?.split('?')[0] === '/api/bot/widget') {
      let raw = '';
      try { for await (const c of req) { raw += c; if (raw.length > 16 * 1024) throw new Error('too large'); } } catch { reply(413, { ok: false, error: 'Pulse card too large.' }); return; }
      try {
        const list = this.commands.setWidget(bot.id, JSON.parse(raw) as Record<string, unknown>);
        this.emit('widgets.updated', list);
        reply(200, { ok: true });
      } catch (err) { reply(400, { ok: false, error: (err as Error).message }); }
      return;
    }
    if (req.method !== 'POST' || req.url?.split('?')[0] !== '/api/bot/message') { req.resume(); reply(404, { ok: false, error: 'not found' }); return; }
    let raw = '';
    try {
      for await (const c of req) { raw += c; if (raw.length > 64 * 1024) throw new Error('too large'); }
    } catch { reply(413, { ok: false, error: 'Message too large.' }); return; }
    let body: { text?: unknown; to?: unknown; space?: unknown; card?: { title?: unknown; lines?: unknown; url?: unknown } };
    try { body = JSON.parse(raw); } catch { reply(400, { ok: false, error: 'Invalid JSON.' }); return; }

    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 4000) : '';
    const card = body.card && typeof body.card === 'object' ? body.card : null;
    const cardLines: string[] = [];
    if (card) {
      if (typeof card.title === 'string' && card.title.trim()) cardLines.push(`**${card.title.trim().slice(0, 200)}**`);
      if (Array.isArray(card.lines)) for (const l of card.lines.slice(0, 12)) if (typeof l === 'string' && l.trim()) cardLines.push(`- ${l.trim().slice(0, 300)}`);
      if (typeof card.url === 'string' && /^https?:\/\/\S+$/.test(card.url)) cardLines.push(card.url);
    }
    const message = [text, cardLines.join('\n')].filter(Boolean).join('\n\n');
    if (!message) { reply(400, { ok: false, error: 'Nothing to send: give "text" or a "card".' }); return; }

    const delivered: string[] = [];
    const unknown: string[] = [];
    const clientId = () => `bot-${crypto.randomBytes(8).toString('hex')}`;
    const recipients = Array.isArray(body.to) ? body.to.filter((x): x is string => typeof x === 'string').slice(0, 50) : [];
    for (const who of recipients) {
      const person = this.store.userForAccount(who);
      if (!person || person.role === 'bot') { unknown.push(who); continue; }
      const conv = this.messaging.handle('conv.create', bot, { kind: 'direct', members: [person.id] }) as { id: string };
      this.messaging.handle('msg.send', bot, { convId: conv.id, body: message, clientId: clientId() });
      delivered.push(person.account);
    }
    if (typeof body.space === 'string' && body.space.trim()) {
      const space = this.messaging.spaceByName(body.space.trim());
      if (!space) unknown.push(`space:${body.space}`);
      else {
        this.messaging.ensureMember(space, bot.id);
        this.messaging.handle('msg.send', bot, { convId: space, body: message, clientId: clientId() });
        delivered.push(`space:${body.space.trim()}`);
      }
    }
    this.log('info', 'bot message', { bot: bot.displayName, delivered: delivered.length, unknown: unknown.length });
    reply(delivered.length ? 200 : 404, { ok: delivered.length > 0, delivered, unknown });
  }

  /** POST /api/hooks/<token>: a Slack-style incoming webhook into one Space (at most 60 a minute). */
  private readonly hookRate = new Map<string, number[]>();
  private async hookRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (code: number, text: string) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(text); };
    const m = (req.url ?? '').match(/^\/api\/hooks\/([A-Za-z0-9_-]{20,64})$/);
    if (req.method !== 'POST' || !m) { req.resume(); reply(404, 'no_service'); return; }
    const hook = this.store.db.prepare('SELECT * FROM hooks WHERE token_hash = ?').get(crypto.createHash('sha256').update(m[1]).digest('hex')) as { id: string; bot_id: string; conv_id: string } | undefined;
    const bot = hook ? this.store.userById(hook.bot_id) : null;
    if (!hook || !bot || bot.role !== 'bot' || !this.store.botActive(bot.id)) { req.resume(); reply(404, 'no_service'); return; }
    const now = Date.now();
    const times = (this.hookRate.get(hook.id) ?? []).filter((t) => t > now - 60_000);
    if (times.length >= 60) { req.resume(); reply(429, 'rate_limited'); return; }
    times.push(now); this.hookRate.set(hook.id, times);
    let raw = '';
    try { for await (const c of req) { raw += c; if (raw.length > 256 * 1024) throw new Error('too large'); } } catch { reply(413, 'too_large'); return; }
    let payload: Record<string, unknown>;
    try {
      // Slack also accepts form posts with a "payload" field
      payload = raw.trim().startsWith('{') ? JSON.parse(raw) : JSON.parse(new URLSearchParams(raw).get('payload') ?? '{}');
    } catch { reply(400, 'invalid_payload'); return; }
    const body = slackToMarkdown(payload);
    if (!body) { reply(400, 'no_text'); return; }
    try {
      this.messaging.ensureMember(hook.conv_id, bot.id);
      this.messaging.handle('msg.send', bot, { convId: hook.conv_id, body, clientId: `hook-${crypto.randomBytes(8).toString('hex')}` });
      this.store.db.prepare('UPDATE hooks SET last_used = ? WHERE id = ?').run(now, hook.id);
      reply(200, 'ok');
    } catch (err) { reply(400, (err as Error).message); }
  }

  /** POST /files?name=…&type=…  and  GET /files/<id>[?download=1], authorised by a session file token. */
  private async fileRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'https://hub');
    const sendJson = (code: number, body: unknown) => {
      if (res.headersSent) { res.end(); return; }
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const auth = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : url.searchParams.get('t');
    const userId = auth ? this.fileTokens.get(auth) : undefined;
    const user = userId ? this.store.userById(userId) : null;
    if (!user) { req.resume(); sendJson(401, { error: 'Sign in again to use files.' }); return; }

    if (req.method === 'POST' && url.pathname === '/files') {
      if (user.role === 'guest') { req.resume(); sendJson(403, { error: 'Guests cannot upload files.' }); return; }
      // an encrypted file's type is checked on the sender's device, before it is encrypted
      const sealed = url.searchParams.get('sealed') === '1';
      const ext = (url.searchParams.get('name') ?? '').toLowerCase().match(/\.([a-z0-9]{1,10})$/)?.[1];
      if (!sealed && ext && (this.policies.get().blockedFileTypes ?? []).includes(ext)) { req.resume(); sendJson(403, { error: `Your office doesn't allow .${ext} files to be shared.` }); return; }
      try {
        const info = await this.files.receive(req, user.id, url.searchParams.get('name') ?? 'file', url.searchParams.get('type') ?? undefined, sealed);
        this.log('info', 'file uploaded', { user: user.account, size: info.size });
        sendJson(200, info);
      } catch (err) {
        const e = err as Error & { status?: number };
        req.resume();
        sendJson(e.status ?? 500, { error: e.status ? e.message : 'Upload failed.' });
      }
      return;
    }
    const m = url.pathname.match(/^\/files\/([0-9A-Z]{26})$/);
    if ((req.method === 'GET' || req.method === 'HEAD') && m) {
      if (!this.files.canRead(user.id, m[1])) { sendJson(404, { error: 'not found' }); return; }
      // a recording leaving the hub is in the audit log (once per download, not per byte range)
      if (req.method === 'GET') this.recordings.downloaded(m[1], user.id, /^bytes=[1-9]/.test(req.headers.range ?? ''), String(req.headers['x-dex-remote-ip'] ?? req.socket.remoteAddress ?? ''));
      this.files.serve(req, res, m[1], url.searchParams.get('download') === '1');
      return;
    }
    sendJson(404, { error: 'not found' });
  }

  // ---------------------------------------------------------- websocket
  private accept(ws: WebSocket, req: IncomingMessage): void {
    const conn: Conn = {
      ws, nonce: crypto.randomBytes(24).toString('base64url'), ip: req.socket.remoteAddress ?? '', remote: false,
      alive: true, deviceId: null, userId: null, ready: false, fileToken: null, idle: false,
    };
    // the hub's own loopback for a device on the internet gateway (src/remote.ts)
    const loop = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1' || req.socket.remoteAddress === '::ffff:127.0.0.1';
    if (loop && req.headers['x-dex-gateway'] === this.gatewaySecret) {
      conn.remote = true;
      conn.ip = `internet ${String(req.headers['x-dex-remote-ip'] ?? '').slice(0, 80)}`;
      if (!this.remoteConfig().enabled) { ws.send(JSON.stringify({ t: 'rejected', reason: 'Access from outside the office is turned off.' })); ws.close(); return; }
      if (!this.outsideAllowed(conn)) {
        this.log('info', 'outside connection refused by network policy', { ip: conn.ip });
        ws.send(JSON.stringify({ t: 'rejected', reason: 'Your office allows access from outside only from approved networks.' }));
        ws.close();
        return;
      }
    }
    this.conns.add(conn);
    ws.on('pong', () => { conn.alive = true; });
    ws.on('message', (raw) => {
      conn.alive = true;
      let frame: ClientFrame;
      try { frame = JSON.parse(raw.toString()); } catch { this.send(conn, { t: 'error', error: 'invalid JSON' }); return; }
      this.onFrame(conn, frame).catch((err) => this.log('error', 'frame failed', { error: (err as Error).message }));
    });
    ws.on('close', () => this.onClose(conn));
    ws.on('error', () => { /* close follows */ });
    this.send(conn, { t: 'hello', hub: this.info, nonce: conn.nonce });
  }

  /** The office may limit outside access to some internet addresses (Control room ▸ Policies). */
  private outsideAllowed(conn: Conn): boolean {
    const nets = this.policies.get().outsideNetworks;
    if (!nets?.length) return true;
    const addr = conn.ip.replace(/^internet /, '').split(' ')[0];
    return ipAllowed(addr, nets);
  }

  private send(conn: Conn, frame: ServerFrame): void {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(frame));
  }

  private emit(name: string, data: unknown, filter: (c: Conn) => boolean = () => true): void {
    for (const c of this.conns) if (c.ready && filter(c)) this.send(c, { t: 'evt', name, data });
  }

  /** Send an event to every connected device of the given people. */
  private deliver(userIds: string[], name: string, data: (userId: string) => unknown): void {
    const wanted = new Set(userIds);
    // phones waiting in the background hear about new messages too
    if (name === 'msg.new') this.missed.wake(wanted);
    const cache = new Map<string, unknown>();
    for (const c of this.conns) {
      if (!c.ready || !c.userId || !wanted.has(c.userId)) continue;
      if (!cache.has(c.userId)) cache.set(c.userId, data(c.userId));
      this.send(c, { t: 'evt', name, data: cache.get(c.userId) });
    }
  }

  /** People others can see online (invisible people are left out). */
  private onlineUserIds(viewer?: string): string[] {
    const ids = new Set([...this.conns].filter((c) => c.ready && c.userId).map((c) => c.userId!));
    for (const id of ids) {
      if (id !== viewer && this.store.userById(id)?.availability === 'invisible') ids.delete(id);
    }
    return [...ids];
  }

  /** Away = every connected device of the person is idle. */
  private isAway(userId: string): boolean {
    let any = false;
    for (const c of this.conns) {
      if (!c.ready || c.userId !== userId) continue;
      any = true;
      if (!c.idle) return false;
    }
    return any;
  }

  private announcePresence(userId: string, except?: Conn): void {
    const online = this.isOnline(userId, except) && this.store.userById(userId)?.availability !== 'invisible';
    this.emit('presence', { userId, online, away: online && this.isAway(userId) }, (c) => c !== except && c.userId !== userId);
  }

  private isOnline(userId: string, except?: Conn): boolean {
    for (const c of this.conns) if (c !== except && c.ready && c.userId === userId) return true;
    return false;
  }

  private onClose(conn: Conn): void {
    this.conns.delete(conn);
    if (conn.deviceId && conn.ready) { this.rooms.leaveAll(conn.deviceId); this.pointers.dropDevice(conn.deviceId); this.webinars.leaveDevice(conn.deviceId); }
    // keep the token briefly so a download that is already running can finish
    if (conn.fileToken) { const t = conn.fileToken; setTimeout(() => this.fileTokens.delete(t), 10 * 60 * 1000).unref(); }
    if (conn.ready && conn.userId) this.announcePresence(conn.userId);
    // "last seen": the moment this device went away
    if (conn.ready && conn.deviceId) {
      this.store.touchDevice(conn.deviceId);
      if (conn.userId && ![...this.conns].some((c) => c.ready && c.userId === conn.userId)) {
        const u = this.store.userById(conn.userId);
        // someone offboarded is not put back in colleagues' lists as they are signed out
        if (u && !u.leftAt) this.emit('user.updated', u);
      }
    }
  }

  private proofOk(conn: Conn, deviceId: string, publicKey: string, sig: unknown): boolean {
    return typeof sig === 'string' && verifySignature(publicKey, authPayload(conn.nonce, this.fingerprint, deviceId), sig);
  }

  private async onFrame(conn: Conn, frame: ClientFrame): Promise<void> {
    if (frame.t === 'auth') return this.onAuth(conn, frame);
    if (frame.t === 'register') return this.onRegister(conn, frame);
    if (frame.t === 'req') return this.onRequest(conn, frame);
    this.send(conn, { t: 'error', error: 'unknown frame' });
  }

  private onAuth(conn: Conn, frame: Extract<ClientFrame, { t: 'auth' }>): void {
    if (conn.ready) return;
    const device = typeof frame.deviceId === 'string' ? this.store.device(frame.deviceId) : null;
    if (!device) { this.send(conn, { t: 'unknown' }); return; }
    if (!this.proofOk(conn, device.id, device.publicKey, frame.sig)) {
      this.send(conn, { t: 'rejected', reason: 'This device could not prove its identity.' });
      conn.ws.close();
      return;
    }
    conn.deviceId = device.id;
    conn.userId = device.userId;
    this.continueAs(conn, device);
  }

  private onRegister(conn: Conn, frame: Extract<ClientFrame, { t: 'register' }>): void {
    if (conn.ready) return;
    if (typeof frame.pair === 'string' && frame.pair && !this.store.device(String(frame.deviceId ?? ''))) { this.onPair(conn, frame); return; }
    if (conn.remote && !this.store.device(String(frame.deviceId ?? '')) && !this.remoteConfig().allowJoin) {
      this.send(conn, { t: 'rejected', reason: 'New devices join from the office network. Ask your administrator if you need to join from outside.' });
      conn.ws.close();
      return;
    }
    if (conn.remote && !this.store.device(String(frame.deviceId ?? ''))) {
      // a setup code is not a secret: keep strangers from flooding the approval queue
      const hour = Date.now() - 3600_000;
      this.remoteJoins = this.remoteJoins.filter((t) => t > hour);
      if (this.remoteJoins.length >= 10) {
        this.send(conn, { t: 'rejected', reason: 'Too many new devices asked to join from outside in the last hour. Try again later.' });
        conn.ws.close();
        return;
      }
      this.remoteJoins.push(Date.now());
    }
    const account = validAccount(frame.account);
    if (!account || typeof frame.publicKey !== 'string' || deviceIdFor(frame.publicKey) !== frame.deviceId) {
      this.send(conn, { t: 'rejected', reason: 'Malformed registration.' });
      conn.ws.close();
      return;
    }
    if (!this.proofOk(conn, frame.deviceId, frame.publicKey, frame.sig)) {
      this.send(conn, { t: 'rejected', reason: 'This device could not prove its identity.' });
      conn.ws.close();
      return;
    }
    const existingDevice = this.store.device(frame.deviceId);
    if (existingDevice) {
      conn.deviceId = existingDevice.id;
      conn.userId = existingDevice.userId;
      this.continueAs(conn, existingDevice);
      return;
    }
    if (this.store.pendingCount() >= 500) {
      this.send(conn, { t: 'rejected', reason: 'Too many devices are waiting for approval. Ask an administrator.' });
      conn.ws.close();
      return;
    }

    const key = accountKey(account);
    const first = this.store.userCount() === 0;
    let user = this.store.userByAccount(key);
    // a guest invite approves a new person straight away, as a guest
    let invite: ReturnType<Guests['check']> | null = null;
    if (!first && typeof frame.invite === 'string' && frame.invite.trim() && (!user || user.role === 'guest')) {
      if (user && this.offboarding.hasLeft(user.id)) {
        this.send(conn, { t: 'rejected', reason: 'This account has left the office. Ask an administrator if you need access again.' });
        conn.ws.close();
        return;
      }
      invite = this.guests.check(frame.invite.slice(0, 40));
      if ('error' in invite) {
        this.send(conn, { t: 'rejected', reason: invite.error });
        conn.ws.close();
        return;
      }
    }
    if (!user) user = this.store.createUser(key, account.displayName, first ? 'owner' : invite ? 'guest' : 'member');
    const device = this.store.createDevice(frame.deviceId, user.id, frame.publicKey, account.hostname, first || invite ? 'approved' : 'pending');
    if (invite && 'invite' in invite) {
      this.guests.admit(user.id, invite.invite);
      this.emit('user.added', user);
    }
    if (first) {
      this.messaging.ensureEveryoneSpace(user.id);
      this.messaging.welcome(user.id);
    }
    this.store.audit(first ? user.id : null, 'device.registered', device.id, { account: key, hostname: account.hostname, ip: conn.ip, autoApproved: first });
    this.log('info', 'device registered', { account: key, hostname: account.hostname, status: device.status });

    conn.deviceId = device.id;
    conn.userId = user.id;
    if (device.status === 'pending') {
      this.emit('admin.pending', device, (c) => this.isAdminConn(c));
    }
    this.continueAs(conn, device);
  }

  /** A new device of someone who already has an approved one, carrying their pairing token. */
  private onPair(conn: Conn, frame: Extract<ClientFrame, { t: 'register' }>): void {
    const fail = (reason: string) => { this.send(conn, { t: 'rejected', reason }); conn.ws.close(); };
    const account = validAccount(frame.account);
    if (!account || typeof frame.publicKey !== 'string' || deviceIdFor(frame.publicKey) !== frame.deviceId) { fail('Malformed registration.'); return; }
    if (!this.proofOk(conn, frame.deviceId, frame.publicKey, frame.sig)) { fail('This device could not prove its identity.'); return; }
    if (this.policies.get().personalDevices === false) { fail('Your administrator has turned off adding personal devices. Ask them to approve this device instead.'); return; }
    // guessing tokens is pointless (144 random bits) but keep failed tries cheap and rare
    const hour = Date.now() - 3600_000;
    this.pairFails = this.pairFails.filter((t) => t > hour);
    if (this.pairFails.length >= 60) { fail('Too many pairing attempts. Try again in an hour.'); return; }
    const r = this.pairing.consume(String(frame.pair), frame.deviceId);
    if ('error' in r) { this.pairFails.push(Date.now()); fail(r.error); return; }
    const user = this.store.userById(r.userId);
    if (!user || user.role === 'bot' || !this.store.devices().some((x) => x.userId === user.id && x.status === 'approved')) { fail('That account is not active any more.'); return; }
    const label = `${account.hostname || (r.kind === 'phone' ? 'Phone' : 'Laptop')}`.slice(0, 60);
    const device = this.store.createDevice(frame.deviceId, user.id, frame.publicKey, label, 'approved');
    this.store.audit(user.id, 'device.paired', device.id, { kind: r.kind, hostname: label, ip: conn.ip, remote: !!conn.remote });
    this.log('info', 'device paired', { user: user.account, kind: r.kind, hostname: label });
    this.emit('me.devicePaired', device, (c) => c.userId === user.id);
    this.system.tell(user.id, `**${label}** was added to your account with a pairing code (${conn.remote ? 'from outside the office' : 'on the office network'}). If that wasn't you, remove it now in **Preferences → Your devices**.`, `paired-${device.id}`);
    this.emit('device.updated', device, (c) => this.isAdminConn(c));
    conn.deviceId = device.id;
    conn.userId = user.id;
    this.continueAs(conn, device);
  }
  private pairFails: number[] = [];

  private isAdminConn(c: Conn): boolean {
    if (!c.userId) return false;
    const u = this.store.userById(c.userId);
    return !!u && isAdminRole(u.role);
  }

  /** Move a connection into the state its device record dictates. */
  private continueAs(conn: Conn, device: DeviceRecord): void {
    if (device.status === 'pending') {
      this.send(conn, { t: 'pending', position: this.store.pendingPosition(device.id) });
      return;
    }
    if (device.status !== 'approved') {
      this.send(conn, { t: 'rejected', reason: device.status === 'revoked' ? 'This device was removed by an administrator.' : 'An administrator declined this device.' });
      conn.ws.close();
      return;
    }
    const wasOnline = this.isOnline(device.userId, conn);
    conn.ready = true;
    conn.fileToken = crypto.randomBytes(24).toString('base64url');
    this.fileTokens.set(conn.fileToken, device.userId);
    this.store.touchDevice(device.id);
    this.send(conn, { t: 'ready', session: this.sessionFor(conn) });
    if (!wasOnline || this.isAway(device.userId) === false) this.announcePresence(device.userId, undefined);
    try { this.botflows.onReady(device.userId); } catch (err) { this.log('warn', 'resume offer failed', { error: (err as Error).message }); }
  }

  private sessionFor(conn: Conn): Session {
    return {
      hub: this.info,
      me: this.store.userById(conn.userId!)!,
      deviceId: conn.deviceId!,
      users: this.guests.visibleTo(this.store.userById(conn.userId!)!, this.store.activeUsers()),
      online: this.onlineUserIds(conn.userId!),
      away: [...new Set(this.onlineUserIds(conn.userId!).filter((id) => this.isAway(id)))],
      inRoom: this.rooms.inRoomUsers(),
      inMeeting: [...this.inMeeting],
      fileToken: conn.fileToken!,
    };
  }

  // ----------------------------------------------------------- requests
  private async onRequest(conn: Conn, frame: Extract<ClientFrame, { t: 'req' }>): Promise<void> {
    if (!conn.ready || !conn.userId) { this.send(conn, { t: 'error', error: 'not signed in' }); return; }
    const id = typeof frame.id === 'string' ? frame.id.slice(0, 64) : '';
    try {
      if (conn.remote && typeof frame.op === 'string' && frame.op.startsWith('admin.') && !this.remoteConfig().allowAdmin) {
        throw new OpError('The Control room is only available on the office network.');
      }
      const data = await this.op(conn, frame.op as OpName, frame.data);
      this.send(conn, { t: 'res', id, ok: true, data });
    } catch (err) {
      const message = err instanceof OpError ? err.message : 'internal error';
      if (!(err instanceof OpError)) this.log('error', 'request failed', { op: frame.op, error: (err as Error).message });
      this.send(conn, { t: 'res', id, ok: false, error: message });
    }
  }

  /** Timed availability returns to Available; out of office ends on its date. */
  private inMeeting = new Set<string>();
  private presenceTick(now = Date.now()): void {
    // "in a meeting", from the calendar
    const meeting = this.calendar.inMeetingNow(now);
    for (const u of meeting) if (!this.inMeeting.has(u)) this.emit('meeting.busy', { userId: u, inMeeting: true });
    for (const u of this.inMeeting) if (!meeting.has(u)) this.emit('meeting.busy', { userId: u, inMeeting: false });
    this.inMeeting = meeting;
    const rows = this.store.db.prepare('SELECT id, availability, availability_until, ooo FROM users WHERE (availability_until IS NOT NULL AND availability_until <= ?) OR ooo IS NOT NULL').all(now) as Array<{ id: string; availability: string; availability_until: number | null; ooo: string | null }>;
    for (const r of rows) {
      let changed = false;
      if (r.availability_until !== null && r.availability_until <= now) {
        this.store.updateUser(r.id, { availability: 'available' });
        this.store.setPresenceExtras(r.id, { availabilityUntil: null });
        changed = true;
        if (r.availability === 'invisible') this.announcePresence(r.id);
      }
      const u = this.store.userById(r.id);
      if (u?.ooo && u.ooo.until <= now) { this.store.setPresenceExtras(r.id, { ooo: null }); changed = true; }
      if (changed) { const fresh = this.store.userById(r.id); if (fresh) this.emit('user.updated', fresh); }
    }
  }

  private requireAdmin(conn: Conn): PublicUser {
    const me = this.store.userById(conn.userId!);
    if (!me || !isAdminRole(me.role)) throw new OpError('Only administrators can do that.');
    return me;
  }

  private async op(conn: Conn, op: OpName, data: unknown): Promise<unknown> {
    const d = (data ?? {}) as Record<string, unknown>;
    switch (op) {
      case 'ping':
        return { at: Date.now() } satisfies Ops['ping']['res'];

      case 'directory.list':
        return { users: this.guests.visibleTo(this.store.userById(conn.userId!)!, this.store.activeUsers()), online: this.onlineUserIds(conn.userId!) } satisfies Ops['directory.list']['res'];

      case 'me.update': {
        const patch: { displayName?: string; title?: string | null; statusText?: string | null } = {};
        if (d.displayName !== undefined) {
          const n = clean(d.displayName, 80);
          if (!n) throw new OpError('Name cannot be empty.');
          patch.displayName = n;
        }
        if (d.title !== undefined) patch.title = d.title === null ? null : clean(d.title, 80) || null;
        if (d.statusText !== undefined) patch.statusText = d.statusText === null ? null : clean(d.statusText, 120) || null;
        const before = this.store.userById(conn.userId!)!;
        if (d.availability !== undefined) {
          if (!['available', 'busy', 'dnd', 'invisible'].includes(String(d.availability))) throw new OpError('Unknown availability.');
          (patch as { availability?: string }).availability = String(d.availability);
        }
        this.store.updateUser(conn.userId!, patch as never);
        if (d.availability !== undefined) {
          const until = typeof d.until === 'number' && d.until > Date.now() && d.availability !== 'available' ? Math.floor(d.until) : null;
          this.store.setPresenceExtras(conn.userId!, { availabilityUntil: until });
        }
        if (typeof d.readReceipts === 'boolean') {
          this.store.setPrefs(conn.userId!, { receipts: d.readReceipts });
          // everyone's view of who read what changes with it
          for (const c of this.messaging.convIdsOf(conn.userId!)) this.messaging.pushConvTo(c);
        }
        if (d.statusEmoji !== undefined) {
          const e = typeof d.statusEmoji === 'string' ? d.statusEmoji.trim() : '';
          if (e && !/^[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f]{1,16}$/u.test(e)) throw new OpError('Choose an emoji for your status.');
          this.store.setPrefs(conn.userId!, { statusEmoji: e || null });
        }
        if (d.ooo !== undefined) {
          const o = d.ooo as { until?: unknown; message?: unknown; delegateId?: unknown } | null;
          if (o === null) this.store.setPresenceExtras(conn.userId!, { ooo: null });
          else {
            if (typeof o.until !== 'number' || o.until <= Date.now()) throw new OpError('Choose when you are back.');
            const delegate = typeof o.delegateId === 'string' && o.delegateId !== conn.userId && this.store.userById(o.delegateId) ? o.delegateId : null;
            this.store.setPresenceExtras(conn.userId!, { ooo: { until: Math.floor(o.until), message: clean(o.message, 300) || null, delegateId: delegate } });
          }
        }
        const user = this.store.userById(conn.userId!)!;
        this.emit('user.updated', user);
        if (before.availability !== user.availability && (before.availability === 'invisible' || user.availability === 'invisible')) this.announcePresence(user.id);
        return user;
      }

      case 'pair.create': {
        const me = this.store.userById(conn.userId!)!;
        if (me.role === 'guest' || me.role === 'bot') throw new OpError('Guests add devices through an invite from an administrator.');
        if (this.policies.get().personalDevices === false) throw new OpError('Your administrator has turned off adding personal devices.');
        const kind = d.kind === 'laptop' ? 'laptop' : 'phone';
        const t = this.pairing.create(me.id, kind);
        const rc = this.remoteConfig();
        const code = pairCode({ hubId: this.info.id, fp: this.fingerprint, name: this.info.name, lan: lanAddresses(this.port), url: rc.enabled ? rc.url : null, token: t.token, kind });
        this.store.audit(me.id, 'pair.created', null, { kind });
        return { code, link: pairLink(code), expiresAt: t.expiresAt } satisfies Ops['pair.create']['res'];
      }

      case 'me.devices': {
        return this.store.devices().filter((x) => x.userId === conn.userId && (x.status === 'approved' || x.status === 'pending'))
          .map((x) => ({ ...x, current: x.id === conn.deviceId, paired: this.pairing.isPaired(x.id) }))
          .sort((a, b) => Number(b.current) - Number(a.current) || (b.lastSeen ?? b.createdAt) - (a.lastSeen ?? a.createdAt)) satisfies Ops['me.devices']['res'];
      }

      case 'me.devices.remove': {
        const device = typeof d.deviceId === 'string' ? this.store.device(d.deviceId) : null;
        if (!device || device.userId !== conn.userId) throw new OpError('Device not found.');
        if (device.id === conn.deviceId) throw new OpError('You cannot remove the device you are using.');
        const updated = this.store.setDeviceStatus(device.id, 'revoked', conn.userId!);
        this.store.audit(conn.userId!, 'device.removedByOwner', device.id, { hostname: device.hostname });
        for (const c of [...this.conns]) {
          if (c.deviceId === device.id) { this.send(c, { t: 'rejected', reason: 'This device was removed from your account.' }); c.ws.close(); }
        }
        this.emit('device.updated', updated, (c) => this.isAdminConn(c));
        return { ok: true } satisfies Ops['me.devices.remove']['res'];
      }

      case 'me.idle': {
        const was = this.isAway(conn.userId!);
        conn.idle = d.idle === true;
        if (was !== this.isAway(conn.userId!)) this.announcePresence(conn.userId!);
        return { ok: true } satisfies Ops['me.idle']['res'];
      }

      case 'admin.devices':
        this.requireAdmin(conn);
        return this.store.devices();

      case 'admin.decide': {
        const me = this.requireAdmin(conn);
        const device = typeof d.deviceId === 'string' ? this.store.device(d.deviceId) : null;
        if (!device) throw new OpError('Device not found.');
        if (device.status !== 'pending') throw new OpError('That device was already handled.');
        const approve = d.approve === true;
        if (approve && this.offboarding.hasLeft(device.userId)) throw new OpError(`${device.displayName} has left the office. Give them access again first: Control room ▸ Backups & leavers.`);
        const wasActive = this.store.activeUsers().some((u) => u.id === device.userId);
        const updated = this.store.setDeviceStatus(device.id, approve ? 'approved' : 'rejected', me.id);
        this.store.audit(me.id, approve ? 'device.approved' : 'device.rejected', device.id, { account: device.account });
        this.emit('device.updated', updated, (c) => this.isAdminConn(c));
        if (approve && !wasActive) {
          const user = this.store.userById(device.userId);
          if (user) this.emit('user.added', user);
          this.messaging.welcome(device.userId);
          this.messaging.joinDefaults(device.userId, this.policies.get().defaultSpaces ?? []);
          // people who were imported as reporting to this person now resolve to them
          if (user) this.org.announceReportsOf(user.account);
        }
        for (const c of this.conns) if (c.deviceId === device.id && !c.ready) this.continueAs(c, updated);
        return updated;
      }

      case 'admin.revoke': {
        const me = this.requireAdmin(conn);
        const device = typeof d.deviceId === 'string' ? this.store.device(d.deviceId) : null;
        if (!device) throw new OpError('Device not found.');
        if (device.id === conn.deviceId) throw new OpError('You cannot remove the device you are using.');
        const updated = this.store.setDeviceStatus(device.id, 'revoked', me.id);
        this.missed.revoke(device.id);
        this.store.audit(me.id, 'device.revoked', device.id, { account: device.account });
        if (device.status === 'approved') this.system.tell(device.userId, `An administrator removed **${device.hostname}** from your account. It is signed out and can't be used to sign in again.`, `revoked-${device.id}`);
        for (const c of [...this.conns]) {
          if (c.deviceId === device.id) {
            this.send(c, { t: 'rejected', reason: 'This device was removed by an administrator.' });
            c.ws.close();
          }
        }
        this.emit('device.updated', updated, (c) => this.isAdminConn(c));
        return updated;
      }

      case 'admin.setRole': {
        const me = this.requireAdmin(conn);
        const target = typeof d.userId === 'string' ? this.store.userById(d.userId) : null;
        if (!target) throw new OpError('Person not found.');
        if (target.id === me.id) throw new OpError('You cannot change your own role.');
        if (target.role === 'owner') throw new OpError('The workspace owner cannot be changed.');
        const role = d.role;
        if (role !== 'admin' && role !== 'member' && role !== 'guest') throw new OpError('Unknown role.');
        if (target.role === 'admin' && me.role !== 'owner') throw new OpError('Only the owner can change an administrator.');
        const user = this.store.updateUser(target.id, { role });
        this.store.audit(me.id, 'user.role', target.id, { from: target.role, to: role });
        this.system.tell(target.id, role === 'admin' ? 'You are now an **administrator**: the Control room is in your tile menu.' : role === 'member' ? (target.role === 'guest' ? 'You are now a **member** of the office: you can see open Spaces and the whole Directory.' : 'You are no longer an administrator.') : 'Your account is now a **guest** account: you see only the Spaces you were invited to.', `role-${target.id}-${Date.now()}`);
        this.emit('user.updated', user);
        return user;
      }

      case 'admin.audit': {
        this.requireAdmin(conn);
        const limit = typeof d.limit === 'number' ? Math.max(1, Math.min(1000, d.limit)) : 200;
        return this.store.auditTrail(limit);
      }

      case 'admin.bots':
        this.requireAdmin(conn);
        return this.store.bots();

      case 'e2e.publish': {
        const encKey = typeof d.encKey === 'string' ? d.encKey : '';
        const sig = typeof d.sig === 'string' ? d.sig : '';
        const dev = this.store.device(conn.deviceId!);
        if (!dev || !/^[A-Za-z0-9+/]{43}=$/.test(encKey) || !verifySignature(dev.publicKey, encKeyStatement(dev.id, encKey), sig)) throw new OpError('That encryption key is not valid.');
        const cur = this.store.db.prepare('SELECT enc_key FROM devices WHERE id = ?').get(dev.id) as { enc_key: string | null };
        if (cur.enc_key !== encKey) {
          this.store.db.prepare('UPDATE devices SET enc_key = ?, enc_sig = ? WHERE id = ?').run(encKey, sig, dev.id);
          this.emit('e2e.keysChanged', { userId: dev.userId, deviceId: dev.id });
        }
        return { ok: true } satisfies Ops['e2e.publish']['res'];
      }

      case 'e2e.keys': {
        const ids = Array.isArray(d.userIds) ? d.userIds.filter((x): x is string => typeof x === 'string').slice(0, 200) : [];
        if (!ids.length) return [];
        const rows = this.store.db.prepare(`SELECT id, user_id, public_key, enc_key, enc_sig FROM devices WHERE status = 'approved' AND enc_key IS NOT NULL AND user_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ id: string; user_id: string; public_key: string; enc_key: string; enc_sig: string }>;
        return rows.map((r) => ({ userId: r.user_id, deviceId: r.id, signKey: r.public_key, encKey: r.enc_key, sig: r.enc_sig })) satisfies Ops['e2e.keys']['res'];
      }

      case 'notify.missed': {
        const limit = typeof d.limit === 'number' && Number.isFinite(d.limit) ? d.limit : 50;
        return this.missed.list(conn.userId!, d.after, limit) satisfies Ops['notify.missed']['res'];
      }

      case 'notify.token':
        return { token: this.missed.token(conn.deviceId!, conn.userId!) } satisfies Ops['notify.token']['res'];

      case 'e2e.addKeys': {
        const me = this.store.userById(conn.userId!)!;
        const owner = (deviceId: string) => this.store.device(deviceId)?.userId ?? null;
        return { updated: this.messaging.addKeys(me, d.items, owner) } satisfies Ops['e2e.addKeys']['res'];
      }

      case 'admin.bots.create': {
        const me = this.requireAdmin(conn);
        const name = clean(d.name, 40);
        if (!name) throw new OpError('Give the integration a name.');
        const key = `bot\\${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        const bot = this.store.userByAccount(key) ?? this.store.createUser(key, name, 'bot');
        if (bot.role !== 'bot') throw new OpError('That name is taken.');
        const token = `dxc_${crypto.randomBytes(24).toString('base64url')}`;
        this.store.createBotToken(bot.id, crypto.createHash('sha256').update(token).digest('hex'), me.id);
        this.store.audit(me.id, 'bot.created', bot.id, { name });
        this.emit('user.added', bot);
        return { bot, token } satisfies Ops['admin.bots.create']['res'];
      }

      case 'admin.hooks.list': {
        this.requireAdmin(conn);
        return (this.store.db.prepare('SELECT h.*, c.name AS conv_name FROM hooks h JOIN conversations c ON c.id = h.conv_id ORDER BY h.created_at DESC').all() as Array<{ id: string; bot_id: string; conv_id: string; conv_name: string | null; created_at: number; last_used: number | null }>)
          .map((h) => ({ id: h.id, botId: h.bot_id, convId: h.conv_id, convName: h.conv_name ?? 'Space', createdAt: h.created_at, lastUsed: h.last_used })) satisfies Ops['admin.hooks.list']['res'];
      }

      case 'admin.hooks.create': {
        const me = this.requireAdmin(conn);
        const bot = typeof d.botId === 'string' ? this.store.userById(d.botId) : null;
        if (!bot || bot.role !== 'bot') throw new OpError('Choose an integration.');
        const conv = typeof d.convId === 'string' ? this.messaging.handle('conv.list', me, {}) as Array<{ id: string; kind: string }> : [];
        const target = conv.find((c) => c.id === d.convId && c.kind === 'space');
        if (!target) throw new OpError('Choose a Space you are in.');
        const token = crypto.randomBytes(24).toString('base64url');
        const id = crypto.randomBytes(8).toString('hex');
        this.store.db.prepare('INSERT INTO hooks (id, token_hash, bot_id, conv_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, crypto.createHash('sha256').update(token).digest('hex'), bot.id, target.id, me.id, Date.now());
        this.messaging.ensureMember(target.id, bot.id);
        this.store.audit(me.id, 'hook.created', bot.id, { space: target.id });
        return { id, path: `/api/hooks/${token}` } satisfies Ops['admin.hooks.create']['res'];
      }

      case 'admin.hooks.revoke': {
        const me = this.requireAdmin(conn);
        this.store.db.prepare('DELETE FROM hooks WHERE id = ?').run(String(d.id ?? ''));
        this.store.audit(me.id, 'hook.revoked', null, { id: d.id });
        return { ok: true } satisfies Ops['admin.hooks.revoke']['res'];
      }

      case 'admin.bots.revoke': {
        const me = this.requireAdmin(conn);
        const bot = typeof d.userId === 'string' ? this.store.userById(d.userId) : null;
        if (!bot || bot.role !== 'bot') throw new OpError('Integration not found.');
        this.store.revokeBotTokens(bot.id);
        this.store.audit(me.id, 'bot.revoked', bot.id, { name: bot.displayName });
        return { ok: true } satisfies Ops['admin.bots.revoke']['res'];
      }

      case 'admin.updates': {
        this.requireAdmin(conn);
        if (d.refresh === true && this.mirror) void this.mirror.refresh();
        const st = this.mirror?.status;
        return {
          enabled: !!this.mirror,
          checking: st?.checking ?? false,
          lastCheck: st?.lastCheck ?? null,
          lastError: st?.lastError ?? null,
          channels: st?.channels ?? {},
        } satisfies Ops['admin.updates']['res'];
      }

      case 'meet.guestLink': {
        const me = this.store.userById(conn.userId!)!;
        const m = this.meetings.get(d.id);
        if (!m) throw new OpError('No meeting has that ID.');
        const live = this.rooms.live(m.id);
        const may = m.hostId === me.id || m.coHosts.includes(me.id) || (!!live && (live.hostId === me.id || (live.coHosts ?? []).includes(me.id)));
        if (!may) throw new OpError('Only the host and co-hosts can see or change the guest link.');
        const allowed = this.policies.get().guestLinks !== false;
        let next = m;
        if (d.enabled !== undefined || d.regenerate === true) {
          if (d.enabled === true && !allowed) throw new OpError('Your office has turned guest links off (Control room ▸ Policies ▸ Meetings).');
          next = this.meetings.setGuest(m, typeof d.enabled === 'boolean' ? d.enabled : undefined, d.regenerate === true);
          this.store.audit(me.id, d.regenerate === true ? 'meeting.guestLinkRenewed' : next.guest.enabled ? 'meeting.guestLinkOn' : 'meeting.guestLinkOff', m.id, {});
        }
        const rc = this.remoteConfig();
        const view = this.meetings.guestView(next, { gateway: rc.enabled ? rc.url : null, allowed, relayOnly: live?.mode === 'relay' || this.meetings.expected(next) > 8 });
        // the link guests are sent: the meeting's page on the office's meeting site
        return { ...view, url: view.url ? this.meetPublic.view(next).guestUrl : null };
      }

      case 'meet.public.get':
      case 'meet.public.set': {
        const me = this.store.userById(conn.userId!)!;
        const m = this.meetings.get(d.id);
        if (!m) throw new OpError('No meeting has that ID.');
        const live = this.rooms.live(m.id);
        const may = m.hostId === me.id || m.coHosts.includes(me.id) || (!!live && (live.hostId === me.id || (live.coHosts ?? []).includes(me.id)));
        if (!may) throw new OpError('Only the host and co-hosts can see or change the meeting\'s page.');
        try {
          return op === 'meet.public.get' ? this.meetPublic.view(m) : this.meetPublic.set(m, me, d);
        } catch (err) { if (err instanceof PublicPageError) throw new OpError(err.message); throw err; }
      }

      case 'meet.slug.check': {
        const me = this.store.userById(conn.userId!)!;
        const m = typeof d.id === 'string' ? this.meetings.get(d.id) : null;
        const slug = normalizeSlug(typeof d.slug === 'string' ? d.slug : '');
        const problem = this.meetPublic.availability(slug, m?.id ?? null, m?.hostId ?? me.id);
        return { slug, ok: !problem, problem };
      }

      case 'meet.personal.slug': {
        const me = this.store.userById(conn.userId!)!;
        try {
          const m = this.meetings.personal(me);
          this.meetPublic.setSlug(m, typeof d.slug === 'string' ? d.slug : null, me.id);
          return this.meetPublic.view(m);
        } catch (err) { if (err instanceof PublicPageError || err instanceof MeetingError) throw new OpError(err.message); throw err; }
      }

      case 'meet.report': {
        const me = this.store.userById(conn.userId!)!;
        try {
          return this.reports.report(d.roomId, me, (meetingId, userId) => { const m = meetingId ? this.meetings.get(meetingId) : null; return !!m && (m.hostId === userId || m.coHosts.includes(userId)); });
        } catch (err) {
          if (err instanceof ReportError) throw new OpError(err.message);
          throw err;
        }
      }

      case 'admin.meetings.usage': {
        this.requireAdmin(conn);
        const days = typeof d.days === 'number' && [28, 91, 182, 364].includes(d.days) ? d.days : 91;
        return this.reports.usage(days, this.recordings.stats(Date.now() - days * 86400_000));
      }

      default: {
        if (typeof op === 'string' && op.startsWith('rec.')) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.recordings.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof RecordingError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && op.startsWith('relay.')) {
          const me = this.store.userById(conn.userId!)!;
          // media through the relay stays on the office network
          if (conn.remote) throw new OpError('Large Rooms work on the office network. From outside, join Rooms of up to 8 people.');
          // a webinar's stage has a relay room of its own: the broadcaster sends to it, attendees on the office network take from it
          const stage = d.stage !== undefined;
          const room = stage ? this.webinars.stageRoom(conn.deviceId!, d.stage) : this.rooms.roomOf(conn.deviceId!, d.roomId ?? undefined);
          if (stage && !room) throw new OpError('The webinar\'s stage is not on.');
          if (stage && op === 'relay.produce' && !this.webinars.isBroadcaster(conn.deviceId!, d.stage)) throw new OpError('Only the PC composing the stage sends to it.');
          try {
            const result = await this.relay.handle(op, me.id, conn.deviceId!, d, room);
            if (result !== undefined) return result;
          } catch (err) {
            throw new OpError(err instanceof RelayError ? err.message : `The relay could not do that (${(err as Error).message}).`);
          }
        }
        if (typeof op === 'string' && op.startsWith('web.')) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = await this.webinars.handle(op, me, conn.deviceId!, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof WebinarError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(meet\.(thread|recap|recapChat|recapFor)$|ap\.(create|update|list)$|agenda\.(get|set|tick)$)/.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            switch (op) {
              case 'meet.thread': return this.meetThreads.threadInfo(me, d, (id) => this.meetings.get(id));
              case 'meet.recap': return this.meetThreads.recap(me, d.occurrenceId);
              case 'meet.recapChat': return this.meetThreads.recapChat(me, d);
              case 'meet.recapFor': return this.meetThreads.recapFor(me, d.eventId, d.slotStart);
              case 'ap.create': return this.meetThreads.createAction(me, d);
              case 'ap.update': return this.meetThreads.updateAction(me, d);
              case 'ap.list': return this.meetThreads.listActions(me, d);
              default: return this.meetThreads.agenda(me, op, d);
            }
          } catch (err) {
            if (err instanceof ThreadError || err instanceof MsgError || err instanceof RoomError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && (op.startsWith('room.') || op.startsWith('meet.'))) {
          const me = this.store.userById(conn.userId!)!;
          try {
            // a device outside the office cannot reach the relay: it gets PC-to-PC Rooms
            const result = this.rooms.handle(op, me, conn.deviceId!, conn.remote ? { ...d, fromOutside: true } : d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof RoomError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(help\.|admin\.help\.)/.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.helpdesk.handle(op, me, conn.deviceId!, d, conn.remote);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof HelpError || err instanceof RoomError || err instanceof MsgError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && op.startsWith('lounge.')) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.lounges.handle(op, me, conn.deviceId!, d, conn.remote);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof LoungeError || err instanceof RoomError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && op.startsWith('point.')) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.pointers.handle(op, me, conn.deviceId!, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof PointerError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(note\.|board\.)/.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.workspace.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof WorkspaceError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(cmd\.|admin\.bots\.commands$|actions\.list$|action\.run$|widgets\.list$)/.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = await this.commands.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof CommandError || err instanceof MsgError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(flow\.|admin\.flows\.)/.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = await this.flows.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof FlowError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(botflow\.|admin\.botflows\.|botnet\.|botjob\.|admin\.botjob\.)/.test(op)) {
          try {
            const result = await this.botflows.handle(op, this.store.userById(conn.userId!)!, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof BotFlowsError || err instanceof BotFlowError || err instanceof MsgError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(miniapp\.|admin\.miniapps\.)/.test(op)) {
          try {
            const result = this.miniapps.handle(op, this.store.userById(conn.userId!)!, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof MiniAppError || err instanceof MsgError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && op.startsWith('admin.compliance.')) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.compliance.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof ComplianceError) throw new OpError(err.message);
            if ((err as { status?: number }).status) throw new OpError((err as Error).message);
            throw err;
          }
        }
        if (typeof op === 'string' && op.startsWith('admin.guests.')) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.guests.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof GuestError || err instanceof MsgError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(cal\.|admin\.cal\.)/.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            // the meeting's thread follows the invitations (meet-threads.ts)
            const before = op === 'cal.update' && typeof d.eventId === 'string'
              ? (this.store.db.prepare('SELECT user_id FROM event_attendees WHERE event_id = ?').all(d.eventId) as Array<{ user_id: string }>).map((r) => r.user_id) : [];
            const result = this.calendar.handle(op, me, d);
            if ((op === 'cal.create' || op === 'cal.update') && result && typeof (result as { id?: unknown }).id === 'string') {
              const id = (result as { id: string }).id;
              try {
                const had = (result as { convId: string | null }).convId;
                this.meetThreads.eventSaved(id, before);
                if (!had) { this.calendar.pushEvent(id); return this.calendar.handle('cal.get', me, { eventId: id }); }
              } catch (err) { this.log('warn', 'meeting thread not made', { error: (err as Error).message }); }
            }
            if (op === 'cal.cancel' && typeof d.eventId === 'string') { try { this.meetThreads.eventCancelled(d.eventId); } catch (err) { this.log('warn', 'cancel card not posted', { error: (err as Error).message }); } }
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof CalError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && (op.startsWith('nib.') || op.startsWith('admin.nib.'))) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.nib.handle(op, me, d);
            // someone goes on leave: bots listening for it act (release their seats…)
            if (op === 'nib.leave' && typeof d.from === 'string') this.botflows.net.emitAway(me.id, d.from, typeof d.to === 'string' ? d.to : null);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof NibError || err instanceof MsgError || err instanceof CalError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && (op.startsWith('notices.') || op.startsWith('admin.notices.'))) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.notices.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof NoticeError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && (op.startsWith('seating.') || op.startsWith('admin.seating.'))) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.seating.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof SeatingError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && op.startsWith('work.')) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.work.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof WorkError) throw new OpError(err.message);
            throw err;
          }
        }
        if (op === 'room.ice') return { iceServers: await this.ice.servers() };
        if (op === 'admin.ice.get' || op === 'admin.ice.set') {
          const me = this.store.userById(conn.userId!)!;
          if (me.role !== 'owner' && me.role !== 'admin') throw new OpError('Only administrators can do that.');
          if (op === 'admin.ice.set') {
            const mode = d.mode === 'cloudflare' || d.mode === 'custom' ? d.mode : 'auto';
            const servers = Array.isArray(d.servers) ? (d.servers as unknown[]).slice(0, 6).map((x) => {
              const s = x as { urls?: unknown; username?: unknown; credential?: unknown };
              const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).map(String).filter((u) => /^(stun|turns?):[\w.-]+(:\d+)?(\?transport=(udp|tcp))?$/i.test(u)).slice(0, 6);
              return { urls, ...(typeof s.username === 'string' && s.username ? { username: s.username.slice(0, 200) } : {}), ...(typeof s.credential === 'string' && s.credential ? { credential: s.credential.slice(0, 400) } : {}) };
            }).filter((s) => s.urls.length) : [];
            if (mode === 'custom' && !servers.length) throw new OpError('Add at least one stun:, turn: or turns: address.');
            // a password left empty keeps the one already saved for the same addresses
            const before = this.iceConfig().servers;
            for (const sv of servers as Array<{ urls: string[]; credential?: string }>) {
              if (sv.credential) continue;
              const old = before.find((o) => JSON.stringify([o.urls].flat()) === JSON.stringify(sv.urls));
              if (old?.credential) sv.credential = old.credential;
            }
            if (mode === 'cloudflare' && typeof d.keyId === 'string' && !/^[0-9a-f]{32}$/i.test(d.keyId.trim())) throw new OpError('The TURN key id is 32 letters and numbers, from Cloudflare > Realtime > TURN.');
            this.setMeta('ice_mode', mode);
            if (d.keyId !== undefined) this.setMeta('ice_key', typeof d.keyId === 'string' ? d.keyId.trim() : '');
            if (typeof d.token === 'string' && d.token.trim()) this.setMeta('ice_token', d.token.trim());
            if (d.token === null) this.setMeta('ice_token', '');
            this.setMeta('ice_servers', JSON.stringify(servers));
            this.ice.clear();
            this.store.audit(me.id, 'ice.set', null, { mode, keyId: this.store.meta('ice_key', () => ''), servers: servers.map((s) => s.urls) });
          }
          const c = this.iceConfig();
          return { mode: c.mode, keyId: c.keyId, servers: c.servers.map((s) => ({ urls: s.urls, ...(s.username ? { username: s.username } : {}), ...(s.credential ? { credential: '••••••' } : {}) })), hasToken: !!c.token };
        }
        if (op === 'remote.info') {
          const c = this.remoteConfig();
          return { url: c.enabled ? c.url : null, hubId: this.info.id, fingerprint: this.fingerprint, name: this.info.name, viaGateway: conn.remote, site: this.publicSite() };
        }
        if (op === 'admin.remote.get' || op === 'admin.remote.set') {
          const me = this.store.userById(conn.userId!)!;
          if (me.role !== 'owner' && me.role !== 'admin') throw new OpError('Only administrators can do that.');
          if (op === 'admin.remote.set') {
            if (d.url !== undefined) {
              const url = d.url === null || d.url === '' ? '' : String(d.url).trim().replace(/\/+$/, '');
              if (url && !/^(https:\/\/[a-z0-9.-]+|http:\/\/(127\.0\.0\.1|localhost))(:\d+)?(\/[\w.-]*)*$/i.test(url)) throw new OpError('Enter the gateway\'s https:// address, for example https://dexconnect-gateway.example.workers.dev');
              this.setMeta('remote_url', url);
            }
            if (d.siteUrl !== undefined) {
              const site = d.siteUrl === null || d.siteUrl === '' ? '' : siteBase(String(d.siteUrl));
              const problem = siteUrlProblem(site);
              if (problem) throw new OpError(problem);
              this.setMeta('meet_site_url', site);
            }
            if (d.orgName !== undefined) this.setMeta('meet_org_name', clean(d.orgName, 80));
            if (typeof d.enabled === 'boolean') this.setMeta('remote_enabled', d.enabled ? '1' : '0');
            if (typeof d.allowJoin === 'boolean') this.setMeta('remote_join', d.allowJoin ? '1' : '0');
            if (typeof d.allowAdmin === 'boolean') this.setMeta('remote_admin', d.allowAdmin ? '1' : '0');
            this.store.audit(me.id, 'remote.set', null, this.remoteConfig());
            this.applyRemote();
            if (conn.remote && !this.remoteConfig().allowAdmin) { /* the change still applies; this connection loses admin access */ }
          }
          return this.remoteView();
        }
        if (op === 'file.setText') {
          try {
            this.files.setText(conn.userId!, String(d.fileId ?? ''), typeof d.text === 'string' ? d.text : '');
            return { ok: true };
          } catch (err) {
            throw new OpError((err as Error).message);
          }
        }
        if (typeof op === 'string' && /^(emoji\.(list|add|remove)|admin\.emoji\.(add|remove)|sticker\.(list|add|remove))$/.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.emoji.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof EmojiError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(policy\.get|admin\.policy\.set|admin\.usage|lines\.office|admin\.lines\.(add|remove))$/.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.policies.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof PolicyError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(org\.|admin\.org\.|me\.profile$)/.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.org.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof OrgError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(desk\.|remind\.|sched\.|msg\.star$)/.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.desk.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof MsgError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(conv\.|msg\.|file\.|poll\.|form\.|activity\.|admin\.reports\.|people\.common$|people\.spaces$|tags\.top$|typing$|search$)/.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = this.messaging.handle(op, me, d);
            // search also reads the notice board: titles, text and the text of attached PDFs
            if (op === 'search' && result && typeof result === 'object' && !(typeof d.convId === 'string' && d.convId)) {
              try { (result as Ops['search']['res']).notices = this.notices.search(me, d.q, 5); } catch (err) { this.log('warn', 'notice search failed', { error: (err as Error).message }); }
            }
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof MsgError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(decision|refs)\./.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            const result = op.startsWith('decision.') ? this.decisions.handle(op, me, d) : this.refs.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof DecisionError || err instanceof RefError || err instanceof MsgError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(links\.|admin\.links\.|reactions\.)/.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            if (op === 'links.drives.set') return this.links.setDrives(me, conn.deviceId!, d) satisfies Ops['links.drives.set']['res'];
            const result = op.startsWith('reactions.') ? this.reactionInsights.handle(op, me, d) : await this.links.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof LinkError || err instanceof InsightError || err instanceof MsgError) throw new OpError(err.message);
            throw err;
          }
        }
        if (typeof op === 'string' && /^(admin\.backup\.(get|set|run)|admin\.offboard\.(preview|run|list|reactivate)|directory\.left|cal\.feed\.(get|set|reset))$/.test(op)) {
          const me = this.store.userById(conn.userId!)!;
          try {
            if (op.startsWith('admin.backup.')) {
              this.requireAdmin(conn);
              if (op === 'admin.backup.set') return await this.backups.configure(me, d);
              if (op === 'admin.backup.run') {
                if (!this.backups.config().folder) throw new OpError('Choose a backup folder first.');
                void this.backups.start(true, me.id).catch(() => { /* recorded in the status */ });
              }
              return this.backups.status();
            }
            const result = op.startsWith('cal.feed.') ? this.feeds.handle(op, me, d) : this.offboarding.handle(op, me, d);
            if (result !== undefined) return result;
          } catch (err) {
            if (err instanceof BackupFailure || err instanceof OffboardError || err instanceof CalFeedError || err instanceof MsgError) throw new OpError(err.message);
            throw err;
          }
        }
        throw new OpError(`Unknown operation: ${String(op)}`);
      }
    }
  }
}

