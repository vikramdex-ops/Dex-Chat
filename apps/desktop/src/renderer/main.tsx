import '@fontsource-variable/outfit';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { App, PopoutApp } from './App.tsx';

const popout = location.hash.match(/^#popout=([0-9A-Za-z_-]{8,40})$/);
createRoot(document.getElementById('root')!).render(popout ? <PopoutApp convId={popout[1]} /> : <App />);
