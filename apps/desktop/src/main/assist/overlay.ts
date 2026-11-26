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

/** The privacy screen's page: still, calm, in the brand's teal and amber (no script). */
function privacyPage(who: string): string {
  const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>${encodeURIComponent(TITLE)}</title><style>
html,body{margin:0;height:100%;background:#132b2e;color:#f6fafa;font-family:'Segoe UI',system-ui,sans-serif;overflow:hidden;cursor:default}
body{display:grid;place-items:center;background-image:linear-gradient(rgba(207,230,232,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(207,230,232,.06) 1px,transparent 1px);background-size:48px 48px}
.card{max-width:720px;padding:48px 56px;border:1.5px solid rgba(247,175,68,.55);border-radius:22px;background:linear-gradient(135deg,#143f45,#132b2e)}
.tag{font:12px Consolas,monospace;letter-spacing:.12em;color:#f7af44}
h1{font-weight:300;font-size:38px;line-height:1.2;margin:18px 0 14px}
p{font-size:17px;line-height:1.5;color:#cfe6e8;margin:0 0 12px}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#f7af44;margin-right:10px;animation:b 2.4s ease-in-out infinite}
@keyframes b{50%{box-shadow:0 0 0 10px rgba(247,175,68,.15)}}
.keys{font:12px Consolas,monospace;color:#cfe6e8;opacity:.8;margin-top:22px}
</style><div class="card"><div class="tag"><span class="dot"></span>DEXTERITY CONNECT · IT SUPPORT · PRIVACY SCREEN</div>
<h1>${esc(who)} from IT is working on this PC</h1>
<p>They asked for the screen to be covered while they work, so this is what you see. Please leave the mouse and keyboard alone until it goes: anything you type or click reaches what IT is working on.</p>
<p>You can end it at any time: Stop on the bar at the top, or the keys below.</p>
<div class="keys">STOP: SHIFT+ESC · CTRL+ALT+SHIFT+S</div></div>`;
}

/** Windows 10 version 2004 (build 19041) and later keep a window out of screen capture; older ones would black it out for IT. */
export function privacySupported(release: string, platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  const build = Number(release.split('.')[2] ?? 0);
  return build >= 19041;
}

export class Overlays {
  private strips: BrowserWindow[] = [];
  private privacyWins: BrowserWindow[] = [];
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
    // the privacy screen never outlives the share it covers
    this.hidePrivacy();
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

  /**
   * The privacy screen: one window over every display, which the person sees and screen capture
   * does not (so IT sees the real screen). Clicks pass through (IT's injected input reaches the
   * apps underneath); the share bar stays above it with Stop.
   */
  showPrivacy(who: string): void {
    this.hidePrivacy();
    for (const d of screen.getAllDisplays()) {
      const b = d.bounds;
      const w = new BrowserWindow({
        x: b.x, y: b.y, width: b.width, height: b.height, show: false, frame: false, resizable: false, movable: false, minimizable: false,
        maximizable: false, fullscreenable: false, focusable: false, skipTaskbar: true, hasShadow: false, backgroundColor: '#132b2e', title: TITLE,
        enableLargerThanScreen: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
      });
      // out of screen capture: the person sees it, IT's picture shows what is underneath
      w.setContentProtection(true);
      topmost(w, true);
      w.setOpacity(0.97);
      void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(privacyPage(who))}`);
      w.setBounds(b);
      w.showInactive();
      this.privacyWins.push(w);
    }
    // the bar (Stop) and the frame stay above it
    if (this.bar && !this.bar.isDestroyed()) this.bar.moveTop();
    for (const s of this.strips) if (!s.isDestroyed()) s.moveTop();
  }

  hidePrivacy(): void {
    for (const w of this.privacyWins) if (!w.isDestroyed()) w.destroy();
    this.privacyWins = [];
  }

  get privacyOn(): boolean { return this.privacyWins.length > 0; }

  closeAll(): void { this.hidePrivacy(); this.hideShare(); this.hidePointers(); }
}
