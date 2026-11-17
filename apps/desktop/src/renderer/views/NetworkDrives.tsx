// Preferences → Your network drives: this PC's drive letters and the shares they stand for, as
// share paths in messages use them (chat/sharepaths.ts). Read by the app from Windows; Refresh
// reads them again at once (otherwise on start and when the window comes back, once a minute).
import { useState } from 'react';
import { networkRoots, toUnc } from '@dex/core/sharepaths';
import type { AppState } from '../../shared/bridge.ts';
import { Icon, useToast } from '../ui.tsx';
import { refreshDrives, useMyDrives } from '../chat/sharepaths.ts';

export function NetworkDrives({ state }: { state: AppState }) {
  const toast = useToast();
  const map = useMyDrives();
  const [busy, setBusy] = useState(false);
  if (!window.dex.driveMap || state.platform === 'android') return null;
  const windows = state.platform === 'win32' || map.known;
  const network = new Set(networkRoots(map.drives).map((x) => x.letter));
  const refresh = () => {
    setBusy(true);
    void refreshDrives().then((m) => {
      const n = networkRoots(m.drives).length;
      toast(n === 0 ? 'No network drives on this PC' : n === 1 ? '1 network drive' : `${n} network drives`);
    }).catch((e: Error) => toast(e.message, true)).finally(() => setBusy(false));
  };
  return (
    <section className="net-drives" aria-labelledby="net-drives-h">
      <h3 id="net-drives-h">Your network drives</h3>
      <div className="setting">
        <Icon name="drawer" className="lead" />
        <div className="txt">
          <div>Share paths open on every PC</div>
          <div className="faint">
            {windows
              ? 'A path you send on one of these drives is stored as the share path, so colleagues with other letters can open it. Paths others send are shown with your letters.'
              : 'Drive letters are a Windows thing: on this computer, paths on the office share are shown as share paths (\\\\server\\share).'}
          </div>
        </div>
        {windows && <button className="btn" disabled={busy} onClick={refresh}>{busy ? <span className="spinner" /> : <Icon name="refresh" size={16} />}Refresh</button>}
      </div>
      {windows && (map.drives.length ? (
        <table className="drive-table">
          <caption className="sr-only">Drive letters on this PC</caption>
          <thead><tr><th scope="col">Drive</th><th scope="col">Share path</th><th scope="col">Kind</th></tr></thead>
          <tbody>
            {map.drives.map((d) => {
              const shared = network.has(d.letter);
              const unc = shared ? toUnc(`${d.letter}\\`, map.drives)?.replace(/\\$/, '') ?? d.root : d.root;
              return (
                <tr key={d.letter} className={shared ? '' : 'local'}>
                  <td className="mono" translate="no">{d.letter}</td>
                  <td className="mono selectable" translate="no">{unc}</td>
                  <td className="faint">{d.source === 'subst' ? (shared ? 'Folder on a share' : 'Folder on this PC, not shared') : 'Network drive'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : <div className="faint drive-none">{map.known ? 'No network drives are mapped on this PC. Share paths are shown as \\\\server\\share.' : 'Reading the drive letters…'}</div>)}
    </section>
  );
}
