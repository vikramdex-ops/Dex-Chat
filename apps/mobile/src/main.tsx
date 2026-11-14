import '@fontsource-variable/outfit';
import '../../desktop/src/renderer/styles.css';
import { createRoot } from 'react-dom/client';
import { installMobileBridge } from './bridge.ts';

installMobileBridge().then(async () => {
  const { App } = await import('../../desktop/src/renderer/App.tsx');
  createRoot(document.getElementById('root')!).render(<App />);
});
