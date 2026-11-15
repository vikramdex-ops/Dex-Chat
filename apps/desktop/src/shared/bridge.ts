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
  platform: NodeJS.Platform;
  version: string;
  /** Direct messages between PCs while the hub is off */
  p2p?: P2PState;
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
export interface ShareBarState { peer: string; scope: 'screen' | 'window'; control: boolean; hotkey: string; context: AssistContext }

export interface AssistBridge {
  caps(): Promise<AssistCaps>;
  /**
   * What this PC's person allows now, as this PC enforces it. In a support session, sharing a
   * whole screen ('screen:' source) draws an amber frame around it and a share bar on top; in a
   * meeting they show while someone has control. Control injects the input of `peer`: in a
   * meeting only from the device `from`.
   */
  consent(c: { screen: boolean; sourceId?: string | null; scope?: 'screen' | 'window'; control: boolean; peer: string; context?: AssistContext; from?: string | null }): Promise<{ screen: boolean; control: boolean; error: string | null }>;
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
  uploadFile?(uploadId: string, src: { path?: string; data?: ArrayBuffer; name: string; mime?: string }): Promise<import('@dex/core').FileInfo>;
  onUploadProgress?(cb: (uploadId: string, sent: number, total: number) => void): () => void;
  pathForFile?(file: File): string;
  openFile?(id: string, name: string): Promise<void>;
  saveFile?(id: string, name: string): Promise<string>;
  /** Desktop, the file viewer: open a temporary copy in the program the system uses for its type, or save into Downloads, from bytes the window has or a hub file. */
  openCopy?(name: string, src: { id?: string; data?: ArrayBuffer }): Promise<void>;
  saveCopy?(name: string, src: { id?: string; data?: ArrayBuffer }): Promise<string>;
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
  /** Edit a note in Slate (or the default editor); saves there come back through onSlateChange. */
  editInSlate?(noteId: string, title: string, body: string): Promise<'slate' | 'default'>;
  onSlateChange?(cb: (noteId: string, text: string) => void): () => void;
  /** Open a downloaded file with Slate (text, CSV, logs). */
  openInSlate?(id: string, name: string): Promise<void>;
  hasSlate?: boolean;
  /** Whether a Direct conversation is end-to-end encrypted, and the code to compare in person. */
  e2eStatus?(convId: string): Promise<{ encrypted: boolean; code: string | null; missing: string[] }>;
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
