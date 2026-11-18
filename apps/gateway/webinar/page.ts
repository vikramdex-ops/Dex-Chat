// The webinar pages the gateway serves to people outside the office, drawn as drafting sheets:
//   /w/<ID>               register: the webinar's details, name, email and the organiser's
//                         questions; then the personal link (and a calendar file with it);
//   /w/<ID>/watch#<token> watch: a "starting soon" sheet with a countdown until the organiser
//                         goes live, then the stage (sent straight from the office's PC
//                         composing it), questions with votes, the poll, handouts, a hand to raise
//                         and reactions; an invitation to speak opens the meeting page;
//   /w/<ID>/survey#<token> the follow-up survey.
// The token stays in the fragment and in this tab (sessionStorage); it is sent to the hub in the
// first frame or request. System fonts only; nothing is loaded from anywhere else.
import { MEETING_REACTIONS } from '@dex/core/protocol';
import type { FieldAnswers, Handout, StageRoute, WebinarDown, WebinarField, WebinarLive, WebinarPoll, WebinarPublic, WebinarQuestion, WebinarUpdate } from '@dex/core/webinar';
import { buildIcs } from '@dex/core/ics';
import { capName, clock, day, h, icon, pad, sizeText } from './dom.ts';

const app = document.getElementById('app') as HTMLElement;
const meetingId = app.dataset.webinar ?? '';
const mode = (app.dataset.mode ?? 'register') as 'register' | 'watch' | 'survey';
// the webinar's ID (482-913-207) or the name its organiser gave it on the meeting site
const displayId = /^\d{9}$/.test(meetingId) ? `${meetingId.slice(0, 3)}-${meetingId.slice(3, 6)}-${meetingId.slice(6)}` : meetingId;
const TOKEN_KEY = `dex.webinar.token.${meetingId}`;
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

// the token: from the fragment (then out of the address bar), or kept for this tab
const fromHash = decodeURIComponent(location.hash.slice(1)).trim();
let token = TOKEN_RE.test(fromHash) ? fromHash : '';
try {
  if (token) sessionStorage.setItem(TOKEN_KEY, token); else token = sessionStorage.getItem(TOKEN_KEY) ?? '';
} catch { /* storage blocked: keep it in memory */ }
if (location.hash) history.replaceState(null, '', location.pathname);

// ------------------------------------------------------------------ the sheet frame
let titleCells: Array<[string, string, string?]> = [['Webinar', '—', 'wide'], ['ID', displayId, 'mono'], ['Starts', '—'], ['Sheet', mode === 'watch' ? 'WATCH' : mode === 'survey' ? 'SURVEY' : 'REGISTER', 'mono']];

function frame(body: HTMLElement, wide = false): void {
  app.replaceChildren(h('div', { class: `sheet${wide ? ' wide' : ''}` },
    h('header', { class: 'sheet-head' }, h('span', { class: 'mark' }, h('i', { 'aria-hidden': 'true' }), 'Dexterity Connect'), h('span', { class: 'mono faint' }, `WEBINAR · ${displayId}`)),
    h('section', { class: 'sheet-body' }, body),
    h('footer', { class: 'title-block', 'aria-label': 'Webinar details' }, ...titleCells.map(([label, value, cls]) => h('div', { class: `tb-cell ${cls ?? ''}` }, h('span', { class: 'tb-label' }, label), h('span', { class: 'tb-value' }, value)))),
  ));
}

function setTitle(title: string, startsAt: number): void {
  titleCells = [['Webinar', title, 'wide'], ['ID', displayId, 'mono'], ['Starts', `${new Date(startsAt).toLocaleDateString([], { day: 'numeric', month: 'short' })} · ${clock(startsAt)}`], titleCells[3]];
}

function message(label: string, title: string, lead: string, ...extra: HTMLElement[]): void {
  frame(h('div', { class: 'step' }, h('p', { class: 'label' }, label), h('h1', {}, title), h('p', { class: 'lead', role: 'status' }, lead), ...extra));
}

async function api<T>(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  try {
    const res = await fetch(`/w/${meetingId}/${path}`, body === undefined ? { headers: { accept: 'application/json' } } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({ error: 'The office answered with something unexpected.' })) as T & { error?: string };
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'The page could not reach the office. Check your connection and try again.' } as T & { error?: string } };
  }
}

/** A field of the organiser's questions: a line of text, or one of their answers. */
function fieldInput(f: WebinarField, value = ''): HTMLElement {
  const id = `f-${f.id}`;
  const label = h('label', { class: 'field-label', for: id }, f.label, f.required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null);
  if (f.kind === 'choice') {
    const sel = h('select', { id, name: f.id, class: 'input', required: f.required || undefined },
      h('option', { value: '' }, f.required ? 'Choose one' : 'Choose one (optional)'),
      ...f.options.map((o) => h('option', { value: o, selected: o === value || undefined }, o)));
    return h('div', { class: 'wfield' }, label, sel);
  }
  return h('div', { class: 'wfield' }, label, h('input', { id, name: f.id, class: 'input', maxlength: '1000', required: f.required || undefined, value }));
}

function readFields(form: HTMLFormElement, fields: WebinarField[]): FieldAnswers {
  const out: FieldAnswers = {};
  for (const f of fields) {
    const el = form.elements.namedItem(f.id) as HTMLInputElement | HTMLSelectElement | null;
    const v = el?.value.trim() ?? '';
    if (v) out[f.id] = v;
  }
  return out;
}

// ------------------------------------------------------------------ register
async function register(): Promise<void> {
  message('Registration', 'Loading the webinar', 'One moment.');
  const res = await api<WebinarPublic>('info');
  if (!res.ok) { message('Registration', res.status === 404 ? 'No webinar here' : 'Not available right now', res.data.error ?? 'Try again in a moment.'); return; }
  const w = res.data;
  setTitle(w.title, w.startsAt);
  const end = w.startsAt + w.durationMin * 60_000;
  const facts = h('dl', { class: 'facts' },
    h('div', {}, h('dt', { class: 'label' }, 'When'), h('dd', {}, day(w.startsAt)), h('dd', { class: 'mono' }, `${clock(w.startsAt)} – ${clock(end)}`)),
    h('div', {}, h('dt', { class: 'label' }, 'Organised by'), h('dd', {}, w.organizer), h('dd', { class: 'faint' }, w.office)),
    h('div', {}, h('dt', { class: 'label' }, 'Joining'), h('dd', {}, 'From your browser'), h('dd', { class: 'faint' }, w.approval === 'manual' ? 'The organiser approves each place' : 'Your link comes at once')),
  );
  const intro = h('div', { class: 'reg-intro' },
    h('p', { class: 'label' }, 'Sheet 1 · Registration'),
    h('h1', {}, w.title),
    facts,
    w.description ? h('p', { class: 'lead desc' }, w.description) : null,
  );
  if (!w.open) { frame(h('div', { class: 'step' }, intro, h('p', { class: 'problem', role: 'status' }, w.closed ?? 'Registration is closed.'))); return; }
  const problem = h('p', { class: 'problem', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Register');
  const form = h('form', { class: 'reg-form', novalidate: true },
    h('div', { class: 'wfield' }, h('label', { class: 'field-label', for: 'reg-name' }, 'Your name', h('span', { class: 'req', 'aria-hidden': 'true' }, ' *')),
      h('input', { id: 'reg-name', name: 'name', class: 'input', autocomplete: 'name', maxlength: '80', required: true })),
    h('div', { class: 'wfield' }, h('label', { class: 'field-label', for: 'reg-email' }, 'Email', h('span', { class: 'req', 'aria-hidden': 'true' }, ' *')),
      h('input', { id: 'reg-email', name: 'email', type: 'email', class: 'input', autocomplete: 'email', maxlength: '254', required: true })),
    ...w.fields.map((f) => fieldInput(f)),
    // the honeypot: off the page for people, there for form-filling robots
    h('div', { class: 'hp', 'aria-hidden': 'true' }, h('label', { for: 'reg-website' }, 'Leave this empty'), h('input', { id: 'reg-website', name: 'website', tabindex: '-1', autocomplete: 'off' })),
    problem,
    h('p', { class: 'faint small' }, 'The organiser sees your name, email and answers. Your personal link shows them you came.'),
    h('div', { class: 'actions' }, submit),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const get = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value;
    const name = get('name').trim();
    const email = get('email').trim();
    const missing = !name ? 'Enter your name.' : !/^\S+@\S+\.\S+$/.test(email) ? 'Enter your email address.' : w.fields.find((f) => f.required && !(form.elements.namedItem(f.id) as HTMLInputElement).value.trim())?.label;
    if (missing) { problem.hidden = false; problem.textContent = missing.endsWith('.') ? missing : `Answer "${missing}".`; return; }
    submit.setAttribute('disabled', '');
    void api<{ status: 'approved' | 'pending'; token?: string; name: string }>('register', { name, email, answers: readFields(form, w.fields), website: get('website') }).then((r) => {
      submit.removeAttribute('disabled');
      if (!r.ok) { problem.hidden = false; problem.textContent = r.data.error ?? 'That did not work. Try again.'; return; }
      registered(w, r.data.status, r.data.token ?? '', name);
    });
  });
  frame(h('div', { class: 'reg' }, intro, form), true);
  (form.elements.namedItem('name') as HTMLInputElement).focus();
}

function registered(w: WebinarPublic, status: 'approved' | 'pending', tok: string, name: string): void {
  const link = tok ? `${location.origin}/w/${meetingId}/watch#${tok}` : '';
  titleCells[3] = ['Sheet', 'REGISTERED', 'mono'];
  const copy = h('button', { class: 'btn', type: 'button', onclick: () => { void navigator.clipboard?.writeText(link).then(() => { copy.lastChild!.textContent = 'Copied'; }); } }, icon('copy'), h('span', {}, 'Copy the link'));
  const ics = () => {
    const file = buildIcs({
      uid: `webinar-${meetingId}@dexconnect`, title: w.title, startAt: w.startsAt, endAt: w.startsAt + w.durationMin * 60_000,
      organizer: { id: 'organiser', name: w.organizer, email: null }, office: w.office, meetingId, guestUrl: link, passcode: null, appLink: link, location: link,
      text: [w.title, `${day(w.startsAt)}, ${clock(w.startsAt)}`, '', 'Your personal link:', link].join('\n'),
    }, `${day(w.startsAt)}, ${clock(w.startsAt)}`);
    const a = h('a', { href: URL.createObjectURL(new Blob([file], { type: 'text/calendar' })), download: `${w.title.replace(/[^\w -]+/g, '').slice(0, 60) || 'webinar'}.ics` });
    document.body.append(a); a.click(); a.remove();
  };
  if (tok) try { sessionStorage.setItem(TOKEN_KEY, tok); } catch { /* private */ }
  frame(h('div', { class: 'step' },
    h('p', { class: 'label' }, status === 'approved' ? 'Registered' : 'Waiting for the organiser'),
    h('h1', {}, status === 'approved' ? `You are registered, ${name.split(' ')[0]}` : 'Thank you: your registration is with the organiser'),
    h('p', { class: 'lead' }, status === 'approved'
      ? `Open your personal link at ${clock(w.startsAt)} on ${day(w.startsAt)}. Keep it to yourself: it is yours alone.`
      : 'The organiser approves each place. Your personal link below shows whether you have one; it opens the webinar once you do.'),
    link ? h('div', { class: 'link-box' }, h('span', { class: 'label' }, 'Your personal link'), h('code', { class: 'mono reg-link' }, link)) : null,
    h('div', { class: 'actions start' }, link ? copy : null, link ? h('button', { class: 'btn', type: 'button', onclick: ics }, icon('cal'), h('span', {}, 'Add to your calendar')) : null,
      link ? h('a', { class: 'btn primary', href: `/w/${meetingId}/watch#${tok}` }, 'Open it now') : null),
  ));
}

// ------------------------------------------------------------------ watch
const st = {
  ws: null as WebSocket | null,
  self: null as { deviceId: string; name: string } | null,
  live: null as WebinarLive | null,
  questions: new Map<string, WebinarQuestion>(),
  route: 'none' as StageRoute,
  ice: [] as RTCIceServer[],
  hand: false,
  pc: null as RTCPeerConnection | null,
  pcFrom: '',
  stream: null as MediaStream | null,
  tab: 'questions' as 'questions' | 'poll' | 'handouts',
  myVotes: new Map<string, number[]>(),
  invite: '',
  ended: false,
  files: new Map<string, { name: string; mime: string; chunks: string[]; total: number }>(),
  sound: false,
};
let ping: ReturnType<typeof setInterval> | null = null;
let retries = 0;
let recheck: ReturnType<typeof setTimeout> | null = null;
let tick: ReturnType<typeof setInterval> | null = null;
const send = (f: unknown) => { if (st.ws?.readyState === WebSocket.OPEN) st.ws.send(JSON.stringify(f)); };

function watch(): void {
  if (!token) { message('Watch', 'This link is not complete', 'Open the whole link from your email: it ends with # and a code.'); return; }
  message('Watch', 'Opening the webinar', 'Connecting to the office…');
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/w/${meetingId}/ws`);
  st.ws = ws;
  ws.onmessage = (e) => { try { onFrame(JSON.parse(String(e.data)) as WebinarDown); } catch { /* not ours */ } };
  ws.onopen = () => { send({ t: 'watch', token }); ping = setInterval(() => send({ t: 'ping' }), 25_000); };
  ws.onclose = (e) => {
    if (ping) clearInterval(ping);
    if (st.ws !== ws) return;
    st.ws = null;
    closePc();
    if (st.ended) return;
    // a dropped connection (the network, the office reconnecting) comes back by itself a few times
    const transient = e.code === 1006 || e.code === 1001 || e.code === 1011 || e.code === 1012 || e.code === 4404;
    if (transient && retries < 6) {
      retries++;
      message('Watch', 'Reconnecting', 'The connection to the office dropped. Coming back…');
      setTimeout(() => { if (!st.ended) watch(); }, Math.min(15_000, 1000 * 2 ** (retries - 1)));
      return;
    }
    const again = h('button', { class: 'btn primary', type: 'button', onclick: () => { retries = 0; watch(); } }, 'Try again');
    message('Watch', e.code === 4403 || e.code === 4429 ? 'This link did not work' : 'The connection was lost', e.reason || 'The office could not be reached. Try again in a moment.', h('div', { class: 'actions' }, again));
  };
}

function onFrame(f: WebinarDown): void {
  switch (f.t) {
    case 'registration': {
      setTitle(f.title, f.startsAt);
      if (f.status === 'pending') {
        message('Waiting for the organiser', `Your place at ${f.title} is not approved yet`, 'The organiser approves each place. This page checks again every 20 seconds and opens the webinar once you have one.');
        recheck = setTimeout(() => send({ t: 'watch', token }), 20_000);
      } else {
        st.ended = true;
        message('Registration', 'The organiser could not offer you a place', `There is no place for you at ${f.title}. If you think this is a mistake, reply to the organiser's email.`);
        st.ws?.close();
      }
      return;
    }
    case 'webinar':
      retries = 0;
      if (recheck) clearTimeout(recheck);
      st.self = f.self; st.live = f.live; st.route = f.route; st.ice = f.iceServers as RTCIceServer[]; st.hand = f.hand;
      st.questions = new Map(f.questions.map((q) => [q.id, q]));
      setTitle(f.live.title, f.live.startsAt);
      // the meeting page asks for the name when this person is invited to speak
      try { localStorage.setItem('dex.guest.name', f.self.name); } catch { /* private */ }
      render();
      return;
    case 'w': onEvent(f.name, f.data); return;
    case 'file': st.files.set(f.id, { name: f.name, mime: f.mime, chunks: new Array(f.chunks), total: f.chunks }); return;
    case 'fileChunk': {
      const file = st.files.get(f.id);
      if (!file) return;
      file.chunks[f.i] = f.data;
      if (file.chunks.filter(Boolean).length === file.total) {
        st.files.delete(f.id);
        const bytes = file.chunks.map((c) => Uint8Array.from(atob(c), (x) => x.charCodeAt(0)));
        const a = h('a', { href: URL.createObjectURL(new Blob(bytes, { type: file.mime })), download: file.name });
        document.body.append(a); a.click(); a.remove();
        toast(`${file.name} is downloading`);
      }
      return;
    }
    case 'speak':
      // on stage: the meeting page, with a one-time pass in its fragment
      if (/^\/m\/\d{9}#[A-Za-z0-9]{6,10}$/.test(f.url)) {
        st.ended = true;
        try { sessionStorage.setItem(`dex.webinar.speak.${meetingId}`, '1'); } catch { /* private */ }
        location.assign(f.url);
      }
      return;
    case 'denied': st.ended = true; message('Watch', 'This link did not work', f.reason); return;
    case 'error': toast(f.message); return;
  }
}

function onEvent(name: string, data: unknown): void {
  if (name === 'web.update') {
    const u = data as WebinarUpdate;
    if (u.live) { const was = st.live?.state; st.live = u.live; if (was !== u.live.state) render(); else renderSide(); renderTop(); }
    for (const q of u.questions ?? []) st.questions.set(q.id, { ...q, own: st.questions.get(q.id)?.own, voted: st.questions.get(q.id)?.voted });
    for (const id of u.removed ?? []) st.questions.delete(id);
    if (u.questions || u.removed) renderSide();
    if (u.reactions) floatReactions(u.reactions);
  } else if (name === 'web.route') {
    const d = data as { route: StageRoute };
    st.route = d.route;
    if (d.route !== 'direct') closePc();
    renderStage();
  } else if (name === 'web.signal') {
    const d = data as { fromDevice: string; data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null } };
    void onSignal(d.fromDevice, d.data);
  } else if (name === 'web.promote') {
    st.invite = (data as { by: string }).by;
    renderInvite();
  } else if (name === 'web.ended') {
    st.ended = true;
    closePc();
    st.ws?.close();
    if (tick) clearInterval(tick);
    message('End of sheet', 'The webinar has ended', `Thank you for watching ${st.live?.title ?? 'the webinar'}. The organiser may send you the recording and a short survey.`);
  }
}

// the stage, straight from the office's PC that composes it
async function onSignal(from: string, data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null }): Promise<void> {
  if (data.description?.type === 'offer' && (st.pcFrom !== from || !st.pc)) { closePc(); openPc(from); }
  const pc = st.pc;
  if (!pc || st.pcFrom !== from) return;
  try {
    if (data.description) {
      await pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        await pc.setLocalDescription();
        send({ t: 'signal', to: from, data: { description: pc.localDescription!.toJSON() } });
      }
    } else if (data.candidate !== undefined) await pc.addIceCandidate(data.candidate ?? undefined).catch(() => {});
  } catch { /* the next offer recovers */ }
}

function openPc(from: string): void {
  const pc = new RTCPeerConnection({ iceServers: st.ice });
  st.pc = pc; st.pcFrom = from;
  pc.onicecandidate = (e) => send({ t: 'signal', to: from, data: { candidate: e.candidate ? e.candidate.toJSON() : null } });
  pc.ontrack = (e) => {
    const stream = e.streams[0] ?? new MediaStream([e.track]);
    if (st.stream !== stream) { st.stream = stream; renderStage(); renderBar(); }
  };
}

function closePc(): void {
  st.pc?.close();
  st.pc = null; st.pcFrom = ''; st.stream = null;
}

// ------------------------------------------------------------------ the watch sheets
let els: { top: HTMLElement; stage: HTMLElement; side: HTMLElement; tabs: HTMLElement; bar: HTMLElement; invite: HTMLElement; floats: HTMLElement } | null = null;

function render(): void {
  const live = st.live;
  if (!live) return;
  if (live.state === 'ended') { onEvent('web.ended', {}); return; }
  if (tick) clearInterval(tick);
  const top = h('div', { class: 'w-top' });
  const stage = h('div', { class: 'w-stage' });
  const floats = h('div', { class: 'w-floats', 'aria-hidden': 'true' });
  const tabs = h('nav', { class: 'w-tabs', role: 'tablist', 'aria-label': 'Webinar panel' });
  const side = h('div', { class: 'w-side-body', role: 'tabpanel' });
  const bar = h('div', { class: 'w-bar' });
  const invite = h('div', { class: 'w-invite-slot' });
  els = { top, stage, side, tabs, bar, invite, floats };
  titleCells[3] = ['Sheet', live.state === 'live' ? 'LIVE' : 'STARTING SOON', 'mono'];
  frame(h('div', { class: 'watch' },
    top,
    h('div', { class: 'w-grid' },
      h('div', { class: 'w-main' }, h('div', { class: 'w-stage-wrap' }, stage, floats), bar),
      h('aside', { class: 'w-side' }, tabs, side),
    ),
    invite,
  ), true);
  renderTop(); renderStage(); renderSide(); renderBar(); renderInvite();
  tick = setInterval(() => { if (st.live?.state !== 'live') renderStage(); renderTop(); }, 1000);
}

function renderTop(): void {
  const live = st.live;
  if (!els || !live) return;
  const isLive = live.state === 'live';
  const since = live.wentLiveAt ? Math.max(0, Math.floor((Date.now() - live.wentLiveAt) / 1000)) : 0;
  els.top.replaceChildren(
    h('div', { class: 'w-title' }, h('span', { class: 'label' }, isLive ? 'Webinar · live' : 'Webinar'), h('h1', {}, live.title)),
    h('div', { class: 'w-meta' },
      isLive ? h('span', { class: 'live-tag mono' }, h('i', { 'aria-hidden': 'true' }), `LIVE · ${pad(Math.floor(since / 3600))}:${pad(Math.floor(since / 60) % 60)}:${pad(since % 60)}`) : h('span', { class: 'mono soon-tag' }, live.state === 'practice' ? 'PANELISTS PREPARING' : 'NOT STARTED'),
      h('span', { class: 'mono faint' }, `${live.audience} WATCHING`),
    ),
  );
}

function renderStage(): void {
  const live = st.live;
  if (!els || !live) return;
  if (live.state !== 'live') {
    // the "starting soon" sheet: a countdown in ruled cells
    const left = Math.max(0, Math.floor((live.startsAt - Date.now()) / 1000));
    const cells: Array<[string, string]> = [['DAYS', pad(Math.floor(left / 86400))], ['HRS', pad(Math.floor(left / 3600) % 24)], ['MIN', pad(Math.floor(left / 60) % 60)], ['SEC', pad(left % 60)]];
    els.stage.replaceChildren(h('div', { class: 'soon' },
      h('p', { class: 'label' }, 'Starting soon'),
      h('div', { class: 'count', role: 'timer', 'aria-label': left ? `Starts in ${Math.floor(left / 60)} minutes` : 'Starting any moment' }, ...cells.map(([l, v]) => h('div', { class: 'count-cell' }, h('b', { class: 'mono' }, v), h('span', { class: 'mono' }, l)))),
      h('p', { class: 'soon-line' }, left ? `${live.title} starts at ${clock(live.startsAt)}.` : 'The organiser starts it any moment now.'),
      h('p', { class: 'faint small' }, live.state === 'practice' ? `${live.host} and the panelists are on the stage, getting ready. You see and hear them once they go live.` : `With ${[live.host, ...live.panelists].join(', ')}. Ask your questions now; the panelists see them.`),
    ));
    return;
  }
  if (st.route === 'full') {
    els.stage.replaceChildren(h('div', { class: 'soon full' },
      h('p', { class: 'label' }, 'The stage'),
      h('p', { class: 'soon-line' }, 'This webinar has as many viewers outside the office as it can send to.'),
      h('p', { class: 'faint small' }, 'You can still ask questions, vote and answer the poll here.'),
      live.watchUrl ? h('a', { class: 'btn primary', href: live.watchUrl, target: '_blank', rel: 'noreferrer' }, 'Watch the live stream instead') : null,
    ));
    return;
  }
  if (!st.stream) {
    els.stage.replaceChildren(h('div', { class: 'soon' }, h('p', { class: 'label' }, 'The stage'), h('span', { class: 'pulse' }), h('p', { class: 'soon-line' }, 'Connecting to the stage…')));
    return;
  }
  const v = h('video', { autoplay: true, playsinline: true, class: 'stage-video', 'aria-label': 'The stage' }) as HTMLVideoElement;
  v.srcObject = st.stream;
  // with sound when the browser allows it; otherwise muted, with a button to turn it on
  v.muted = false;
  void v.play().then(() => { st.sound = true; renderBar(); }, () => { v.muted = true; st.sound = false; void v.play().catch(() => {}); renderBar(); });
  els.stage.replaceChildren(h('figure', { class: 'stage-fig' }, v, h('figcaption', { class: 'stage-cap' }, h('b', {}, 'STAGE'), h('span', {}, 'LIVE'))));
}

function renderBar(): void {
  if (!els) return;
  const live = st.live?.state === 'live';
  const tool = (label: string, ico: string, on: boolean, f: (e: Event) => void, extra = '') => h('button', { type: 'button', class: `tool${on ? ' on' : ''}${extra}`, 'aria-pressed': String(on), onclick: f }, icon(ico), h('span', {}, label));
  const kids: Array<HTMLElement | null> = [
    live && st.stream ? tool(st.sound ? 'Sound on' : 'Sound off', st.sound ? 'sound' : 'mute', st.sound, () => {
      st.sound = !st.sound;
      const v = els?.stage.querySelector('video');
      if (v) { v.muted = !st.sound; void v.play().catch(() => {}); }
      renderBar();
    }) : null,
    tool(st.hand ? 'Hand up' : 'Raise hand', 'hand', st.hand, () => { st.hand = !st.hand; send({ t: 'hand', up: st.hand }); renderBar(); }, st.hand ? ' raised' : ''),
    h('div', { class: 'react-row', role: 'group', 'aria-label': 'React' }, ...MEETING_REACTIONS.map((e) => h('button', { type: 'button', class: 'react-btn', 'aria-label': `React ${e}`, onclick: () => send({ t: 'react', emoji: e }) }, e))),
    h('button', { type: 'button', class: 'btn ghost leave', onclick: () => { st.ended = true; send({ t: 'leave' }); closePc(); if (tick) clearInterval(tick); message('Watch', 'You left the webinar', 'Open your link again to come back.', h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => { st.ended = false; watch(); } }, 'Watch again'))); } }, icon('door'), 'Leave'),
  ];
  els.bar.replaceChildren(...kids.filter((x): x is HTMLElement => x !== null));
}

function floatReactions(r: Record<string, number>): void {
  if (!els) return;
  for (const [emoji, n] of Object.entries(r)) {
    for (let i = 0; i < Math.min(n, 5); i++) {
      const el = h('span', { class: 'float', style: `--x:${10 + Math.random() * 80}%;--d:${i * 120}ms` }, emoji);
      els.floats.append(el);
      setTimeout(() => el.remove(), 2400 + i * 120);
    }
  }
}

function renderSide(): void {
  if (!els || !st.live) return;
  const poll = st.live.poll;
  const tabs: Array<[typeof st.tab, string, string]> = [['questions', 'Questions', String([...st.questions.values()].length)], ['poll', 'Poll', poll?.open ? 'OPEN' : poll ? '1' : '—'], ['handouts', 'Handouts', String(st.live.handouts.length)]];
  els.tabs.replaceChildren(...tabs.map(([id, label, n]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(st.tab === id), class: poll?.open && id === 'poll' && st.tab !== 'poll' ? 'attn' : '', onclick: () => { st.tab = id; renderSide(); } }, label, h('span', { class: 'mono' }, n))));
  if (st.tab === 'questions') els.side.replaceChildren(questionsTab());
  else if (st.tab === 'poll') els.side.replaceChildren(pollTab(poll));
  else els.side.replaceChildren(handoutsTab(st.live.handouts));
}

function questionsTab(): HTMLElement {
  const box = h('textarea', { class: 'input', rows: '2', maxlength: '500', placeholder: 'Ask the panelists', 'aria-label': 'Your question' }) as HTMLTextAreaElement;
  const anon = h('input', { type: 'checkbox', id: 'ask-anon' }) as HTMLInputElement;
  const ask = h('form', { class: 'ask', onsubmit: (e: Event) => { e.preventDefault(); const t = box.value.trim(); if (!t) return; send({ t: 'ask', text: t, anonymous: anon.checked }); box.value = ''; toast('Your question is with the panelists'); } },
    box,
    h('div', { class: 'ask-foot' },
      st.live?.anonymousQuestions ? h('label', { class: 'check', for: 'ask-anon' }, anon, 'Without my name') : h('span', { class: 'faint small' }, 'Asked with your name'),
      h('button', { class: 'btn primary sm', type: 'submit' }, 'Ask')),
  );
  const list = [...st.questions.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.votes - a.votes || a.at - b.at);
  return h('div', { class: 'qa' }, ask,
    list.length ? h('ol', { class: 'q-list' }, ...list.map((q) => h('li', { class: `q${q.pinned ? ' pinned' : ''}${q.onStage ? ' staged' : ''}` },
      h('button', { type: 'button', class: `vote${q.voted ? ' on' : ''}`, 'aria-pressed': String(!!q.voted), 'aria-label': `${q.voted ? 'Take back your vote for' : 'Vote for'}: ${q.text}`, onclick: () => {
        const up = !q.voted;
        st.questions.set(q.id, { ...q, voted: up, votes: q.votes + (up ? 1 : -1) });
        send({ t: 'vote', questionId: q.id, up });
        renderSide();
      } }, icon('up', 14), h('span', { class: 'mono' }, String(q.votes))),
      h('div', { class: 'q-body' },
        h('p', {}, q.text),
        h('p', { class: 'q-meta mono' }, [q.anonymous ? 'ANONYMOUS' : capName(q.author || '?'), clock(q.at), q.pinned ? 'PINNED' : '', q.onStage ? 'ON STAGE' : ''].filter(Boolean).join(' · ')),
        q.status === 'live' ? h('p', { class: 'q-answer mono' }, 'ANSWERED LIVE') : null,
        q.status === 'answered' && q.answer ? h('p', { class: 'q-answer' }, h('b', { class: 'mono' }, `${capName(q.answer.by)} · `), q.answer.text) : null,
      ),
    ))) : h('p', { class: 'empty' }, 'No questions yet. Ask the first.'),
  );
}

function pollTab(poll: WebinarPoll | null): HTMLElement {
  if (!poll) return h('p', { class: 'empty' }, 'No poll right now. When the organiser asks one, it shows here.');
  const mine = st.myVotes.get(poll.id) ?? poll.mine;
  const chosen = new Set<number>(mine);
  const total = poll.results ? poll.results.reduce((a, b) => a + b, 0) : 0;
  const form = h('form', { class: 'poll', onsubmit: (e: Event) => { e.preventDefault(); if (!chosen.size) return; st.myVotes.set(poll.id, [...chosen]); send({ t: 'pollVote', pollId: poll.id, choices: [...chosen] }); toast('Your answer is in'); renderSide(); } },
    h('p', { class: 'label' }, poll.open ? 'Poll · open' : 'Poll · closed'),
    h('h2', {}, poll.question),
    ...poll.options.map((o, i) => {
      const id = `opt-${i}`;
      const input = h('input', { type: poll.multi ? 'checkbox' : 'radio', name: 'opt', id, checked: chosen.has(i) || undefined, disabled: !poll.open || undefined, onchange: (e: Event) => { const c = (e.target as HTMLInputElement).checked; if (!poll.multi) chosen.clear(); if (c) chosen.add(i); else chosen.delete(i); } });
      const share = poll.results && total ? Math.round((poll.results[i] / total) * 100) : null;
      return h('label', { class: 'opt', for: id }, input, h('span', { class: 'opt-text' }, o), share !== null ? h('span', { class: 'opt-bar', style: `--w:${share}%` }) : null, share !== null ? h('b', { class: 'mono' }, `${share}%`) : null);
    }),
    h('div', { class: 'ask-foot' }, h('span', { class: 'faint small' }, poll.results ? `${poll.voters} answered` : mine.length ? 'Your answer is in. Change it while the poll is open.' : poll.multi ? 'Choose any that apply.' : 'Choose one.'),
      poll.open ? h('button', { class: 'btn primary sm', type: 'submit' }, mine.length ? 'Change answer' : 'Answer') : null),
  );
  return form;
}

function handoutsTab(list: Handout[]): HTMLElement {
  if (!list.length) return h('p', { class: 'empty' }, 'No handouts yet. Files the organiser shares for the webinar show here.');
  return h('ul', { class: 'handouts' }, ...list.map((f) => h('li', {},
    icon('file'), h('span', { class: 'h-name' }, f.name, h('span', { class: 'mono faint' }, sizeText(f.size))),
    h('button', { type: 'button', class: 'btn sm', onclick: () => { send({ t: 'handout', id: f.id }); toast(`Getting ${f.name}…`); } }, icon('down', 15), 'Download'),
  )));
}

function renderInvite(): void {
  if (!els) return;
  if (!st.invite) { els.invite.replaceChildren(); return; }
  els.invite.replaceChildren(h('div', { class: 'invite', role: 'alertdialog', 'aria-label': 'Invited to speak' },
    h('p', { class: 'label' }, 'Invitation to speak'),
    h('h2', {}, `${st.invite} invites you onto the stage`),
    h('p', { class: 'faint small' }, 'Everyone watching will see and hear you. Your camera and microphone are checked first; you go back to the audience when the organiser says.'),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => { st.invite = ''; send({ t: 'speak', accept: false }); renderInvite(); } }, 'Not now'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => { st.invite = ''; send({ t: 'speak', accept: true }); renderInvite(); } }, 'Go on stage')),
  ));
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(text: string): void {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(el);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3200);
}

// ------------------------------------------------------------------ survey
async function survey(): Promise<void> {
  if (!token) { message('Survey', 'This link is not complete', 'Open the whole link from your email: it ends with # and a code.'); return; }
  message('Survey', 'Loading the survey', 'One moment.');
  const r = await api<{ title: string; name: string; fields: WebinarField[]; answered: boolean }>('survey-info', { token });
  if (!r.ok) { message('Survey', 'This survey is not available', r.data.error ?? 'Try again later.'); return; }
  titleCells = [['Webinar', r.data.title, 'wide'], ['ID', displayId, 'mono'], ['For', r.data.name], titleCells[3]];
  if (r.data.answered) { message('Survey', 'Thank you', 'You answered this survey already.'); return; }
  const problem = h('p', { class: 'problem', role: 'alert', hidden: true });
  const form = h('form', { class: 'reg-form', novalidate: true },
    ...r.data.fields.map((f) => fieldInput(f)),
    problem,
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Send answers')),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const missing = r.data.fields.find((f) => f.required && !(form.elements.namedItem(f.id) as HTMLInputElement).value.trim());
    if (missing) { problem.hidden = false; problem.textContent = `Answer "${missing.label}".`; return; }
    void api<{ ok: true }>('answers', { token, answers: readFields(form, r.data.fields) }).then((res) => {
      if (!res.ok) { problem.hidden = false; problem.textContent = res.data.error ?? 'That did not work. Try again.'; return; }
      message('Survey', `Thank you, ${r.data.name.split(' ')[0]}`, 'Your answers are with the organiser.');
    });
  });
  frame(h('div', { class: 'step' }, h('p', { class: 'label' }, 'Follow-up survey'), h('h1', {}, r.data.title), h('p', { class: 'lead' }, 'A few questions from the organiser. It takes two minutes.'), form));
}

if (mode === 'watch') watch(); else if (mode === 'survey') void survey(); else void register();
