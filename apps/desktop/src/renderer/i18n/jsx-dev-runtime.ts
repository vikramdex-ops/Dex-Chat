// Development build of the same runtime (Vite's dev server uses jsxDEV).
import * as R from 'react/jsx-dev-runtime';
import { jsx } from './jsx-runtime.ts';

export const Fragment = R.Fragment;
export function jsxDEV(type: React.ElementType, props: Record<string, unknown>, key?: React.Key): React.ReactElement {
  return jsx(type, props, key);
}
