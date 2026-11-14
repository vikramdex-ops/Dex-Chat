// Automations: rules that act when something happens in a conversation, drawn as a schematic on
// a ruled sheet and edited part by part. Opened from a conversation's header menu (its rules) and
// from the Control room (every rule, and office-wide ones). A rule can be drafted from plain
// words by a small model on this PC; a draft runs only after someone approves it.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ActionKind, ConditionKind, Conversation, Department, Flow, FlowDryRun, FlowGraph, FlowRun, FlowSample, Message, Session } from '@dex/core';
import { FlowError, freshNodeId, validateGraph } from '@dex/core';
import { draftFlow } from '@dex/core/flow-describe';
import type { DraftFlow } from '@dex/core/flow-describe';
import { Icon, Popover, relativeTime, useToast } from '../ui.tsx';
import { chatState, useChat } from '../chat/store.ts';
import { FlowGraphView } from './FlowGraph.tsx';
import { NodeEditor } from './NodeEditor.tsx';
import type { PickLists } from './NodeEditor.tsx';
import { ACTION_LABEL, CONDITION_LABEL, blankAction, blankCondition } from './labels.ts';
import type { Names } from './labels.ts';
import { loadModel, modelRanker, modelState, onModelState } from './model.ts';
import type { ModelState } from './model.ts';
import './flows.css';

interface Editing {
  id?: string;
  name: string;
  convId: string | null;
  graph: FlowGraph;
  enabled: boolean;
  version?: number;
  canManage: boolean;
  ownerId?: string;
  draft?: DraftFlow;
}

const STARTER: FlowGraph = {
  trigger: { id: 't1', kind: 'file.added', types: ['pdf'] },
  conditions: [],
  actions: [{ id: 'a1', kind: 'notify', to: [{ kind: 'role', id: 'owner' }], text: '{{author.name}} shared {{file.name}} in {{conversation.name}}.' }],
};
const snapshot = (e: Editing | null) => (e ? JSON.stringify([e.name, e.convId, e.graph]) : '');
const sheetNo = (i: number) => `A-${String(i + 1).padStart(2, '0')}`;
const OUTCOME: Record<FlowRun['outcome'], { cls: string; label: string }> = { ok: { cls: 'ok', label: 'Ran' }, failed: { cls: 'bad', label: 'Failed' }, limited: { cls: 'warn', label: 'Held back' } };

/** Which part of the rule each check failed on. */
function nodeErrors(g: FlowGraph): Record<string, string> {
  const out: Record<string, string> = {};
  const ok = { id: 'zz', kind: 'tag', tag: 'ok' };
  const probe = (id: string, graph: unknown) => { try { validateGraph(graph); } catch (e) { if (e instanceof FlowError) out[id] = e.message; } };
  probe(g.trigger.id, { trigger: g.trigger, conditions: [], actions: [ok] });
  for (const c of g.conditions) probe(c.id, { trigger: { id: 'zt', kind: 'file.added' }, conditions: [c], actions: [ok] });
  for (const a of g.actions) probe(a.id, { trigger: { id: 'zt', kind: 'file.added' }, conditions: [], actions: [a] });
  return out;
}

export function AutomationsSheet({ convId, session, onClose }: { convId: string; session: Session; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.popover')) onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div className="sheet-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="sheet wide fl-sheet-wrap" role="dialog" aria-modal="true" aria-label="Automations">
        <button className="sheet-close" onClick={onClose} aria-label="Close" title="Close (Esc)"><Icon name="x" size={18} /></button>
        <div className="sheet-body"><div className="view"><Workbench convId={convId} session={session} /></div></div>
      </aside>
    </div>,
    document.body,
  );
}

/** The Control room's Automations: every rule, office-wide rules, and the office-network setting for webhooks. */
export function AutomationsAdmin({ session }: { session: Session }) {
  const toast = useToast();
  const [allowLan, setAllowLan] = useState<boolean | null>(null);
  useEffect(() => { void window.dex.request('admin.flows.settings').then((s) => setAllowLan(s.allowLan)).catch(() => {}); }, []);
  const set = (v: boolean) => {
    void window.dex.request('admin.flows.settings', { allowLan: v }).then((s) => { setAllowLan(s.allowLan); toast(v ? 'Webhooks may now call the office network' : 'Webhooks can no longer call the office network'); }).catch((e: Error) => toast(e.message, true));
  };
  return (
    <div className="fl-admin">
      <label className="fl-setting card">
        <input type="checkbox" checked={allowLan === true} disabled={allowLan === null} onChange={(e) => set(e.target.checked)} />
        <span>
          <strong>Webhooks may call the office network</strong>
          <span className="faint">Off: automations call only addresses on the internet. On: also servers here (10.x, 192.168.x, this PC). Cloud metadata and link-local addresses are always refused.</span>
        </span>
      </label>
      <Workbench convId={null} session={session} />
    </div>
  );
}

function Workbench({ convId, session }: { convId: string | null; session: Session }) {
  const toast = useToast();
  const office = convId === null;
  const me = session.me;
  const isAdmin = me.role === 'owner' || me.role === 'admin';
  const conversations = useChat((s) => s.conversations);
  const conv = convId ? conversations.get(convId) : undefined;
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [groups, setGroups] = useState<Department[]>([]);
  const [allowLan, setAllowLan] = useState<boolean | null>(null);
  const [current, setCurrent] = useState<string | 'new' | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saved, setSaved] = useState('');
  const [node, setNode] = useState<string | null>(null);
  const [runs, setRuns] = useState<FlowRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [newer, setNewer] = useState<Flow | null>(null);
  /** Parts of a draft the person has looked at. */
  const [visited, setVisited] = useState<Set<string>>(new Set());

  const canCreate = office ? isAdmin : !!conv && me.role !== 'guest' && (conv.createdBy === me.id || (conv.moderators ?? []).includes(me.id) || isAdmin);

  const load = useCallback(async () => {
    try {
      const list = await window.dex.request('flow.list', office ? { scope: 'all' } : { convId: convId! });
      setFlows(list);
    } catch (e) { setFlows([]); toast((e as Error).message, true); }
  }, [office, convId, toast]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void window.dex.request('org.get').then((o) => setGroups(o.departments)).catch(() => {}); }, []);
  useEffect(() => { if (isAdmin) void window.dex.request('admin.flows.settings').then((s) => setAllowLan(s.allowLan)).catch(() => {}); }, [isAdmin]);

  // live: other people's changes and new runs
  useEffect(() => window.dex.onHubEvent((name, data) => {
    if (name === 'flow.updated') {
      const f = data as Flow | null;
      if (!f || (!office && f.convId !== convId)) return;
      setFlows((list) => (list ? (list.some((x) => x.id === f.id) ? list.map((x) => (x.id === f.id ? f : x)) : [...list, f]) : list));
    } else if (name === 'flow.removed') {
      const d = data as { id: string };
      setFlows((list) => list?.filter((x) => x.id !== d.id) ?? list);
    } else if (name === 'flow.ran') {
      const d = data as { flowId: string; run: FlowRun };
      setFlows((list) => list?.map((x) => (x.id === d.flowId ? { ...x, lastRun: d.run } : x)) ?? list);
      setRuns((r) => (current === d.flowId ? [d.run, ...r.filter((x) => x.id !== d.run.id)].slice(0, 50) : r));
    }
  }), [office, convId, current]);

  const open = useCallback((f: Flow) => {
    const e: Editing = { id: f.id, name: f.name, convId: f.convId, graph: f.graph, enabled: f.enabled, version: f.version, canManage: f.canManage, ownerId: f.ownerId };
    setCurrent(f.id);
    setEditing(e);
    setSaved(snapshot(e));
    setNode(f.graph.trigger.id);
    setNewer(null);
    setRuns([]);
    void window.dex.request('flow.runs', { id: f.id }).then(setRuns).catch(() => {});
  }, []);

  // pick the first rule once they are loaded
  useEffect(() => { if (flows && current === null && flows.length) open(flows[0]); }, [flows, current, open]);
  // someone else saved the rule being edited
  useEffect(() => {
    if (!editing?.id || !flows) return;
    const f = flows.find((x) => x.id === editing.id);
    if (!f) { setCurrent(null); setEditing(null); return; }
    if (f.version !== editing.version || f.enabled !== editing.enabled) {
      if (snapshot(editing) === saved) open(f);
      else if (f.version !== editing.version) setNewer(f);
      else setEditing({ ...editing, enabled: f.enabled });
    }
  }, [flows]); // eslint-disable-line react-hooks/exhaustive-deps

  const users = useMemo(() => new Map(session.users.map((u) => [u.id, u] as const)), [session.users]);
  const spaces = useMemo(() => [...conversations.values()].filter((c) => c.kind === 'space' && !c.archived).map((c) => ({ id: c.id, name: c.name ?? 'Space' })).sort((a, b) => a.name.localeCompare(b.name)), [conversations]);
  const names: Names = useMemo(() => ({
    person: (id) => users.get(id)?.displayName ?? 'someone who left',
    group: (id) => groups.find((g) => g.id === id)?.name ?? 'a removed group',
    conv: (id) => conversations.get(id)?.name ?? flows?.find((f) => f.convId === id)?.convName ?? 'a conversation',
  }), [users, groups, conversations, flows]);
  const lists: PickLists = useMemo(() => ({
    people: session.users.filter((u) => u.role !== 'bot').map((u) => ({ id: u.id, name: u.displayName })).sort((a, b) => a.name.localeCompare(b.name)),
    groups: groups.map((g) => ({ id: g.id, name: g.name })),
    spaces,
  }), [session.users, groups, spaces]);

  const startNew = (draft?: DraftFlow) => {
    const e: Editing = draft
      ? { name: draft.name, convId: draft.convId, graph: draft.graph, enabled: true, canManage: true, draft }
      : { name: 'New rule', convId, graph: STARTER, enabled: true, canManage: true };
    setCurrent('new');
    setEditing(e);
    setSaved('');
    setRuns([]);
    setNewer(null);
    setVisited(new Set());
    const unsure = draft ? Object.entries(draft.nodes).find(([, n]) => n.missing.length || n.confidence < 0.7)?.[0] : undefined;
    setNode(unsure ?? e.graph.trigger.id);
  };

  const dirty = !!editing && snapshot(editing) !== saved;
  const readOnly = !editing?.canManage;
  const errors = editing ? nodeErrors(editing.graph) : {};

  const save = async (enabled: boolean) => {
    if (!editing) return;
    const firstBad = Object.keys(errors)[0];
    if (firstBad) { setNode(firstBad); toast(errors[firstBad], true); return; }
    if (!editing.name.trim()) { toast('Give the rule a name.', true); return; }
    setBusy(true);
    try {
      const f = await window.dex.request('flow.save', { ...(editing.id ? { id: editing.id, version: editing.version } : {}), convId: editing.convId, name: editing.name.trim(), graph: editing.graph, enabled });
      setFlows((list) => (list ? (list.some((x) => x.id === f.id) ? list.map((x) => (x.id === f.id ? f : x)) : [...list, f]) : [f]));
      open(f);
      toast(editing.id ? `Saved revision ${f.version}` : enabled ? 'Approved: the rule is on' : 'Saved, turned off');
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  const toggle = async () => {
    if (!editing?.id) return;
    try {
      const f = await window.dex.request('flow.enable', { id: editing.id, enabled: !editing.enabled });
      setFlows((list) => list?.map((x) => (x.id === f.id ? f : x)) ?? list);
      setEditing({ ...editing, enabled: f.enabled });
      toast(f.enabled ? 'The rule is on' : 'The rule is off');
    } catch (e) { toast((e as Error).message, true); }
  };

  const remove = async () => {
    if (!editing?.id || !window.confirm(`Remove “${editing.name}”? Its run log goes with it.`)) return;
    try {
      await window.dex.request('flow.delete', { id: editing.id });
      setFlows((list) => list?.filter((x) => x.id !== editing.id) ?? list);
      setCurrent(null);
      setEditing(null);
      toast('Rule removed');
    } catch (e) { toast((e as Error).message, true); }
  };

  const setGraph = (graph: FlowGraph) => editing && setEditing({ ...editing, graph });
  const addCondition = (kind: ConditionKind) => {
    if (!editing) return;
    const id = freshNodeId(editing.graph, 'c');
    setGraph({ ...editing.graph, conditions: [...editing.graph.conditions, blankCondition(kind, id)] });
    setNode(id);
  };
  const addAction = (kind: ActionKind) => {
    if (!editing) return;
    const id = freshNodeId(editing.graph, 'a');
    setGraph({ ...editing.graph, actions: [...editing.graph.actions, blankAction(kind, id, editing.graph)] });
    setNode(id);
  };
  const removeNode = () => {
    if (!editing || !node) return;
    const g = editing.graph;
    if (g.actions.length === 1 && g.actions[0].id === node) { toast('A rule needs at least one step.', true); return; }
    setGraph({ ...g, conditions: g.conditions.filter((c) => c.id !== node), actions: g.actions.filter((a) => a.id !== node) });
    setNode(g.trigger.id);
  };
  const moveNode = (dir: -1 | 1) => {
    if (!editing || !node) return;
    const g = editing.graph;
    const shift = <T extends { id: string }>(arr: T[]): T[] => {
      const i = arr.findIndex((x) => x.id === node);
      if (i < 0 || i + dir < 0 || i + dir >= arr.length) return arr;
      const next = [...arr];
      [next[i], next[i + dir]] = [next[i + dir], next[i]];
      return next;
    };
    setGraph({ ...g, conditions: shift(g.conditions), actions: shift(g.actions) });
  };

  const scopeName = (id: string | null) => (id ? names.conv(id) : 'Every Space');
  const owner = editing?.ownerId ? users.get(editing.ownerId)?.displayName ?? 'Someone who left' : me.displayName;

  return (
    <div className="fl-bench">
      <div className="view-head">
        <div>
          <div className="label">Automations{office ? ' · Control room' : ''}</div>
          <h1 translate="no">{office ? 'Every rule in the office' : conv ? conv.name ?? 'This conversation' : 'Conversation'}</h1>
          <p className="faint">{office ? 'Office-wide rules watch every Space. Rules for one conversation are listed with it.' : 'Rules that act when something happens here: a file, a reaction, a vote, words or a mention.'}</p>
        </div>
        {flows && (
          <dl className="title-block fl-count">
            <div><dt>Rules</dt><dd>{flows.length}</dd></div>
            <div><dt>On</dt><dd>{flows.filter((f) => f.enabled).length}</dd></div>
          </dl>
        )}
      </div>

      {canCreate && <Describe convId={convId} session={session} groups={groups} onDraft={startNew} />}

      <div className="fl-tabs" role="tablist" aria-label="Rules">
        {(flows ?? []).map((f, i) => (
          <button key={f.id} type="button" role="tab" aria-selected={current === f.id} className="fl-tab" onClick={() => { if (dirty && !window.confirm('Leave this rule without saving your changes?')) return; open(f); }}>
            <span className="fl-tab-no">{sheetNo(i)}</span>
            <span className="fl-tab-name" translate="no">{f.name}</span>
            {office && <span className="fl-tab-scope" translate="no">{f.convId ? f.convName ?? 'Conversation' : 'Every Space'}</span>}
            <span className={`fl-dot${f.enabled ? ' on' : ''}${f.lastRun?.outcome === 'failed' ? ' bad' : ''}`} aria-label={f.enabled ? 'On' : 'Off'} />
          </button>
        ))}
        {current === 'new' && <button type="button" role="tab" aria-selected className="fl-tab"><span className="fl-tab-no">{editing?.draft ? 'Draft' : 'New'}</span><span className="fl-tab-name" translate="no">{editing?.name}</span></button>}
        {canCreate && current !== 'new' && <button type="button" className="fl-tab fl-tab-add" onClick={() => { if (dirty && !window.confirm('Leave this rule without saving your changes?')) return; startNew(); }}><Icon name="plus" size={14} />New rule</button>}
      </div>

      {flows === null && <div className="tl-more"><span className="spinner" /></div>}
      {flows && !flows.length && !editing && (
        <div className="empty fl-empty">
          <Icon name="repeat" size={32} />
          <span>{canCreate ? 'No rules yet. Describe one above, or start a new rule.' : 'No rules here yet. The person who started this conversation, its moderators and administrators can add them.'}</span>
        </div>
      )}

      {editing && (
        <>
          {editing.draft && (
            <div className="fl-note proposed" role="status">
              <strong>Proposed rule</strong>
              <span>Drafted from your words{editing.draft.method === 'model' ? ' with the on-device model' : ' with keywords only'}. Check the parts marked △, fill in anything missing, then approve. Nothing runs until you do.</span>
              {editing.draft.notes.map((n) => <span key={n} className="fl-note-line">{n}</span>)}
            </div>
          )}
          {newer && (
            <div className="fl-note proposed" role="status">
              <strong>Saved elsewhere</strong>
              <span>{users.get(newer.updatedBy)?.displayName ?? 'Someone'} saved revision {newer.version} while you were editing. Saving yours will be refused.</span>
              <button className="btn" onClick={() => open(newer)}>Load their revision</button>
            </div>
          )}
          {readOnly && <div className="fl-note">You can see this rule but not change it.</div>}

          <FlowGraphView graph={editing.graph} names={names} selected={node} onSelect={(id) => { setNode(id); setVisited((v) => new Set(v).add(id)); }} errors={errors}
            marks={editing.draft ? Object.fromEntries(Object.entries(editing.draft.nodes).map(([k, v]) => [k, { confidence: v.confidence, missing: errors[k] ? v.missing : [], checked: visited.has(k) && !errors[k] }])) : undefined} />

          {!readOnly && (
            <div className="fl-add">
              <AddMenu label="Add a condition" disabled={editing.graph.conditions.length >= 6} items={(Object.keys(CONDITION_LABEL) as ConditionKind[]).map((k) => ({ key: k, label: CONDITION_LABEL[k] }))} onPick={(k) => addCondition(k as ConditionKind)} />
              <AddMenu label="Add a step" disabled={editing.graph.actions.length >= 8} items={(Object.keys(ACTION_LABEL) as ActionKind[]).map((k) => ({ key: k, label: ACTION_LABEL[k] }))} onPick={(k) => addAction(k as ActionKind)} />
            </div>
          )}

          {node && <NodeEditor graph={editing.graph} nodeId={node} onChange={setGraph} lists={lists} readOnly={readOnly} onRemove={removeNode} onMove={moveNode} allowLan={allowLan} />}

          <dl className="title-block fl-titleblock">
            <div>
              <dt>Rule</dt>
              <dd className="fl-tb-name">{readOnly ? <span translate="no">{editing.name}</span> : <input className="fl-tb-input" aria-label="Rule name" value={editing.name} maxLength={80} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />}</dd>
            </div>
            <div>
              <dt>Watches</dt>
              <dd>{!editing.id && (isAdmin || office) ? (
                <select className="fl-tb-input" aria-label="Where the rule watches" value={editing.convId ?? ''} onChange={(e) => setEditing({ ...editing, convId: e.target.value || null })}>
                  {isAdmin && <option value="">Every Space</option>}
                  {editing.convId && !spaces.some((s) => s.id === editing.convId) && <option value={editing.convId}>{scopeName(editing.convId)}</option>}
                  {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              ) : <span translate="no">{scopeName(editing.convId)}</span>}</dd>
            </div>
            <div><dt>Rev</dt><dd>{editing.version ? `${editing.version}${dirty ? ' + changes' : ''}` : editing.draft ? 'Draft' : 'New'}</dd></div>
            <div><dt>State</dt><dd>{editing.id ? (editing.enabled ? 'On' : 'Off') : 'Not saved'}</dd></div>
            <div><dt>Owner</dt><dd translate="no">{owner}</dd></div>
            <div><dt>Last run</dt><dd>{(() => { const f = flows?.find((x) => x.id === editing.id); return f?.lastRun ? `${relativeTime(f.lastRun.at)} · ${OUTCOME[f.lastRun.outcome].label}` : 'Never'; })()}</dd></div>
          </dl>

          <div className="fl-actions">
            {!readOnly && !editing.id && <button className="btn primary" disabled={busy} onClick={() => void save(true)}><Icon name="check" size={15} />{editing.draft ? 'Approve and turn on' : 'Save and turn on'}</button>}
            {!readOnly && !editing.id && <button className="btn" disabled={busy} onClick={() => void save(false)}>Save, turned off</button>}
            {!readOnly && !editing.id && <button className="btn ghost" onClick={() => { setCurrent(null); setEditing(null); if (flows?.length) open(flows[0]); }}>Discard</button>}
            {!readOnly && editing.id && <button className="btn primary" disabled={busy || !dirty} onClick={() => void save(editing.enabled)}>Save changes</button>}
            {!readOnly && editing.id && dirty && <button className="btn ghost" onClick={() => { const f = flows?.find((x) => x.id === editing.id); if (f) open(f); }}>Undo changes</button>}
            {!readOnly && editing.id && !dirty && <button className="btn" onClick={() => void toggle()}>{editing.enabled ? 'Turn off' : 'Turn on'}</button>}
            <span className="fl-spacer" />
            {!readOnly && editing.id && <button className="btn ghost danger" onClick={() => void remove()}><Icon name="trash" size={14} />Remove</button>}
          </div>

          <TestRun editing={editing} convId={convId} users={users} />

          {editing.id && <RunLog runs={runs} />}
        </>
      )}
    </div>
  );
}

function AddMenu({ label, items, onPick, disabled }: { label: string; items: Array<{ key: string; label: string }>; onPick: (k: string) => void; disabled?: boolean }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [openMenu, setOpen] = useState(false);
  return (
    <>
      <button ref={setAnchor} type="button" className="btn" disabled={disabled} aria-haspopup="menu" aria-expanded={openMenu} onClick={() => setOpen(!openMenu)}><Icon name="plus" size={14} />{label}</button>
      {openMenu && (
        <Popover anchor={anchor} onClose={() => setOpen(false)} className="menu" align="start">
          {items.map((it) => <button key={it.key} role="menuitem" onClick={() => { setOpen(false); onPick(it.key); }}>{it.label}</button>)}
        </Popover>
      )}
    </>
  );
}

// ------------------------------------------------------------------ describe
function Describe({ convId, session, groups, onDraft }: { convId: string | null; session: Session; groups: Department[]; onDraft: (d: DraftFlow) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<ModelState>(modelState());
  const [fallback, setFallback] = useState<string | null>(null);
  useEffect(() => onModelState(setModel), []);
  const draft = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const ranker = await modelRanker();
      const s = modelState();
      setFallback(ranker ? null : s.phase === 'failed' ? s.reason : 'The on-device model is not available.');
      const ctx = {
        conversations: [...chatState().conversations.values()].map((c: Conversation) => ({ id: c.id, name: c.name ?? '', kind: c.kind })),
        people: session.users.filter((u) => u.role !== 'bot').map((u) => ({ id: u.id, name: u.displayName, account: u.account })),
        groups: groups.map((g) => ({ id: g.id, name: g.name })),
        meId: session.me.id,
        convId,
      };
      const d = await draftFlow(text, ctx, ranker);
      if (!ranker) d.notes.unshift('The on-device model did not load, so this was drafted with keywords only.');
      onDraft(d);
    } finally { setBusy(false); }
  };
  const status = model.phase === 'ready' ? 'On-device model ready' : model.phase === 'loading' ? 'Loading the on-device model…' : model.phase === 'failed' ? 'Keywords only (the model did not load)' : 'The on-device model loads when you start';
  return (
    <section className="fl-describe" aria-label="Describe a rule">
      <div className="fl-describe-head">
        <span className="fl-k">Describe a rule</span>
        <span className={`fl-model mono${model.phase === 'failed' ? ' warn' : model.phase === 'ready' ? ' ok' : ''}`} title={fallback ?? undefined}>{status}</span>
      </div>
      <textarea className="input fl-describe-text" rows={2} value={text} onChange={(e) => setText(e.target.value)} onFocus={() => void loadModel()}
        aria-label="Describe a rule in your own words"
        placeholder="When someone uploads a PDF in Design, extract its title and revision, then notify Document Review."
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void draft(); } }} />
      <div className="fl-describe-foot">
        <span className="faint">Runs on this PC. You check the draft before anything runs.</span>
        <button className="btn primary" disabled={busy || !text.trim()} onClick={() => void draft()}>{busy ? <span className="spinner" /> : <Icon name="edit" size={15} />}Draft the rule</button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ test run
function TestRun({ editing, convId, users }: { editing: Editing; convId: string | null; users: Map<string, Session['users'][number]> }) {
  const toast = useToast();
  const timeline = useChat((s) => (editing.convId ?? convId ? s.timelines.get(editing.convId ?? convId!) : undefined));
  const recent = useMemo(() => (timeline?.messages ?? []).filter((m): m is Message => !('pending' in m) && !m.system && !m.deleted).slice(-30).reverse(), [timeline]);
  const kind = editing.graph.trigger.kind;
  const fits = (m: Message) => (kind === 'file.added' ? m.files.length > 0 : kind === 'response.confirmed' ? !!(m.poll || m.form) : true);
  const [pick, setPick] = useState<string>('');
  const [sample, setSample] = useState<FlowSample>({});
  const [result, setResult] = useState<FlowDryRun | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setResult(null); }, [editing.id, editing.graph]);
  useEffect(() => { setPick((p) => p || (recent.find(fits)?.id ?? '')); }, [recent, kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async () => {
    setBusy(true);
    try {
      const r = await window.dex.request('flow.test', { convId: editing.convId, graph: editing.graph, sample: pick ? { messageId: pick } : sample });
      setResult(r);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const label = (m: Message) => `${users.get(m.authorId)?.displayName ?? 'Someone'}: ${m.files.length ? m.files.map((f) => f.name).join(', ') : m.poll ? `poll “${m.poll.question}”` : m.form ? `form “${m.form.title}”` : m.body.replace(/<@[^>]+>/g, '@…').slice(0, 60)}`;
  return (
    <section className="fl-test" aria-label="Test run">
      <div className="fl-section-head"><span className="fl-k">Test run</span><span className="faint">Shows what would happen. Nothing is sent, posted or tagged.</span></div>
      <div className="fl-test-row">
        <div className="field">
          <label>Try it on</label>
          <select className="input" aria-label="Try it on" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Made-up details</option>
            {recent.map((m) => <option key={m.id} value={m.id}>{label(m)}</option>)}
          </select>
        </div>
        {!pick && (kind === 'file.added' || editing.graph.actions.some((a) => a.kind === 'extract')) && <div className="field"><label>File name</label><input className="input" aria-label="File name" placeholder="GA-101 Rev C.pdf" value={sample.fileName ?? ''} onChange={(e) => setSample({ ...sample, fileName: e.target.value })} /></div>}
        {!pick && (kind === 'message.matched' || kind === 'message.mentioned') && <div className="field"><label>Message text</label><input className="input" aria-label="Message text" placeholder="Please check this urgently" value={sample.text ?? ''} onChange={(e) => setSample({ ...sample, text: e.target.value })} /></div>}
        {kind === 'reaction.added' && <div className="field"><label>Reaction</label><input className="input" aria-label="Reaction" placeholder={editing.graph.trigger.kind === 'reaction.added' ? editing.graph.trigger.emoji : ''} value={sample.emoji ?? ''} onChange={(e) => setSample({ ...sample, emoji: e.target.value })} /></div>}
        {kind === 'response.confirmed' && <div className="field"><label>Choice</label><input className="input" aria-label="Choice" placeholder="Yes" value={sample.choice ?? ''} onChange={(e) => setSample({ ...sample, choice: e.target.value })} /></div>}
        <button className="btn" disabled={busy} onClick={() => void run()}>{busy ? <span className="spinner" /> : <Icon name="play" size={14} />}Test run</button>
      </div>
      {result && (
        <div className="fl-result">
          <div className="fl-result-head">
            <span className={`chip ${result.matched ? 'ok' : 'warn'}`}>{result.matched ? 'Would run' : 'Would not run'}</span>
            <span translate="no">{result.event}</span>
          </div>
          {!result.matched && <p className="fl-reason">{result.reason}</p>}
          {result.steps.length > 0 && (
            <ol className="fl-steps">
              {result.steps.map((s) => (
                <li key={s.nodeId}>
                  <span className="mono fl-step-id">{s.nodeId.toUpperCase()}</span>
                  <span className={`chip ${s.status === 'failed' ? 'bad' : s.status === 'skipped' ? '' : 'accent'}`}>{s.status === 'would' ? ACTION_LABEL[s.kind] : s.status === 'failed' ? 'Would fail' : 'Skipped'}</span>
                  <span className="fl-step-note" translate="no">{s.note}</span>
                </li>
              ))}
            </ol>
          )}
          {result.matched && (
            <details className="fl-vars-table">
              <summary>Values the steps saw</summary>
              <table><tbody>{Object.entries(result.variables).filter(([, v]) => v).map(([k, v]) => <tr key={k}><th className="mono" translate="no">{`{{${k}}}`}</th><td translate="no">{v}</td></tr>)}</tbody></table>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ run log
function RunLog({ runs }: { runs: FlowRun[] }) {
  return (
    <section className="fl-log" aria-label="Run log">
      <div className="fl-section-head"><span className="fl-k">Run log</span><span className="faint">The last 50 runs.</span></div>
      {!runs.length ? <div className="fl-log-empty faint">It has not run yet.</div> : (
        <table className="fl-log-table">
          <thead><tr><th>When</th><th>Outcome</th><th>What happened</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="mono" title={new Date(r.at).toLocaleString()}>{relativeTime(r.at)}</td>
                <td><span className={`chip ${OUTCOME[r.outcome].cls}`}>{OUTCOME[r.outcome].label}</span></td>
                <td>
                  <div translate="no">{r.event}</div>
                  {r.error && <div className="fl-log-err" translate="no">{r.error}</div>}
                  {r.steps.length > 0 && <div className="fl-log-steps faint" translate="no">{r.steps.map((s) => `${s.nodeId.toUpperCase()} ${s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : '–'} ${s.note}`).join(' · ')}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
