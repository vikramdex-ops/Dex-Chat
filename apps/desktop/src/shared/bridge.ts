// Contract between the Electron main process and the UI. The UI never touches Node directly.
import type { Ops, OpName, Session, WindowsAccount } from '@dex/core';

export type Theme = 'system' | 'light' | 'dark';

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
  platform: NodeJS.Platform;
  version: string;
}

export interface Settings {
  theme: Theme;
  startAtLogin: boolean;
  closeToTray: boolean;
}

export interface JoinRequest {
  hubId?: string;
  /** "host" or "host:port" typed by the user */
  address?: string;
  displayName: string;
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
  notify(title: string, body: string): void;
}

declare global {
  interface Window { dex: DexBridge }
}
