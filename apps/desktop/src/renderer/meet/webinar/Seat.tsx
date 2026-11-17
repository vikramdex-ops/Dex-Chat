// Where a webinar being watched shows: its sheet loads the first time someone watches one.
import { Suspense, lazy } from 'react';
import { useWeb } from './store.ts';

const Watch = lazy(() => import('./Watch.tsx'));

export function WebinarSeat() {
  const watching = useWeb((s) => !!s.watching);
  if (!watching) return null;
  return <Suspense fallback={null}><Watch /></Suspense>;
}
