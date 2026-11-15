import '@fontsource-variable/outfit';
import { createRoot } from 'react-dom/client';
import { App, PopoutApp } from './App.tsx';
import { ShareBar } from './help/ShareBar.tsx';
import { PointerOverlay } from './pointers/surfaces.tsx';
import { loadLanguage } from './i18n/index.ts';

performance.mark('dex:boot');
const popout = location.hash.match(/^#popout=([0-9A-Za-z_-]{8,40})$/);
// windows the main process opens above everything: the share bar and the presenter's pointers
const overlay = location.hash.match(/^#overlay=(bar|pointers)$/)?.[1];
// the chosen language's words come first (nothing to wait for in English)
await loadLanguage();
createRoot(document.getElementById('root')!).render(overlay === 'bar' ? <ShareBar /> : overlay === 'pointers' ? <PointerOverlay /> : popout ? <PopoutApp convId={popout[1]} /> : <App />);
