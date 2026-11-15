import '@fontsource-variable/outfit';
import '../../desktop/src/renderer/styles.css';
import { createRoot } from 'react-dom/client';
import { installMobileBridge } from './bridge.ts';

installMobileBridge().then(async () => {
  const { App } = await import('../../desktop/src/renderer/App.tsx');
  // the chosen language's words come first (nothing to wait for in English)
  const { loadLanguage } = await import('../../desktop/src/renderer/i18n/index.ts');
  await loadLanguage();
  createRoot(document.getElementById('root')!).render(<App />);
});
