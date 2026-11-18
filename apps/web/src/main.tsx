import '@fontsource-variable/outfit';
import '../../desktop/src/renderer/styles.css';
import { createRoot } from 'react-dom/client';
import { installWebBridge } from './bridge.ts';

// The same interface as the desktop and Android apps; the bridge is the browser's (bridge.ts).
installWebBridge().then(async () => {
  const { App } = await import('../../desktop/src/renderer/App.tsx');
  const { loadLanguage } = await import('../../desktop/src/renderer/i18n/index.ts');
  await loadLanguage();
  createRoot(document.getElementById('root')!).render(<App />);
}).catch((e: Error) => {
  // storage refused (a private window in an old Safari): say so instead of a blank page
  const p = document.createElement('p');
  p.style.cssText = 'font: 16px system-ui; margin: 40px 20px; text-align: center';
  p.textContent = `Dexterity Connect could not start here: ${e.message}`;
  document.getElementById('root')!.append(p);
});
