// Listens for dex-botmaker and shows the bot maker, which loads the first time it is opened.
import { Suspense, lazy, useEffect, useState } from 'react';
import type { Session } from '@dex/core';
import type { MakerRequest } from './open.ts';

const BotMaker = lazy(() => import('./BotMaker.tsx'));

export function BotMakerHost({ session }: { session: Session }) {
  const [req, setReq] = useState<MakerRequest | null>(null);
  useEffect(() => {
    const on = (e: Event) => setReq({ ...((e as CustomEvent).detail ?? {}) });
    window.addEventListener('dex-botmaker', on);
    return () => window.removeEventListener('dex-botmaker', on);
  }, []);
  if (!req) return null;
  return <Suspense fallback={null}><BotMaker key={JSON.stringify(req)} req={req} session={session} onClose={() => setReq(null)} /></Suspense>;
}
