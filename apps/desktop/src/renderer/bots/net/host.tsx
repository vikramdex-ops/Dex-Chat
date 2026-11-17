// Listens for dex-botnet and dex-botjobs and shows the bot network sheet or the job sheet, each
// loaded the first time it is opened.
import { Suspense, lazy, useEffect, useState } from 'react';
import type { BotJobSheet, Session } from '@dex/core';

const NetworkSheet = lazy(() => import('./NetworkSheet.tsx'));
const JobSheet = lazy(() => import('./JobSheet.tsx'));

export function NetSheetsHost({ session }: { session: Session }) {
  const [net, setNet] = useState<{ scope: 'mine' | 'office' } | null>(null);
  const [jobs, setJobs] = useState<{ scope: BotJobSheet['scope']; flow?: string } | null>(null);
  useEffect(() => {
    const a = (e: Event) => { setJobs(null); setNet({ scope: 'mine', ...((e as CustomEvent).detail ?? {}) }); };
    const b = (e: Event) => { setNet(null); setJobs({ scope: 'mine', ...((e as CustomEvent).detail ?? {}) }); };
    window.addEventListener('dex-botnet', a);
    window.addEventListener('dex-botjobs', b);
    return () => { window.removeEventListener('dex-botnet', a); window.removeEventListener('dex-botjobs', b); };
  }, []);
  return (
    <Suspense fallback={null}>
      {net && <NetworkSheet session={session} scope={net.scope} onClose={() => setNet(null)} />}
      {jobs && <JobSheet key={`${jobs.scope}/${jobs.flow ?? ''}`} session={session} scope={jobs.scope} flow={jobs.flow} onClose={() => setJobs(null)} />}
    </Suspense>
  );
}
