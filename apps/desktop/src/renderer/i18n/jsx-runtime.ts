// The JSX runtime for the interface: React's, with literal text in elements translated (see index.ts).
import * as R from 'react/jsx-runtime';
import { tr, translating } from './index.ts';

export const Fragment = R.Fragment;
const PROPS = ['title', 'placeholder', 'aria-label', 'alt', 'label'] as const;

function translateProps(type: unknown, props: Record<string, unknown>): Record<string, unknown> {
  // only elements on the page and fragments (<>…</> holds text too), not components; never inside translate="no"
  if (!translating() || (typeof type !== 'string' && type !== R.Fragment) || props.translate === 'no') return props;
  let out = props;
  const set = (k: string, v: unknown) => { if (out === props) out = { ...props }; out[k] = v; };
  for (const k of PROPS) if (typeof props[k] === 'string') set(k, tr(props[k] as string));
  const c = props.children;
  if (typeof c === 'string') set('children', tr(c));
  else if (Array.isArray(c) && c.some((x) => typeof x === 'string')) set('children', c.map((x) => (typeof x === 'string' ? tr(x) : x)));
  return out;
}

export function jsx(type: React.ElementType, props: Record<string, unknown>, key?: React.Key): React.ReactElement {
  return R.jsx(type, translateProps(type, props), key);
}
export function jsxs(type: React.ElementType, props: Record<string, unknown>, key?: React.Key): React.ReactElement {
  return R.jsxs(type, translateProps(type, props), key);
}
