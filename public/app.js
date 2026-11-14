// Lattice client — vanilla ES modules, no build step, no external assets.
const state = {
  me: null,
  workspace: 'Office',
  version: '',
  channels: [],
  discoverable: [],
  users: [],
  online: new Set(),
  current: null,
  messages: [],
  hasMore: false,
  oldestCursor: null,
  loadingOlder: false,
  replyTo: null,
  attachment: null,
  typingSent: 0,
  typingUsers: new Map(),
  es: null,
  thread: null,
  prefs: {
    sound: localStorage.getItem('lattice-sound') !== 'off',
    notify: localStorage.getItem('lattice-notify') === 'on',
  },
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const timeOf = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayOf = (ts) => new Date(ts).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
const shortDay = (ts) => new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' });
const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const otherMember = (ch) => (ch.kind === 'dm' ? ch.members.find((m) => m.id !== state.me?.id) : null);
const chanName = (ch) => (ch.kind === 'dm' ? (otherMember(ch)?.name || 'Direct message') : ch.name);

let token = localStorage.getItem('lattice-token') || null;

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify(options.json);
  }
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    localStorage.removeItem('lattice-token');
    token = null;
    showJoin();
    throw new Error('Please sign in again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

// ------------------------------------------------------------------ toasts
function toast(message, kind = 'error') {
  const box = $('toasts');
  const node = el('div', `toast ${kind}`, message);
  box.append(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 300);
  }, kind === 'error' ? 5200 : 3200);
}
const warn = (err) => toast(err?.message || String(err));

// -------------------------------------------------------------------- join
function showJoin() {
  $('app').hidden = true;
  $('join').hidden = false;
}

async function detectServer() {
  try {
    const info = await api('/api/health');
    state.workspace = info.workspace;
    state.version = info.version;
    $('join-note').textContent = `Connected to ${info.workspace} · ${info.users} ${info.users === 1 ? 'person' : 'people'} · no internet needed`;
    $('workspace-name').textContent = info.workspace;
    $('name-input').focus();
  } catch {
    $('join-note').textContent = 'Cannot reach the Lattice server. Check that it is running.';
  }
}

async function doJoin(name, device) {
  const data = await api('/api/join', { method: 'POST', json: { name, device } });
  token = data.token;
  localStorage.setItem('lattice-token', token);
  $('join').hidden = true;
  $('app').hidden = false;
  await boot();
}

async function boot() {
  const data = await api('/api/bootstrap');
  state.me = data.me;
  state.workspace = data.workspace;
  state.version = data.version;
  state.channels = data.channels;
  state.discoverable = data.discoverable || [];
  state.users = data.users;
  state.online = new Set(data.online);
  $('workspace-name').textContent = state.workspace;
  $('me-initials').textContent = initials(state.me.name);
  $('me-avatar').style.setProperty('--hue', state.me.hue);
  renderSidebar();
  connectEvents();

  const wanted = hashTarget();
  const target = wanted
    ? state.channels.find((c) => c.id === wanted.channelId)
    : state.channels.find((c) => c.unread > 0) || state.channels[0];
  if (target) await openChannel(target.id);
  else renderMessages();
}

const hashTarget = () => {
  const m = location.hash.match(/^#([0-9a-f-]{36})(?:\/([0-9a-f-]{36}))?$/i);
  return m ? { channelId: m[1], messageId: m[2] } : null;
};

// ----------------------------------------------------------------- realtime
function setConn(ok, label) {
  $('conn-dot').className = 'dot' + (ok ? ' ok' : '');
  $('conn-label').textContent = label;
  const banner = $('banner');
  if (ok) { banner.hidden = true; return; }
  banner.hidden = false;
  banner.textContent = 'Reconnecting to the office server… messages you send will not send until it is back.';
}

function connectEvents() {
  if (state.es) state.es.close();
  const es = new EventSource(token ? `/api/events?t=${token}` : '/api/events');
  state.es = es;

  es.addEventListener('ready', (e) => {
    setConn(true, 'on the office network');
    state.online = new Set(JSON.parse(e.data).online);
    renderSidebar();
    if (state.current) refreshCurrent(false);
  });
  es.addEventListener('presence', (e) => {
    state.online = new Set(JSON.parse(e.data).users);
    renderSidebar();
    renderMessages();
    if (state.thread) renderThread();
  });
  es.addEventListener('message', (e) => {
    const { message } = JSON.parse(e.data);
    if (state.thread && message.channelId === state.thread.root.channelId && (message.replyTo === state.thread.root.id || message.id === state.thread.root.id)) {
      if (message.replyTo === state.thread.root.id) state.thread.replies.push(message);
      renderThread();
    }
    if (state.current && message.channelId === state.current.id) {
      const known = state.messages.some((m) => m.id === message.id);
      if (!known) state.messages.push(message);
      renderMessages(true);
      markRead();
      if (message.author.id !== state.me.id) announce(message);
    } else {
      const ch = state.channels.find((c) => c.id === message.channelId);
      if (ch) {
        ch.unread = (ch.unread || 0) + 1;
        ch.preview = message.body;
        ch.lastMessageAt = message.createdAt;
        renderSidebar();
        if (message.author.id !== state.me.id) announce(message, ch);
      }
    }
  });
  es.addEventListener('message-update', (e) => {
    const { message } = JSON.parse(e.data);
    const idx = state.messages.findIndex((m) => m.id === message.id);
    if (idx >= 0) state.messages[idx] = message;
    renderMessages();
    if (state.thread) {
      if (message.id === state.thread.root.id) state.thread.root = message;
      const ti = state.thread.replies.findIndex((m) => m.id === message.id);
      if (ti >= 0) state.thread.replies[ti] = message;
      renderThread();
    }
  });
  es.addEventListener('channel', (e) => {
    const { channel } = JSON.parse(e.data);
    const idx = state.channels.findIndex((c) => c.id === channel.id);
    if (idx >= 0) state.channels[idx] = channel;
    else state.channels.unshift(channel);
    renderSidebar();
  });
  es.addEventListener('channel-removed', (e) => {
    const { channelId } = JSON.parse(e.data);
    state.channels = state.channels.filter((c) => c.id !== channelId);
    if (state.current && state.current.id === channelId) {
      state.current = null;
      state.messages = [];
      $('conv-name').textContent = 'Select a conversation';
      $('conv-meta').textContent = '';
      renderMessages();
    }
    renderSidebar();
  });
  es.addEventListener('user-update', (e) => {
    const { user } = JSON.parse(e.data);
    const idx = state.users.findIndex((u) => u.id === user.id);
    if (idx >= 0) state.users[idx] = user;
    else state.users.push(user);
    if (state.me && user.id === state.me.id) state.me = user;
    state.channels.forEach((c) => {
      const mi = c.members.findIndex((m) => m.id === user.id);
      if (mi >= 0) c.members[mi] = user;
    });
    renderSidebar();
    renderMessages();
  });
  es.addEventListener('typing', (e) => {
    const { channelId, user } = JSON.parse(e.data);
    if (!state.current || channelId !== state.current.id) return;
    state.typingUsers.set(user.id, { name: user.name, at: Date.now() });
    renderTyping();
  });
  es.onerror = () => setConn(false, 'reconnecting');
}

let audioCtx = null;
function ping() {
  if (!state.prefs.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = 660;
    g.gain.value = 0.035;
    o.connect(g).connect(audioCtx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.18);
    o.stop(audioCtx.currentTime + 0.2);
  } catch { /* audio is optional */ }
}

function announce(message, ch) {
  ping();
  const hidden = document.hidden;
  if (!hidden || !state.prefs.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const body = message.body || (message.file ? `Sent ${message.file.name}` : 'New message');
    new Notification(`${message.author.name}${ch ? ` · #${ch.name}` : ''}`, { body: body.slice(0, 140), tag: message.channelId });
  } catch { /* notifications are optional */ }
}

// ---------------------------------------------------------------- sidebar
function renderSidebar() {
  const channels = state.channels.filter((c) => c.kind !== 'dm');
  const dms = state.channels.filter((c) => c.kind === 'dm');

  const fill = (ul, list, isDm) => {
    ul.innerHTML = '';
    for (const ch of list) {
      const li = el('li');
      const active = state.current && state.current.id === ch.id;
      const btn = el('button', 'chan' + (active ? ' active' : ''));
      btn.setAttribute('aria-current', active ? 'true' : 'false');
      const other = otherMember(ch);
      btn.append(makeAvatar(other ? other.name : `#${chanName(ch)}`, other ? other.hue : null));
      btn.append(el('span', 'chan-name', (isDm ? '' : '#') + chanName(ch)));
      if (ch.unread) {
        const badge = el('span', 'badge', ch.unread > 99 ? '99+' : String(ch.unread));
        badge.setAttribute('aria-label', `${ch.unread} unread`);
        btn.append(badge);
      }
      btn.onclick = () => openChannel(ch.id);
      li.append(btn);
      ul.append(li);
    }
    if (!list.length) ul.append(el('li', 'empty-row', isDm ? 'No direct messages yet.' : 'No channels yet.'));
  };
  fill($('channel-list'), channels, false);
  fill($('dm-list'), dms, true);

  const people = $('people-list');
  people.innerHTML = '';
  const sorted = [...state.users].sort((a, b) => Number(state.online.has(b.id)) - Number(state.online.has(a.id)) || a.name.localeCompare(b.name));
  const nameCounts = new Map();
  for (const u of sorted) nameCounts.set(u.name, (nameCounts.get(u.name) || 0) + 1);
  for (const u of sorted) {
    const li = el('li');
    const btn = el('button', 'person');
    const online = state.online.has(u.id);
    const status = el('span', 'status' + (online ? ' on' : ''));
    status.title = online ? 'Online' : 'Away';
    btn.append(status);
    btn.append(makeAvatar(u.name, u.hue));
    btn.append(el('span', 'person-name', u.id === state.me.id ? `${u.name} (you)` : u.name));
    if (nameCounts.get(u.name) > 1 && u.device) btn.append(el('span', 'person-device', u.device));
    if (u.role === 'admin') btn.append(el('span', 'role-tag', 'admin'));
    btn.onclick = () => startDm(u.id);
    li.append(btn);
    people.append(li);
  }
}

function makeAvatar(name, hue) {
  const a = el('span', 'avatar' + (hue === null || hue === undefined ? ' chan-avatar' : ''), hue === null || hue === undefined ? '#' : initials(name));
  if (hue !== null && hue !== undefined) a.style.setProperty('--hue', hue);
  return a;
}

async function startDm(userId) {
  try {
    const { channel } = await api('/api/channels', { method: 'POST', json: { kind: 'dm', memberIds: [userId] } });
    if (!state.channels.some((c) => c.id === channel.id)) state.channels.unshift(channel);
    renderSidebar();
    await openChannel(channel.id);
  } catch (err) { warn(err); }
}

// ------------------------------------------------------------- conversation
function skeleton() {
  const box = $('messages');
  box.innerHTML = '';
  for (let i = 0; i < 5; i += 1) {
    const row = el('div', 'skel-row');
    row.append(el('span', 'skel skel-avatar'), el('span', 'skel skel-line'));
    box.append(row);
  }
}

async function openChannel(id) {
  const ch = state.channels.find((c) => c.id === id);
  if (!ch) return;
  state.current = ch;
  state.replyTo = null;
  state.messages = [];
  state.oldestCursor = null;
  state.hasMore = false;
  $('reply-banner').hidden = true;
  closeThread();
  skeleton();

  try {
    const page = await api(`/api/channels/${id}/messages?limit=60`);
    if (!state.current || state.current.id !== id) return;
    state.messages = page.messages;
    state.hasMore = page.hasMore;
    state.oldestCursor = page.oldestCursor;
    $('messages').dataset.unread = String(ch.unread || 0);
    ch.unread = 0;
    updateHeader();
    renderSidebar();
    renderMessages(false, true);
    markRead();
    history.replaceState(null, '', `#${id}`);
    $('input').focus();
  } catch (err) {
    warn(err);
  }
}

function updateHeader() {
  const ch = state.current;
  if (!ch) return;
  const other = otherMember(ch);
  $('conv-name').textContent = ch.kind === 'dm' ? other?.name || 'Direct message' : `#${ch.name}`;
  if (ch.kind === 'dm') {
    $('conv-meta').textContent = other && state.online.has(other.id) ? 'Online now' : 'Away';
  } else {
    const names = ch.members.filter((m) => m.id !== state.me.id).map((m) => m.name);
    $('conv-meta').textContent = [
      `${ch.members.length} member${ch.members.length === 1 ? '' : 's'}`,
      ch.topic,
      names.length && ch.members.length <= 6 ? names.join(', ') : '',
    ].filter(Boolean).join(' · ');
  }
  $('input').placeholder = `Message ${ch.kind === 'dm' ? chanName(ch) : `#${ch.name}`}`;
}

async function refreshCurrent(rerender = true) {
  if (!state.current) return;
  try {
    const page = await api(`/api/channels/${state.current.id}/messages?limit=60`);
    state.messages = page.messages;
    state.hasMore = page.hasMore;
    state.oldestCursor = page.oldestCursor;
    if (rerender) renderMessages();
  } catch { /* server may be restarting */ }
}

function renderTyping() {
  const cutoff = Date.now() - 6000;
  for (const [id, v] of state.typingUsers) if (v.at < cutoff) state.typingUsers.delete(id);
  const names = [...state.typingUsers.values()].map((v) => v.name);
  const box = $('typing');
  if (!names.length) { box.hidden = true; return; }
  box.hidden = false;
  box.textContent = names.length === 1 ? `${names[0]} is typing…` : `${names.length} people are typing…`;
}

function renderMessages(append = false, jumpToBottom = false) {
  const box = $('messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  const previousHeight = box.scrollHeight;
  box.innerHTML = '';

  if (!state.current) {
    const intro = el('div', 'empty-conv');
    intro.append(el('p', 'empty-title', 'Pick a conversation'));
    intro.append(el('p', 'empty-body', 'Channels and direct messages appear on the left. Press Ctrl+K to search everything.'));
    box.append(intro);
    return;
  }

  if (!state.messages.length) {
    const empty = el('div', 'empty-conv');
    empty.append(el('p', 'empty-title', state.current.kind === 'dm' ? 'This is the start' : `Nothing in #${state.current.name} yet`));
    empty.append(el('p', 'empty-body', state.current.kind === 'dm'
      ? `Say hello to ${chanName(state.current)}. Messages stay on the office network.`
      : 'Send the first message. Everyone in the channel will see it.'));
    box.append(empty);
    return;
  }

  const unread = Number(box.dataset.unread || 0);
  const dividerAt = unread > 0 ? Math.max(0, state.messages.length - unread) : -1;

  let lastDay = null;
  let lastAuthor = null;
  let lastAt = 0;

  state.messages.forEach((m, index) => {
    if (index === dividerAt && dividerAt > 0) box.append(el('div', 'unread-rule', 'New messages'));

    const day = dayOf(m.createdAt);
    if (day !== lastDay) {
      box.append(el('div', 'day', day));
      lastDay = day;
      lastAuthor = null;
    }

    const grouped = m.author.id === lastAuthor && m.createdAt - lastAt < 5 * 60 * 1000;
    const row = el('article', `msg${grouped ? ' grouped' : ''}${m.deleted ? ' deleted' : ''}`);
    row.id = `m-${m.id}`;
    row.append(grouped ? el('span', 'gutter') : makeAvatar(m.author.name, m.author.hue));

    const main = el('div', 'msg-main');
    if (!grouped) {
      const head = el('div', 'msg-head');
      head.append(el('span', 'msg-author', m.author.name));
      if (state.online.has(m.author.id)) head.append(el('span', 'online-pip'));
      head.append(el('time', 'msg-time', timeOf(m.createdAt)));
      main.append(head);
    }

    if (m.forwardedFrom) {
      const from = state.users.find((u) => u.id === m.forwardedFrom);
      main.append(el('div', 'forwarded', `Forwarded from ${from ? from.name : 'someone'}`));
    }

    if (m.replyTo) {
      const ref = state.messages.find((x) => x.id === m.replyTo);
      if (ref) {
        const q = el('button', 'quote');
        q.type = 'button';
        q.append(el('b', null, ref.author.name));
        q.append(document.createTextNode(' ' + (ref.body || 'attachment')));
        q.onclick = () => revealMessage(ref.id);
        main.append(q);
      }
    }

    const body = el('div', 'msg-body');
    if (m.deleted) body.append(el('em', 'muted', 'Message removed'));
    else body.innerHTML = linkify(esc(m.body));
    if (m.editedAt) body.append(el('span', 'edited', ' (edited)'));
    if (m.pinned) body.append(el('span', 'pin-tag', 'Pinned'));
    main.append(body);

    if (m.file) {
      if (m.file.inline) {
        const wrap = el('a', 'image-link');
        wrap.href = `/api/files/${m.file.id}`;
        wrap.target = '_blank';
        wrap.rel = 'noreferrer noopener';
        const img = el('img', 'image-preview');
        img.src = `/api/files/${m.file.id}?inline=1`;
        img.alt = m.file.name;
        img.loading = 'lazy';
        wrap.append(img);
        wrap.append(el('span', 'image-meta', `${m.file.name} · ${bytes(m.file.size)}`));
        main.append(wrap);
      } else {
        const f = el('a', 'file');
        f.href = `/api/files/${m.file.id}`;
        f.setAttribute('download', m.file.name);
        f.append(el('span', 'file-name', m.file.name), el('span', 'file-size', bytes(m.file.size)));
        main.append(f);
      }
    }

    if (m.reactions.length) {
      const bar = el('div', 'reactions');
      const counts = new Map();
      for (const r of m.reactions) {
        const c = counts.get(r.emoji) || { n: 0, mine: false };
        c.n += 1;
        if (r.user_id === state.me.id) c.mine = true;
        counts.set(r.emoji, c);
      }
      for (const [emoji, c] of counts) {
        const b = el('button', 'reaction' + (c.mine ? ' mine' : ''), `${emoji} ${c.n}`);
        b.onclick = () => api(`/api/messages/${m.id}/reactions`, { method: 'POST', json: { emoji } }).catch(warn);
        bar.append(b);
      }
      main.append(bar);
    }

    if (m.replyCount > 0) {
      const t = el('button', 'thread-link', `${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}`);
      t.onclick = () => openThread(m);
      main.append(t);
    }

    const tools = el('div', 'msg-tools');
    const tool = (label, title, fn) => {
      const b = el('button', null, label);
      b.title = title;
      b.type = 'button';
      b.onclick = fn;
      tools.append(b);
      return b;
    };
    for (const [emoji, title] of [['👍', 'Thumbs up'], ['✅', 'Done'], ['👀', 'Seen']]) {
      tool(emoji, title, () => api(`/api/messages/${m.id}/reactions`, { method: 'POST', json: { emoji } }).catch(warn));
    }
    tool('Reply', 'Reply in channel', () => beginReply(m));
    tool('Thread', 'Open thread', () => openThread(m));
    tool(m.pinned ? 'Unpin' : 'Pin', m.pinned ? 'Unpin message' : 'Pin message', () => api(`/api/messages/${m.id}/pin`, { method: 'POST', json: {} }).catch(warn));
    tool('Forward', 'Forward to another conversation', () => openForward(m));
    tool('Copy', 'Copy a link to this message', async () => {
      try {
        await navigator.clipboard.writeText(`${location.origin}/#${m.channelId}/${m.id}`);
        toast('Link copied.', 'ok');
      } catch { warn(new Error('Could not copy the link.')); }
    });
    if (m.author.id === state.me.id && !m.deleted) {
      tool('Edit', 'Edit message', async () => {
        const next = prompt('Edit message', m.body);
        if (next === null) return;
        await api(`/api/messages/${m.id}/edit`, { method: 'POST', json: { body: next } }).catch(warn);
      });
    }
    if ((m.author.id === state.me.id || state.me.role === 'admin') && !m.deleted) {
      tool('Delete', 'Delete message', async () => {
        if (!confirm('Delete this message for everyone?')) return;
        await api(`/api/messages/${m.id}/delete`, { method: 'POST', json: {} }).catch(warn);
      });
    }
    row.append(main, tools);
    box.append(row);
    lastAuthor = m.author.id;
    lastAt = m.createdAt;
  });

  const pins = state.messages.filter((m) => m.pinned).length;
  $('pin-count').textContent = String(pins);

  if (jumpToBottom) box.scrollTop = box.scrollHeight;
  else if (atBottom) box.scrollTop = box.scrollHeight;
  else if (append) box.scrollTop = previousHeight - box.clientHeight + 90;
  else box.scrollTop = box.scrollHeight;
}

function linkify(text) {
  return text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer noopener">$1</a>');
}

function revealMessage(id) {
  const node = document.getElementById(`m-${id}`);
  if (!node) return toast('That message is further up — scroll to load older ones.', 'info');
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 1400);
}

function beginReply(m) {
  state.replyTo = m;
  $('reply-name').textContent = m.author.name;
  $('reply-banner').hidden = false;
  $('input').focus();
}

function markRead() {
  if (!state.current || !state.messages.length) return;
  api('/api/read', { method: 'POST', json: { channelId: state.current.id, messageId: state.messages.at(-1).id } }).catch(() => {});
}

// -------------------------------------------------------------- older pages
$('messages').addEventListener('scroll', async () => {
  const box = $('messages');
  if (box.scrollTop > 60 || !state.hasMore || state.loadingOlder || !state.current) return;
  state.loadingOlder = true;
  const before = box.scrollHeight;
  try {
    const page = await api(`/api/channels/${state.current.id}/messages?limit=60&before=${state.oldestCursor}`);
    state.messages = [...page.messages, ...state.messages];
    state.hasMore = page.hasMore;
    state.oldestCursor = page.oldestCursor;
    renderMessages();
    box.scrollTop = box.scrollHeight - before;
  } catch (err) {
    warn(err);
  } finally {
    state.loadingOlder = false;
  }
});

// ------------------------------------------------------------------ threads
async function openThread(m) {
  try {
    const data = await api(`/api/messages/${m.id}/thread`);
    state.thread = { root: data.root, replies: data.replies };
    $('threads').hidden = false;
    $('thread-sub').textContent = `in #${chanName(state.channels.find((c) => c.id === data.root.channelId) || { kind: 'channel', name: '' })}`;
    renderThread();
    $('thread-input').focus();
  } catch (err) { warn(err); }
}

function closeThread() {
  state.thread = null;
  $('threads').hidden = true;
  $('thread-body').innerHTML = '';
}

function renderThread() {
  if (!state.thread) return;
  const body = $('thread-body');
  body.innerHTML = '';
  for (const m of [state.thread.root, ...state.thread.replies]) {
    const row = el('article', 'msg thread-msg');
    row.append(makeAvatar(m.author.name, m.author.hue));
    const main = el('div', 'msg-main');
    const head = el('div', 'msg-head');
    head.append(el('span', 'msg-author', m.author.name), el('time', 'msg-time', `${shortDay(m.createdAt)} ${timeOf(m.createdAt)}`));
    main.append(head);
    const b = el('div', 'msg-body');
    b.innerHTML = m.deleted ? '<em class="muted">Message removed</em>' : linkify(esc(m.body));
    main.append(b);
    if (m.file) {
      const f = el('a', 'file');
      f.href = `/api/files/${m.file.id}`;
      f.append(el('span', 'file-name', m.file.name), el('span', 'file-size', bytes(m.file.size)));
      main.append(f);
    }
    row.append(main);
    body.append(row);
  }
  body.scrollTop = body.scrollHeight;
}

$('thread-close').onclick = closeThread;
$('thread-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('thread-input').value.trim();
  if (!text || !state.thread) return;
  $('thread-input').value = '';
  try {
    const { message } = await api(`/api/channels/${state.thread.root.channelId}/messages`, {
      method: 'POST', json: { body: text, replyTo: state.thread.root.id },
    });
    state.thread.replies.push(message);
    renderThread();
  } catch (err) { warn(err); }
});

// ---------------------------------------------------------------- composer
const input = $('input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  if (!state.current) return;
  const now = Date.now();
  if (now - state.typingSent > 2500) {
    state.typingSent = now;
    api('/api/typing', { method: 'POST', json: { channelId: state.current.id } }).catch(() => {});
  }
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
  if (e.key === 'Escape' && state.replyTo) {
    state.replyTo = null;
    $('reply-banner').hidden = true;
  }
});

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.current) return;
  const body = input.value.trim();
  if (!body && !state.attachment) return;
  const payload = { body, replyTo: state.replyTo?.id ?? null, fileId: state.attachment?.id ?? null };
  input.value = '';
  input.style.height = 'auto';
  state.replyTo = null;
  $('reply-banner').hidden = true;
  try {
    await api(`/api/channels/${state.current.id}/messages`, { method: 'POST', json: payload });
  } catch (err) {
    input.value = body;
    warn(err);
  }
});

$('reply-cancel').onclick = () => {
  state.replyTo = null;
  $('reply-banner').hidden = true;
};

function clearAttachment() {
  state.attachment = null;
  $('attach-banner').hidden = true;
  $('file-input').value = '';
}
$('btn-attach').onclick = () => $('file-input').click();
$('attach-cancel').onclick = clearAttachment;

function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) $('attach-progress').textContent = `${Math.round((ev.loaded / ev.total) * 100)}%`;
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data.file);
        else reject(new Error(data.error || 'Upload failed.'));
      } catch { reject(new Error('Upload failed.')); }
    };
    xhr.onerror = () => reject(new Error('Upload failed — is the server still running?'));
    xhr.send(file);
  });
}

async function sendFiles(files) {
  if (!state.current || !files.length) return;
  $('attach-banner').hidden = false;
  for (const file of files) {
    $('attach-name').textContent = file.name;
    $('attach-progress').textContent = '0%';
    try {
      const uploaded = await uploadFile(file);
      await api(`/api/channels/${state.current.id}/messages`, { method: 'POST', json: { body: '', fileId: uploaded.id } });
      toast(`Sent ${file.name}`, 'ok');
    } catch (err) { warn(err); }
  }
  clearAttachment();
}

$('file-input').addEventListener('change', (e) => sendFiles([...e.target.files]));

const conv = $('conversation');
conv.addEventListener('dragover', (e) => { e.preventDefault(); conv.classList.add('dragging'); });
conv.addEventListener('dragleave', () => conv.classList.remove('dragging'));
conv.addEventListener('drop', (e) => {
  e.preventDefault();
  conv.classList.remove('dragging');
  if (e.dataTransfer.files.length) sendFiles([...e.dataTransfer.files]);
});
window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length && state.current) {
    e.preventDefault();
    sendFiles(files);
  }
});

// ------------------------------------------------------------------- sheets
function openSheet(title, build) {
  $('sheet-title').textContent = title;
  const body = $('sheet-body');
  body.innerHTML = '';
  build(body);
  $('sheet').hidden = false;
  const first = body.querySelector('input');
  if (first) first.focus();
}
function closeSheet() { $('sheet').hidden = true; }
$('sheet-close').onclick = closeSheet;
$('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openSearch();
  }
  if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const list = state.channels;
    if (!list.length) return;
    const i = state.current ? list.findIndex((c) => c.id === state.current.id) : -1;
    const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
    openChannel(list[next].id);
  }
});

function openSearch() {
  openSheet('Search', (body) => {
    const field = el('input');
    field.className = 'sheet-input';
    field.placeholder = 'Search every conversation…';
    const scopeRow = el('label', 'check-row');
    const scopeBox = el('input');
    scopeBox.type = 'checkbox';
    scopeRow.append(scopeBox, document.createTextNode('Only this conversation'));
    const results = el('div', 'results');
    body.append(field, scopeRow, results);
    let timer = null;
    const run = async () => {
      const q = field.value.trim();
      if (!q) { results.innerHTML = ''; return; }
      const scope = scopeBox.checked && state.current ? `&channel=${state.current.id}` : '';
      try {
        const data = await api(`/api/search?q=${encodeURIComponent(q)}${scope}`);
        results.innerHTML = '';
        if (!data.results.length) {
          results.append(el('p', 'empty-body', `No messages match “${q}”.`));
          return;
        }
        for (const r of data.results) {
          const row = el('button', 'result');
          row.append(el('span', 'result-where', (r.channel.kind === 'dm' ? '' : '#') + chanName(r.channel)));
          row.append(el('span', 'result-body', r.body.slice(0, 140) || 'attachment'));
          row.append(el('span', 'result-when', shortDay(r.createdAt)));
          row.onclick = async () => {
            closeSheet();
            if (!state.channels.some((c) => c.id === r.channel.id)) await boot();
            await openChannel(r.channel.id);
            setTimeout(() => revealMessage(r.id), 250);
          };
          results.append(row);
        }
      } catch (err) { warn(err); }
    };
    field.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(run, 220);
    });
    scopeBox.addEventListener('change', run);
  });
}

function openPeers() {
  openSheet('People on this network', async (body) => {
    const loading = el('p', 'empty-body', 'Looking for other Lattice servers…');
    body.append(loading);
    try {
      const data = await api('/api/peers');
      body.innerHTML = '';
      const self = el('div', 'peer self');
      self.append(el('div', 'peer-name', `${data.self.hostname} (this machine)`));
      self.append(el('div', 'peer-meta', data.self.addresses.map((a) => `${a.address}:${data.self.port}`).join('   ') || 'no LAN address detected'));
      body.append(self);
      if (!data.peers.length) {
        body.append(el('p', 'empty-body', 'No other Lattice server answered. That is expected if this is the only one, if other machines are on a different subnet, or if the firewall blocks UDP 47823.'));
        return;
      }
      for (const p of data.peers) {
        const row = el('div', 'peer');
        row.append(el('div', 'peer-name', p.hostname));
        row.append(el('div', 'peer-meta', `${p.workspace} · ${p.platform} · ${p.addresses.map((a) => `${a.address}:${p.port}`).join(', ')}`));
        const links = el('div', 'peer-links');
        for (const a of p.addresses) {
          const link = el('a', 'ghost-btn tiny', `Open ${a.address}:${p.port}`);
          link.href = `http://${a.address}:${p.port}`;
          link.target = '_blank';
          link.rel = 'noreferrer noopener';
          links.append(link);
        }
        row.append(links);
        body.append(row);
      }
    } catch (err) {
      loading.textContent = err.message;
    }
  });
}

function openNewChannel() {
  openSheet('New channel', (body) => {
    const form = el('form', 'sheet-form');
    const nameLabel = el('label', null, 'Channel name');
    const name = el('input');
    name.placeholder = 'site-work';
    name.maxLength = 40;
    const topic = el('input');
    topic.placeholder = 'What is it for? (optional)';
    const picksLabel = el('div', 'list-label', 'Add people');
    const picks = el('div', 'picks');
    const chosen = new Set();
    for (const u of state.users.filter((u) => u.id !== state.me.id)) {
      const chip = el('button', 'chip', u.name);
      chip.type = 'button';
      chip.onclick = () => {
        if (chosen.has(u.id)) { chosen.delete(u.id); chip.classList.remove('on'); }
        else { chosen.add(u.id); chip.classList.add('on'); }
      };
      picks.append(chip);
    }
    const submit = el('button', 'primary-btn', 'Create channel');
    submit.type = 'submit';
    form.append(nameLabel, name, topic, picksLabel, picks, submit);
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const { channel } = await api('/api/channels', {
          method: 'POST', json: { kind: 'channel', name: name.value, topic: topic.value, memberIds: [...chosen] },
        });
        if (!state.channels.some((c) => c.id === channel.id)) state.channels.unshift(channel);
        state.discoverable = state.discoverable.filter((c) => c.id !== channel.id);
        closeSheet();
        renderSidebar();
        await openChannel(channel.id);
        toast(`Created #${channel.name}`, 'ok');
      } catch (err) { warn(err); }
    };
    body.append(form);
  });
}

function openBrowse() {
  openSheet('Browse channels', async (body) => {
    try {
      const data = await api('/api/bootstrap');
      state.discoverable = data.discoverable;
      state.users = data.users;
      const list = el('div', 'results');
      if (!data.discoverable.length) {
        body.append(el('p', 'empty-body', 'You are in every channel. Create a new one to start something.'));
        return;
      }
      for (const c of data.discoverable) {
        const row = el('div', 'result browse-row');
        row.append(el('span', 'result-where', `#${c.name}`));
        row.append(el('span', 'result-body', c.topic || `${c.members} member${c.members === 1 ? '' : 's'}`));
        const join = el('button', 'ghost-btn tiny', 'Join');
        join.onclick = async () => {
          try {
            const { channel } = await api(`/api/channels/${c.id}/join`, { method: 'POST', json: {} });
            if (!state.channels.some((x) => x.id === channel.id)) state.channels.unshift(channel);
            state.discoverable = state.discoverable.filter((x) => x.id !== c.id);
            closeSheet();
            renderSidebar();
            await openChannel(channel.id);
          } catch (err) { warn(err); }
        };
        row.append(join);
        list.append(row);
      }
      body.append(list);
    } catch (err) { warn(err); }
  });
}

function openMembers() {
  const ch = state.current;
  if (!ch) return;
  openSheet(ch.kind === 'dm' ? 'Conversation' : `People in #${ch.name}`, (body) => {
    const list = el('div', 'results');
    for (const m of ch.members) {
      const row = el('div', 'result member-row');
      row.append(el('span', 'result-where', m.name));
      row.append(el('span', 'result-body', state.online.has(m.id) ? 'Online' : 'Away'));
      if (m.id !== state.me.id) {
        const dm = el('button', 'ghost-btn tiny', 'Message');
        dm.onclick = () => { closeSheet(); startDm(m.id); };
        row.append(dm);
      } else {
        row.append(el('span', 'result-when', 'you'));
      }
      list.append(row);
    }
    body.append(list);
    if (ch.kind === 'channel' && ch.name !== 'general') {
      const leave = el('button', 'ghost-btn danger', `Leave #${ch.name}`);
      leave.onclick = async () => {
        if (!confirm(`Leave #${ch.name}? You can rejoin from Browse channels.`)) return;
        try {
          await api(`/api/channels/${ch.id}/leave`, { method: 'POST', json: {} });
          state.channels = state.channels.filter((c) => c.id !== ch.id);
          state.current = null;
          state.messages = [];
          closeSheet();
          renderSidebar();
          renderMessages();
        } catch (err) { warn(err); }
      };
      body.append(leave);
    }
  });
}

function openPins() {
  if (!state.current) return;
  openSheet('Pinned in this conversation', (body) => {
    const pins = state.messages.filter((m) => m.pinned);
    if (!pins.length) {
      body.append(el('p', 'empty-body', 'Nothing is pinned here yet. Pin a message to keep it easy to find.'));
      return;
    }
    for (const m of pins) {
      const row = el('button', 'result');
      row.append(el('span', 'result-where', m.author.name));
      row.append(el('span', 'result-body', m.body.slice(0, 160) || 'attachment'));
      row.append(el('span', 'result-when', shortDay(m.createdAt)));
      row.onclick = () => { closeSheet(); revealMessage(m.id); };
      body.append(row);
    }
  });
}

function openForward(message) {
  openSheet('Forward message', (body) => {
    const picks = el('div', 'picks');
    const chosen = new Set();
    for (const c of state.channels) {
      const chip = el('button', 'chip', (c.kind === 'dm' ? '' : '#') + chanName(c));
      chip.type = 'button';
      chip.onclick = () => {
        if (chosen.has(c.id)) { chosen.delete(c.id); chip.classList.remove('on'); }
        else { chosen.add(c.id); chip.classList.add('on'); }
      };
      picks.append(chip);
    }
    const go = el('button', 'primary-btn', 'Forward');
    go.onclick = async () => {
      if (!chosen.size) return toast('Choose at least one conversation.', 'info');
      try {
        const res = await api(`/api/messages/${message.id}/forward`, { method: 'POST', json: { channelIds: [...chosen] } });
        closeSheet();
        toast(`Forwarded to ${res.forwarded} conversation${res.forwarded === 1 ? '' : 's'}.`, 'ok');
      } catch (err) { warn(err); }
    };
    body.append(el('p', 'empty-body', 'Pick where this message should go.'), picks, go);
  });
}

function openSettings() {
  openSheet('Your settings', async (body) => {
    const info = await api('/api/health').catch(() => null);
    const form = el('form', 'sheet-form');
    const nameLabel = el('label', null, 'Display name');
    const name = el('input');
    name.value = state.me.name;
    name.maxLength = 40;
    const save = el('button', 'primary-btn', 'Save name');
    save.type = 'submit';
    const soundRow = el('label', 'check-row');
    const soundBox = el('input');
    soundBox.type = 'checkbox';
    soundBox.checked = state.prefs.sound;
    soundBox.onchange = () => {
      state.prefs.sound = soundBox.checked;
      localStorage.setItem('lattice-sound', soundBox.checked ? 'on' : 'off');
    };
    soundRow.append(soundBox, document.createTextNode('Play a sound for new messages'));

    const notifyRow = el('label', 'check-row');
    const notifyBox = el('input');
    notifyBox.type = 'checkbox';
    notifyBox.checked = state.prefs.notify;
    notifyBox.onchange = async () => {
      if (notifyBox.checked && 'Notification' in window && Notification.permission !== 'granted') {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { notifyBox.checked = false; return toast('Notifications were blocked by the browser.', 'info'); }
      }
      state.prefs.notify = notifyBox.checked;
      localStorage.setItem('lattice-notify', notifyBox.checked ? 'on' : 'off');
    };
    notifyRow.append(notifyBox, document.createTextNode('Desktop notifications when the tab is hidden'));

    form.append(nameLabel, name, save, soundRow, notifyRow);
    body.append(form);

    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/join', { method: 'POST', json: { name: name.value } });
        state.me.name = name.value;
        $('me-initials').textContent = initials(name.value);
        toast('Name updated.', 'ok');
        renderSidebar();
        renderMessages();
      } catch (err) { warn(err); }
    };

    if (info) {
      const facts = el('div', 'facts');
      const fact = (k, v) => {
        const row = el('div', 'fact');
        row.append(el('span', 'fact-k', k), el('span', 'fact-v', v));
        facts.append(row);
      };
      fact('Workspace', info.workspace);
      fact('Server version', info.version);
      fact('People', String(info.users));
      fact('Messages', String(info.messages));
      fact('Available here', `${Math.floor(info.uptimeSeconds / 60)} min`);
      body.append(el('div', 'list-label', 'This server'), facts);
    }

    const actions = el('div', 'sheet-actions');
    if (state.me.role === 'admin') {
      const admin = el('button', 'ghost-btn', 'Admin tools');
      admin.onclick = () => { closeSheet(); openAdmin(); };
      actions.append(admin);
    }
    const signOut = el('button', 'ghost-btn danger', 'Sign out of this browser');
    signOut.onclick = () => {
      localStorage.removeItem('lattice-token');
      token = null;
      location.reload();
    };
    actions.append(signOut);
    body.append(actions);
  });
}

function openAdmin() {
  openSheet('Admin tools', async (body) => {
    try {
      const data = await api('/api/admin/overview');
      const facts = el('div', 'facts');
      for (const [k, v] of Object.entries(data.counts)) {
        const row = el('div', 'fact');
        row.append(el('span', 'fact-k', k.replace(/([A-Z])/g, ' $1').toLowerCase()), el('span', 'fact-v', k === 'fileBytes' ? bytes(v) : String(v)));
        facts.append(row);
      }
      body.append(el('div', 'list-label', 'Workspace'), facts);

      const exportBtn = el('button', 'ghost-btn', 'Download JSON export');
      exportBtn.onclick = async () => {
        try {
          const res = await fetch('/api/admin/export', { headers: { authorization: `Bearer ${token}` } });
          if (!res.ok) throw new Error('Export failed.');
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = el('a');
          a.href = url;
          a.download = `lattice-export-${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
          URL.revokeObjectURL(url);
          toast('Export downloaded.', 'ok');
        } catch (err) { warn(err); }
      };
      body.append(el('div', 'sheet-actions', ''), exportBtn);

      body.append(el('div', 'list-label', 'People and roles'));
      const list = el('div', 'results');
      for (const u of state.users) {
        const row = el('div', 'result member-row');
        row.append(el('span', 'result-where', u.name));
        row.append(el('span', 'result-body', u.role === 'admin' ? 'Admin' : 'Member'));
        if (u.id !== state.me.id) {
          const toggle = el('button', 'ghost-btn tiny', u.role === 'admin' ? 'Make member' : 'Make admin');
          toggle.onclick = async () => {
            try {
              await api('/api/users/role', { method: 'POST', json: { userId: u.id, role: u.role === 'admin' ? 'member' : 'admin' } });
              const fresh = await api('/api/bootstrap');
              state.users = fresh.users;
              closeSheet();
              renderSidebar();
              openAdmin();
            } catch (err) { warn(err); }
          };
          row.append(toggle);
        } else {
          row.append(el('span', 'result-when', 'you'));
        }
        list.append(row);
      }
      body.append(list);
    } catch (err) { warn(err); }
  });
}

function openHelp() {
  openSheet('Keyboard shortcuts', (body) => {
    const rows = [
      ['Enter', 'Send the message'],
      ['Shift + Enter', 'New line'],
      ['Ctrl + K', 'Search every conversation'],
      ['Alt + ↑ / ↓', 'Move between conversations'],
      ['Esc', 'Close a panel or cancel a reply'],
      ['Drag a file', 'Share it in the open conversation'],
      ['Paste a file', 'Share it in the open conversation'],
    ];
    const table = el('div', 'facts');
    for (const [keys, meaning] of rows) {
      const row = el('div', 'fact');
      row.append(el('span', 'fact-k mono', keys), el('span', 'fact-v', meaning));
      table.append(row);
    }
    body.append(table);
    body.append(el('p', 'empty-body', 'Everything here works without internet: it talks only to the Lattice server in your office.'));
  });
}

$('btn-search').onclick = openSearch;
$('btn-new').onclick = openNewChannel;
$('btn-browse').onclick = openBrowse;
$('btn-peers').onclick = openPeers;
$('btn-help').onclick = openHelp;
$('btn-members').onclick = openMembers;
$('btn-pins').onclick = openPins;
$('me-avatar').onclick = openSettings;
$('btn-mark-read').onclick = async () => {
  try {
    await api('/api/read-all', { method: 'POST', json: {} });
    state.channels.forEach((c) => { c.unread = 0; });
    renderSidebar();
    toast('Everything marked as read.', 'ok');
  } catch (err) { warn(err); }
};

$('sidebar-toggle').onclick = () => document.body.classList.toggle('show-sidebar');
document.addEventListener('click', (e) => {
  if (document.body.classList.contains('show-sidebar') && !e.target.closest('.sidebar') && !e.target.closest('#sidebar-toggle')) {
    document.body.classList.remove('show-sidebar');
  }
});

// -------------------------------------------------------------------- start
$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('join-note').textContent = 'Joining…';
  try {
    await doJoin($('name-input').value.trim(), $('device-input').value.trim());
  } catch (err) {
    $('join-note').textContent = err.message;
  }
});

async function start() {
  if (!token) {
    showJoin();
    detectServer();
    return;
  }
  try {
    $('join').hidden = true;
    $('app').hidden = false;
    await boot();
  } catch {
    showJoin();
    detectServer();
  }
}

setInterval(() => { if (!$('typing').hidden) renderTyping(); }, 3000);
window.addEventListener('hashchange', async () => {
  const t = hashTarget();
  if (t && (!state.current || state.current.id !== t.channelId)) {
    const ch = state.channels.find((c) => c.id === t.channelId);
    if (ch) {
      await openChannel(ch.id);
      if (t.messageId) setTimeout(() => revealMessage(t.messageId), 300);
    }
  }
});

start();
