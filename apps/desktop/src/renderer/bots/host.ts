// The app's side of a tool's postMessage API: it answers only its own frame, checks each call
// against the permissions an administrator approved, and asks the person before a tool posts a
// message or opens a file. Shared state goes through the hub and comes back to every frame.
import type { Conversation, MiniAppState, MiniAppView, PublicUser } from '@dex/core';
import { MINIAPP_CALLS, isMiniAppRequest } from '@dex/core/miniapp';
import { sendMessage } from '../chat/store.ts';
import { fileSrc } from '../chat/files.tsx';

export type Consent = { kind: 'post'; text: string } | { kind: 'file'; name: string; size: number };

export interface HostOptions {
  view: MiniAppView;
  conv: Conversation;
  convName: string;
  me: PublicUser;
  users: Map<string, PublicUser>;
  /** Ask the person; resolves true when they agree. */
  ask: (c: Consent) => Promise<boolean>;
  resize: (height: number) => void;
}

const MAX_FILE = 25 * 1024 * 1024;
const TOKENS: Array<[string, string]> = [
  ['bg', '--layer-solid'], ['text', '--text'], ['text-2', '--text-2'], ['text-3', '--text-3'], ['stroke', '--stroke'], ['stroke-strong', '--stroke-strong'],
  ['subtle', '--subtle'], ['accent', '--accent'], ['accent-soft', '--accent-soft'], ['accent-text', '--accent-text'], ['accent-ink', '--accent-ink'],
  ['amber', '--amber'], ['amber-soft', '--amber-soft'], ['ok', '--ok'], ['danger', '--danger'],
  ['font-body', '--font-body'], ['font-mono', '--font-mono'], ['font-display', '--font-display'],
];

/** The app's colours and type, for tools to match. */
export function themeForTools(): { mode: 'light' | 'dark'; colors: Record<string, string> } {
  const cs = getComputedStyle(document.documentElement);
  return {
    mode: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
    colors: Object.fromEntries(TOKENS.map(([k, v]) => [k, cs.getPropertyValue(v).trim()]).filter(([, v]) => v)),
  };
}

/** Files a person agreed a tool may open, per tool in a conversation (until the app restarts). */
const allowed = new Set<string>();

/** Answer one frame. Returns a function that stops listening. */
export function hostTool(frame: HTMLIFrameElement, opts: () => HostOptions): () => void {
  const post = (msg: unknown, transfer: Transferable[] = []) => frame.contentWindow?.postMessage(msg, '*', transfer);
  let pending = 0;
  const handle = async (method: string, params: Record<string, unknown>): Promise<{ result: unknown; transfer?: Transferable[] }> => {
    const o = opts();
    const need = MINIAPP_CALLS[method];
    if (need === undefined) throw new Error(`Unknown call: ${method}`);
    if (need && !o.view.permissions.includes(need)) throw new Error(`${o.view.name} was not approved to use ${need}.`);
    const id = o.view.instanceId;
    switch (method) {
      case 'context.get':
        return { result: {
          viewer: { id: o.me.id, name: o.me.displayName },
          conversation: { id: o.conv.id, kind: o.conv.kind, name: o.convName },
          app: { id: o.view.appId, name: o.view.name, version: o.view.version },
          instanceId: id, permissions: o.view.permissions, theme: themeForTools(),
        } };
      case 'ui.resize': {
        const h = Number(params.height);
        if (Number.isFinite(h)) o.resize(Math.max(120, Math.min(900, Math.round(h))));
        return { result: { ok: true } };
      }
      case 'members.list':
        return { result: o.conv.members.map((m) => o.users.get(m)).filter((u): u is PublicUser => !!u && u.role !== 'bot').map((u) => ({ id: u.id, name: u.displayName, title: u.title })) };
      case 'message.post': {
        const text = typeof params.text === 'string' ? params.text.trim().slice(0, 4000) : '';
        if (!text) throw new Error('Nothing to post.');
        if (!(await o.ask({ kind: 'post', text }))) return { result: { posted: false } };
        await sendMessage(o.conv.id, text);
        return { result: { posted: true } };
      }
      case 'state.get':
        return { result: await window.dex.request('miniapp.state.get', { instanceId: id }) };
      case 'state.set':
        return { result: await window.dex.request('miniapp.state.set', { instanceId: id, state: params.state, baseVersion: typeof params.baseVersion === 'number' ? params.baseVersion : undefined }) };
      case 'files.list': {
        const list = await window.dex.request('file.list', { convId: o.conv.id, limit: 200 });
        return { result: list.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, createdAt: f.createdAt })) };
      }
      case 'files.read': {
        const fileId = typeof params.fileId === 'string' ? params.fileId : '';
        const f = (await window.dex.request('file.list', { convId: o.conv.id, limit: 200 })).find((x) => x.id === fileId);
        if (!f) throw new Error('That file is not shared in this conversation.');
        if (f.size > MAX_FILE) throw new Error('That file is too large for a tool (25 MB at most).');
        const key = `${id}:${f.id}`;
        if (!allowed.has(key)) {
          if (!(await o.ask({ kind: 'file', name: f.name, size: f.size }))) throw new Error('You chose not to open it.');
          allowed.add(key);
        }
        const bytes = await (await fetch(fileSrc(f.id))).arrayBuffer();
        return { result: { id: f.id, name: f.name, mime: f.mime, size: f.size, bytes }, transfer: [bytes] };
      }
    }
    throw new Error(`Unknown call: ${method}`);
  };
  const onMessage = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow || !isMiniAppRequest(e.data)) return;
    const req = e.data;
    if (pending > 32) { post({ dex: 1, id: req.id, ok: false, error: 'Too many calls at once.' }); return; }
    pending++;
    handle(req.method, req.params && typeof req.params === 'object' ? req.params as Record<string, unknown> : {})
      .then((r) => post({ dex: 1, id: req.id, ok: true, result: r.result }, r.transfer ?? []))
      .catch((err: Error) => post({ dex: 1, id: req.id, ok: false, error: err.message || 'That did not work.' }))
      .finally(() => { pending--; });
  };
  window.addEventListener('message', onMessage);
  const offHub = window.dex.onHubEvent((name, data) => {
    if (name !== 'miniapp.state') return;
    const s = data as MiniAppState;
    if (s.instanceId === opts().view.instanceId) post({ dex: 1, event: 'state', data: { state: s.state, version: s.version, updatedBy: s.updatedBy } });
  });
  const theme = new MutationObserver(() => post({ dex: 1, event: 'theme', data: themeForTools() }));
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => { window.removeEventListener('message', onMessage); offHub(); theme.disconnect(); };
}
