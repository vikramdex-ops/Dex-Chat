// Windows that sit above everything on the requester's or presenter's screen:
// - while a screen is shared with IT, or someone has control of a presenter's screen in a meeting,
//   an amber frame around that screen (four thin strips that the pointer passes through) and a
//   share bar ("Sharing your screen with Ravi · Stop sharing", or who uses the mouse and keyboard);
// - while you present in a Room, a transparent, click-through window that shows where everyone
//   points on your real screen.
import { BrowserWindow, screen } from 'electron';
import type { Display } from 'electron';
import type { ShareBarState } from '../../shared/bridge.ts';

const AMBER = '#f7af44';
const FRAME = 4;
const TITLE = 'Dexterity Connect · screen shared';

type Loader = (w: BrowserWindow, hash: string) => void;

function topmost(w: BrowserWindow, clickThrough: boolean): void {
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (clickThrough) w.setIgnoreMouseEvents(true, { forward: true });
  w.setMenuBarVisibility(false);
}

export class Overlays {
  private strips: BrowserWindow[] = [];
  private bar: BrowserWindow | null = null;
  private barState: ShareBarState | null = null;
  private pointerWin: BrowserWindow | null = null;
  private readonly load: Loader;
  private readonly preload: string;

  constructor(load: Loader, preload: string) {
    this.load = load;
    this.preload = preload;
  }

  /** The amber frame around the shared display (none for a single window) and the share bar. */
  showShare(display: Display | null, state: ShareBarState): void {
    this.hideFrame();
    if (display) {
      const b = display.bounds;
      const rects = [
        { x: b.x, y: b.y, width: b.width, height: FRAME },
        { x: b.x, y: b.y + b.height - FRAME, width: b.width, height: FRAME },
        { x: b.x, y: b.y + FRAME, width: FRAME, height: b.height - 2 * FRAME },
        { x: b.x + b.width - FRAME, y: b.y + FRAME, width: FRAME, height: b.height - 2 * FRAME },
      ];
      for (const r of rects) {
        const w = new BrowserWindow({
          ...r, show: false, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
          focusable: false, skipTaskbar: true, hasShadow: false, backgroundColor: AMBER, title: TITLE, enableLargerThanScreen: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
        });
        topmost(w, true);
        void w.loadURL(`data:text/html,<title>${encodeURIComponent(TITLE)}</title><body style="margin:0;background:${AMBER}"></body>`);
        w.setBounds(r);
        w.showInactive();
        this.strips.push(w);
      }
    }
    this.showBar(display ?? screen.getPrimaryDisplay(), state);
  }

  private showBar(display: Display, state: ShareBarState): void {
    this.barState = state;
    const width = 640;
    const height = 56;
    const area = display.workArea;
    const bounds = { x: Math.round(area.x + (area.width - width) / 2), y: area.y + 10, width, height };
    if (this.bar && !this.bar.isDestroyed()) { this.bar.setBounds(bounds); this.pushBar(); return; }
    const w = new BrowserWindow({
      ...bounds, show: false, frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, hasShadow: true, transparent: process.platform !== 'linux', backgroundColor: process.platform === 'linux' ? '#132b2e' : '#00000000',
      title: TITLE,
      webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    topmost(w, false);
    w.webContents.on('did-finish-load', () => this.pushBar());
    this.load(w, 'overlay=bar');
    w.once('ready-to-show', () => w.showInactive());
    w.on('closed', () => { if (this.bar === w) this.bar = null; });
    this.bar = w;
  }

  updateBar(state: ShareBarState): void {
    this.barState = state;
    this.pushBar();
  }

  private pushBar(): void {
    if (this.bar && !this.bar.isDestroyed() && this.barState) this.bar.webContents.send('overlay:state', this.barState);
  }

  private hideFrame(): void {
    for (const w of this.strips) if (!w.isDestroyed()) w.destroy();
    this.strips = [];
  }

  hideShare(): void {
    this.hideFrame();
    if (this.bar && !this.bar.isDestroyed()) this.bar.destroy();
    this.bar = null;
    this.barState = null;
  }

  /** A window finished drawing and listens: send it its state again. */
  resend(contentsId: number): void {
    if (this.bar && !this.bar.isDestroyed() && this.bar.webContents.id === contentsId) this.pushBar();
    if (this.pointerWin && !this.pointerWin.isDestroyed() && this.pointerWin.webContents.id === contentsId) this.pushGeom();
  }

  /** Is this one of our overlay windows (their buttons may act)? */
  isBar(contentsId: number): boolean {
    return !!this.bar && !this.bar.isDestroyed() && this.bar.webContents.id === contentsId;
  }

  // ------------------------------------------------------------ the presenter's pointer window
  private pointerDisplay: Display | null = null;

  /**
   * A click-through window over the shared display. Its marks are placed from the display's and the
   * window's real bounds (sent to it as `geom`), so they land on the shared pixels even when Windows
   * sizes the window differently (a monitor with other scaling, the window moved by the system).
   */
  showPointers(display: Display): void {
    this.pointerDisplay = display;
    const b = display.bounds;
    if (this.pointerWin && !this.pointerWin.isDestroyed()) { this.place(this.pointerWin, b); return; }
    const w = new BrowserWindow({
      ...b, show: false, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, movable: false,
      focusable: false, skipTaskbar: true, hasShadow: false, title: 'Dexterity Connect · pointers', enableLargerThanScreen: true,
      webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, zoomFactor: 1 },
    });
    topmost(w, true);
    this.load(w, 'overlay=pointers');
    // a window made on another monitor first takes the main one's scaling: place it again once it is there
    w.once('ready-to-show', () => { this.place(w, b); w.showInactive(); this.place(w, b); });
    w.on('moved', () => this.pushGeom());
    w.on('resize', () => this.pushGeom());
    w.webContents.on('did-finish-load', () => { w.webContents.setZoomFactor(1); this.pushGeom(); });
    w.on('closed', () => { if (this.pointerWin === w) this.pointerWin = null; });
    this.pointerWin = w;
  }

  private place(w: BrowserWindow, b: Electron.Rectangle): void {
    if (w.isDestroyed()) return;
    const cur = w.getBounds();
    if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) w.setBounds(b);
    this.pushGeom();
  }

  /** Displays were added, removed, moved or rescaled: follow the shared one (by its id). */
  displaysChanged(all: Display[]): void {
    const d = this.pointerDisplay;
    if (!d || !this.pointerWin || this.pointerWin.isDestroyed()) return;
    const now = all.find((x) => x.id === d.id);
    if (!now) { this.hidePointers(); return; }
    this.pointerDisplay = now;
    this.place(this.pointerWin, now.bounds);
  }

  /** The display's and the window's bounds, for the window to place marks (overlayBox in @dex/core/pointers). */
  private pushGeom(): void {
    const w = this.pointerWin;
    const d = this.pointerDisplay;
    if (!w || w.isDestroyed() || !d) return;
    w.webContents.send('overlay:state', { geom: { display: { ...d.bounds }, window: w.getBounds() } });
  }

  pointer(msg: unknown): void {
    if (this.pointerWin && !this.pointerWin.isDestroyed()) this.pointerWin.webContents.send('overlay:state', msg);
  }

  hidePointers(): void {
    if (this.pointerWin && !this.pointerWin.isDestroyed()) this.pointerWin.destroy();
    this.pointerWin = null;
    this.pointerDisplay = null;
  }

  /** The pointer window, for a look at what it draws (tests and screenshots). */
  get pointerWindow(): BrowserWindow | null { return this.pointerWin && !this.pointerWin.isDestroyed() ? this.pointerWin : null; }

  closeAll(): void { this.hideShare(); this.hidePointers(); }
}
