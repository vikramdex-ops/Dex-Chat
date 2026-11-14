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
  phase: Phase;
  account: WindowsAccount;
  /** This PC's device id; its first 8 characters are the code admins see when approving */
  deviceId: string;
  hubs: DiscoveredHub[];
  hub: { id?: string; name?: string; host: string; port: number; fingerprint?: string } | null;
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
}

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
}

export interface DexBridge {
  getState(): Promise<AppState>;
  onState(cb: (s: AppState) => void): () => void;
  onHubEvent(cb: (name: string, data: unknown) => void): () => void;
  onDeepLink(cb: (url: string) => void): () => void;
  join(req: JoinRequest): Promise<void>;
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
  /** Phones: a URL the page can show an image or play audio from (desktop uses the dexfile: scheme). */
  fileUrl?(id: string, name: string): Promise<string>;
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
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  dismissWhatsNew(): Promise<void>;
}

declare global {
  interface Window { dex: DexBridge }
}
