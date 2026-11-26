// Contract between the Electron main process and the UI. The UI never touches Node directly.
import type { Ops, OpName, Session, WindowsAccount } from '@dex/core';

export type Theme = 'system' | 'light' | 'dark';
export type UpdateChannel = 'stable' | 'beta';

export type UpdatePhase =
  | 'disabled'     // development build
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'    // found, not downloading (auto-download off)
  | 'downloading'
  | 'ready'        // downloaded and verified; restart to install
  | 'installing'
  | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  lastCheck: number | null;
  available: { version: string; notes: string; releasedAt: string; mandatory: boolean; size: number; source: 'hub' | 'internet' } | null;
  progress: { received: number; total: number } | null;
  error: string | null;
  /**
   * Where the last check looked and which answered: the hub on the office network, the hub through
   * the internet gateway, GitHub, and the second internet mirror. Shown when nothing answered.
   */
  checked?: Array<{ source: 'hub-lan' | 'hub-gateway' | 'internet' | 'mirror'; ok: boolean }>;
  /** Shown once after the app relaunches into a new version. */
  justUpdated: { version: string; notes: string } | null;
}

export interface DiscoveredHub {
  id: string;
  name: string;
  address: string;
  port: number;
  fingerprint: string;
  version: string;
}

export type Phase =
  | 'welcome'      // first run: confirm name, pick hub
  | 'connecting'
  | 'pending'      // waiting for an administrator
  | 'ready'
  | 'offline'      // lost the hub; retrying
  | 'rejected'
  | 'mismatch';    // hub certificate changed

export interface AppState {
  /** Other offices this device belongs to (switch in the tile menu). */
  offices?: Array<{ id: string; name: string }>;
  phase: Phase;
  account: WindowsAccount;
  /** This PC's device id; its first 8 characters are the code admins see when approving */
  deviceId: string;
  hubs: DiscoveredHub[];
  hub: { id?: string; name?: string; host: string; port: number; fingerprint?: string; gateway?: string | null } | null;
  /** How the app reaches the hub right now: the office network, or the internet gateway. */
  via?: 'lan' | 'remote';
  session: Session | null;
  pendingPosition: number;
  retryInMs: number;
  error: string | null;
  settings: Settings;
  update: UpdateState;
  /** 'ios-web': the iPhone web app (apps/web), served by the office's meeting site and added to the Home Screen. */
  platform: AppPlatform;
  version: string;
  /** Direct messages between PCs while the hub is off */
  p2p?: P2PState;
}

export type AppPlatform = NodeJS.Platform | 'ios-web';
/** A phone: Android, or the iPhone web app. Both use the phone layouts and pair with a code. */
export const isPhonePlatform = (p: string | null | undefined): boolean => p === 'android' || p === 'ios-web';

/** The iPhone web app: whether it was added to the Home Screen, and its Web Push notifications. */
export type WebPushState =
  /** this browser has no Web Push (iOS before 16.4, or a browser without it) */
  | 'unsupported'
  /** Safari only allows notifications for a web app added to the Home Screen */
  | 'not-installed'
  /** not asked yet, or switched off in the app */
  | 'off'
  /** the person said no: only the iPhone's Settings can change it now */
  | 'denied'
  | 'on';

export interface WebAppBridge {
  /** iPhone, iPad or another browser (the install guide's wording). */
  device: 'iphone' | 'ipad' | 'other';
  /** Opened from the Home Screen (display-mode standalone). */
  standalone: boolean;
  /** "Continue in Safari" was chosen in the install guide (this tab only). */
  continueInBrowser(): void;
  continued(): boolean;
  pushState(): Promise<WebPushState>;
  /** Ask for permission (from a tap), subscribe and give the hub the subscription. */
  enablePush(): Promise<WebPushState>;
  disablePush(): Promise<void>;
  testPush(): Promise<{ ok: boolean; error: string | null }>;
  /** The pairing code the page was opened with (to copy before adding it to the Home Screen). */
  pendingCode(): string | null;
  /** Reads the clipboard after a tap (iOS shows its own Paste button). */
  pasteCode(): Promise<string>;
}

export interface Settings {
  theme: Theme;
  startAtLogin: boolean;
  closeToTray: boolean;
  updateChannel: UpdateChannel;
  autoDownloadUpdates: boolean;
  /** Sound for new messages and reminders. */
  sound: MessageSound;
  /** Which messages show a Windows notification. */
  notifyFor: 'all' | 'mentions' | 'none';
  /** Show what the message says in notifications (off hides it on a shared screen). */
  showPreviews: boolean;
  density: 'comfortable' | 'compact';
  /** Text and interface size, percent. */
  textSize: 90 | 100 | 110 | 125;
  /** 12- or 24-hour times, or the system's choice. */
  timeFormat?: 'system' | '12' | '24';
  /** Quiet hours: no message notifications or sounds between these times (HH:MM), every day. */
  quietFrom?: string | null;
  quietTo?: string | null;
}

export type MessageSound = 'chime' | 'tick' | 'drop' | 'none';
export const SETTINGS_EXTRA_DEFAULTS = { sound: 'chime', notifyFor: 'all', showPreviews: true, density: 'comfortable', textSize: 100, timeFormat: 'system', quietFrom: null, quietTo: null } as const;

/** Hub-off mode: Direct messages pass straight between PCs on the network. */
export interface P2PState { active: boolean; reachable: string[]; queued: number }

export interface JoinRequest {
  hubId?: string;
  /** "host" or "host:port" typed by the user */
  address?: string;
  displayName: string;
  /** Phones only: "DOMAIN\\username" to link the phone to the person's PC account. */
  officeAccount?: string;
  /** Guest invite code from an administrator (people outside the company). */
  invite?: string;
  /** Outside the office: the "DXC1-…" setup code from a colleague's PC or the Control room. */
  setupCode?: string;
  /** "DXP1-…": adds this phone or laptop to the account of the person who made the code. */
  pairCode?: string;
}

/** What "Send diagnostics" packs for IT (see src/main/assist/diagnostics.ts); shown in full before it is sent. */
export interface DiagnosticsReport {
  kind: 'dexconnect-diagnostics';
  version: 1;
  createdAt: string;
  app: { version: string; channel: UpdateChannel; platform: string; arch: string; electron: string; chrome: string; packaged: boolean; locale: string };
  os: { name: string; release: string; version: string; arch: string; uptimeHours: number };
  cpu: { model: string; cores: number; speedMHz: number; load1m: number | null };
  memory: { totalMb: number; freeMb: number; appMb: number };
  disk: { path: string; totalGb: number | null; freeGb: number | null };
  displays: Array<{ id: string; primary: boolean; x: number; y: number; width: number; height: number; scale: number; rotation: number; internal: boolean }>;
  network: {
    route: 'office network' | 'internet gateway' | 'not connected';
    hub: { address: string | null; reachable: boolean; latencyMs: number[]; medianMs: number | null };
    gateway: string | null;
    turn: Array<{ url: string; transport: string; reachable: boolean; ms: number | null; note: string | null }>;
  };
  log: Array<{ at: number; level: 'info' | 'warn' | 'error'; source: string; msg: string; extra?: Record<string, string | number | boolean | null> }>;
  rendererErrors: Array<{ at: number; message: string; source?: string }>;
}

/** What this PC can do in a support session or a meeting. */
export interface AssistCaps {
  /** Someone may be given the mouse and keyboard (Windows; Linux with xdotool). */
  control: boolean;
  /** Why not, in words for the requester (macOS, Wayland, no xdotool). */
  reason: string | null;
  platform: NodeJS.Platform;
}

/** Where remote control happens: a support session (IT), or a meeting ("Give control"). */
export type AssistContext = 'support' | 'meeting';

/**
 * The share bar on the requester's or presenter's screen (an always-on-top window of its own):
 * in a support session while the screen is shared, in a meeting while someone has control.
 */
export interface ShareBarState { peer: string; scope: 'screen' | 'window'; control: boolean; hotkey: string; context: AssistContext; /** IT connected without asking (policy assistUnattended). */ unattended?: boolean }

export interface AssistBridge {
  caps(): Promise<AssistCaps>;
  /**
   * What this PC's person allows now, as this PC enforces it. In a support session, sharing a
   * whole screen ('screen:' source) draws an amber frame around it and a share bar on top; in a
   * meeting they show while someone has control. Control injects the input of `peer`: in a
   * meeting only from the device `from`.
   */
  consent(c: { screen: boolean; sourceId?: string | null; scope?: 'screen' | 'window'; control: boolean; peer: string; context?: AssistContext; from?: string | null; unattended?: boolean }): Promise<{ screen: boolean; control: boolean; error: string | null }>;
  /** The privacy screen over every display while the whole screen is shared with IT (out of screen capture). */
  privacy(state: { on: boolean; peer?: string }): Promise<{ ok: boolean; error: string | null }>;
  /** The source id of the main screen (what an unattended session shares). */
  primaryScreen(): Promise<string | null>;
  /** This PC's clipboard text; with `text`, put that on it first (clipboard sync, policy assistClipboard). */
  clipboard(text?: string): Promise<string>;
  /** Save a file the other side dropped into a support session under Downloads\Dexterity IT\<ref>\<path>; returns where. */
  saveDropped(fileId: string, ref: string, path: string): Promise<string>;
  /** Open the ticket's folder of dropped files. */
  openDropped(ref: string): Promise<void>;
  /** A message of input events from the person in control, sent by device `from` (checked and limited in the main process). */
  input(msg: unknown, from?: string): void;
  /** Something was stopped from the share bar, with the stop hotkey, or because the window or hub went away (context null). */
  onStop(cb: (what: 'control' | 'screen' | 'session', context: AssistContext | null) => void): () => void;
  diagnostics(rendererErrors: Array<{ at: number; message: string; source?: string }>): Promise<DiagnosticsReport>;
  /** A picture of this screen (the app steps aside while it is taken), for a Help Me request. */
  screenshot(): Promise<{ data: ArrayBuffer; name: string } | null>;
  /** The presenter's own screen shows everyone's pointers in a click-through window. */
  pointers(state: { on: boolean; sourceId?: string | null }): void;
  pointer(msg: { from: string; userId: string; name: string; color: string; presenter: boolean; m: unknown }): void;
}

/** In the share bar and pointer windows only. */
export interface OverlayBridge {
  onState(cb: (state: unknown) => void): () => void;
  /** The window is drawn and listening: send it what it should show. */
  ready(): void;
  action(a: 'stop-control' | 'stop-screen' | 'end'): void;
}

/** Android: what decides whether notifications keep arriving without Google push. */
export interface NotifyHealth {
  /** Notifications are allowed (permission, and the messages channel not switched off). */
  notifications: boolean;
  /** Battery optimisation does not apply to the app ("Unrestricted"). */
  batteryExempt: boolean;
  /** Background use is "Restricted" for the app, which stops it whatever else is set. */
  backgroundRestricted: boolean;
  /** The maker family with extra switches: xiaomi, vivo, oppo (also Realme), oneplus, samsung, huawei, or ''. */
  maker: string;
  manufacturer: string;
  model: string;
  androidVersion: string;
  /** This phone has the maker's autostart / background page (apps cannot read its switch). */
  autostartPage: boolean;
  keepAlive: boolean;
  serviceRunning: boolean;
  /** The background service can wait for messages on its own, and when it last reached the hub. */
  watching: boolean;
  lastOk: number | null;
  lastError: string | null;
}

export type SettingsPage = 'notifications' | 'battery' | 'autostart' | 'app';

export interface DexBridge {
  getState(): Promise<AppState>;
  /** Desktop: open a conversation in a window of its own, or bring the main window forward. */
  popOut?(convId: string, title: string): Promise<void>;
  showMain?(convId?: string): Promise<void>;
  onState(cb: (s: AppState) => void): () => void;
  onHubEvent(cb: (name: string, data: unknown) => void): () => void;
  onDeepLink(cb: (url: string) => void): () => void;
  join(req: JoinRequest): Promise<void>;
  /** Text on the clipboard (to pick up a pairing code copied from the download page). */
  readClipboard?(): Promise<string>;
  /** Several offices: join another (keeps this one), switch, or forget one. */
  addOffice?(): Promise<void>;
  switchOffice?(hubId: string): Promise<void>;
  removeOffice?(hubId: string): Promise<void>;
  forgetHub(): Promise<void>;
  rescan(): Promise<void>;
  request<K extends OpName>(op: K, data?: Ops[K]['req']): Promise<Ops[K]['res']>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  notify(title: string, body: string, link?: string): void;
  /** Unread attention count for the taskbar / dock badge. */
  setBadge?(count: number): void;
  /** Files (desktop only; absent on phones for now). */
  /** With `convId`, a file for an end-to-end encrypted Direct conversation is encrypted on this device before it leaves. */
  uploadFile?(uploadId: string, src: { path?: string; data?: ArrayBuffer; name: string; mime?: string; convId?: string }): Promise<import('@dex/core').FileInfo>;
  onUploadProgress?(cb: (uploadId: string, sent: number, total: number) => void): () => void;
  pathForFile?(file: File): string;
  openFile?(id: string, name: string): Promise<void>;
  saveFile?(id: string, name: string): Promise<string>;
  /** Desktop, the file viewer: open a temporary copy in the program the system uses for its type, or save into Downloads, from bytes the window has or a hub file. */
  openCopy?(name: string, src: { id?: string; data?: ArrayBuffer }): Promise<void>;
  saveCopy?(name: string, src: { id?: string; data?: ArrayBuffer }): Promise<string>;
  /** Desktop: open an invitation as a draft (.eml) in the PC's mail program; returns the file written. */
  openMailDraft?(name: string, eml: string): Promise<string>;
  /** Desktop: open a mailto: link in the PC's mail program. */
  openMailto?(url: string): Promise<void>;
  /** Desktop: sign in to Zoho in the browser and wait for its answer on this PC's loopback address (Connect Zoho Calendar). */
  zohoSignIn?(authUrl: string, state: string): Promise<import('@dex/core/zoho').ZohoCallback>;
  /**
   * The key (base64, 256 bits) that encrypts this office's on-device search index of end-to-end
   * encrypted Direct messages, held by the system's secure storage; null when there is none.
   */
  searchIndexKey?(scope: string): Promise<string | null>;
  dropSearchIndexKey?(scope: string): Promise<void>;
  /** Phones: a URL the page can show an image or play audio from (desktop uses the dexfile: scheme). */
  fileUrl?(id: string, name: string): Promise<string>;
  /** Desktop: name and size of a local file another tool asked to share. */
  statFile?(path: string): Promise<{ name: string; size: number; isFile: boolean }>;
  /** Which office tools are installed (by their link schemes), and opening links for them. */
  installedTools?(): Promise<Record<'projectopener' | 'dexterity' | 'sleuth' | 'datum', boolean>>;
  openLink?(url: string): Promise<void>;
  /** Desktop: show a folder on the office share or a drive (Open folder on a link card). */
  openFolder?(path: string): Promise<void>;
  /** Desktop: open a drawing, sheet or document on the office share in its own program (Open on a path card; never programs). */
  openSharePath?(path: string): Promise<void>;
  /** Desktop (Windows): this PC's drive letters (letter → UNC root, subst drives too); `force` reads them again now. */
  driveMap?(force?: boolean): Promise<import('@dex/core/sharepaths').DriveMap>;
  onDriveMap?(cb: (map: import('@dex/core/sharepaths').DriveMap) => void): () => void;
  /** Desktop: can this person reach a share path from here (cached for a minute; 'unknown' off Windows). */
  checkPath?(path: string): Promise<'ok' | 'denied' | 'missing' | 'offline' | 'unknown'>;
  /** Edit a note in Slate (or the default editor); saves there come back through onSlateChange. */
  editInSlate?(noteId: string, title: string, body: string): Promise<'slate' | 'default'>;
  onSlateChange?(cb: (noteId: string, text: string) => void): () => void;
  /** Open a downloaded file with Slate (text, CSV, logs). */
  openInSlate?(id: string, name: string): Promise<void>;
  hasSlate?: boolean;
  /** Whether a Direct conversation is end-to-end encrypted, and the code to compare in person. */
  e2eStatus?(convId: string): Promise<{ encrypted: boolean; code: string | null; missing: string[]; /** the office requires encryption here */ required?: boolean }>;
  /** Android: the Notifications check (Preferences) and the settings pages it opens. */
  phone?: {
    notifyHealth(): Promise<NotifyHealth>;
    /** Opens a settings page; resolves with what opened ('maker' for the maker's own page, 'app' for the app's page) or null. */
    openSettings(page: SettingsPage): Promise<string | null>;
    /** Android's own "always run in the background?" question, asked after the app explains why. */
    requestBatteryExemption(): Promise<void>;
    askNotifications(): Promise<void>;
  };
  /** The iPhone web app (apps/web): Home Screen and Web Push. */
  web?: WebAppBridge;
  /** Screen sharing (desktop): list screens/windows and choose one before getDisplayMedia(). */
  listScreens?(): Promise<Array<{ id: string; name: string; thumbnail: string }>>;
  chooseScreen?(id: string): Promise<void>;
  /** Help desk sessions (desktop): screen consent, control, diagnostics, screenshots, the pointer overlay. */
  assist?: AssistBridge;
  overlay?: OverlayBridge;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  dismissWhatsNew(): Promise<void>;
}

declare global {
  interface Window { dex: DexBridge }
}
