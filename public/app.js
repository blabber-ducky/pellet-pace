const app = document.getElementById('app');
const topbarActions = document.getElementById('topbar-actions');
const toastEl = document.getElementById('toast');

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false) el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

async function api(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body || {});
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.classList.toggle('is-error', isError);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3200);
}

function fmt(ms) {
  const t = Math.max(0, Math.floor(ms / 10));
  const cs = t % 100;
  const s = Math.floor(t / 100) % 60;
  const m = Math.floor(t / 6000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const STATUS_LABEL = { waiting: 'Waiting', running: 'Live', finished: 'Finished' };
const statusChip = (status) => h('span', { class: `chip chip-${status}` }, STATUS_LABEL[status]);

// Timers run against the server clock so a device with a wrong clock still shows the right time.
let clockOffset = 0;
const syncClock = (serverNow) => { clockOffset = serverNow - Date.now(); };
const serverNow = () => Date.now() + clockOffset;

setInterval(() => {
  for (const el of document.querySelectorAll('[data-start]')) {
    el.textContent = fmt(serverNow() - Number(el.dataset.start));
  }
}, 50);

// Two-tap confirmation for destructive or irreversible actions.
function confirmButton(label, armedLabel, onConfirm, cls = 'btn btn-danger-ghost btn-sm') {
  let timer;
  const btn = h('button', {
    type: 'button',
    class: cls,
    onclick: async () => {
      if (!btn.classList.contains('armed')) {
        btn.classList.add('armed');
        btn.textContent = armedLabel;
        timer = setTimeout(() => { btn.classList.remove('armed'); btn.textContent = label; }, 3000);
        return;
      }
      clearTimeout(timer);
      btn.disabled = true;
      try {
        await onConfirm();
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
      }
    },
  }, label);
  return btn;
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = value;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied');
}

function formHandler(error, fn) {
  return async (e) => {
    e.preventDefault();
    error.textContent = '';
    const submit = e.target.querySelector('[type=submit]');
    if (submit) submit.disabled = true;
    try {
      await fn();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      if (submit) submit.disabled = false;
    }
  };
}

// ---------- routing ----------

let me = null;
let routeSeq = 0;
let cleanups = [];
const isStaff = () => me && (me.role === 'admin' || me.role === 'host');
const homePath = () => (!me ? '/login' : isStaff() ? '/events' : '/home');

function go(path) {
  if (location.hash === `#${path}`) router();
  else location.hash = path;
}

function poll(fn, ms) {
  const id = setInterval(fn, ms);
  cleanups.push(() => clearInterval(id));
}

// Returns a mount function that ignores renders from a view the user already navigated away from.
function mounter() {
  const seq = routeSeq;
  return (node) => {
    if (seq !== routeSeq) return false;
    app.replaceChildren(node);
    return true;
  };
}

// An invite link opened while signed out is remembered until the shooter signs in.
const pendingCode = {
  get: () => { try { return sessionStorage.getItem('pp_code'); } catch { return null; } },
  set: (code) => { try { sessionStorage.setItem('pp_code', code); } catch { /* ignore */ } },
  clear: () => { try { sessionStorage.removeItem('pp_code'); } catch { /* ignore */ } },
};

function afterSignIn() {
  const code = pendingCode.get();
  if (code && me.role === 'shooter') go(`/join/${code}`);
  else go(homePath());
}

async function router() {
  cleanups.forEach((fn) => fn());
  cleanups = [];
  const seq = ++routeSeq;
  const [page, arg] = (location.hash.slice(1) || '/').split('/').filter(Boolean);
  me = (await api('GET', '/api/me').catch(() => ({ user: null }))).user;
  if (seq !== routeSeq) return;
  renderTopbar();
  window.scrollTo(0, 0);

  try {
    if (page === 'login') return me ? go(homePath()) : viewLogin();
    if (page === 'register') return me ? go(homePath()) : viewRegister();
    if (page === 'join') return joinFromLink(arg);
    if (!me) return go('/login');
    if (page === 'home') return isStaff() ? go('/events') : await viewHome();
    if (page === 'events') return isStaff() ? await viewEvents() : go('/home');
    if (page === 'event' && arg) return await viewEvent(Number(arg));
    if (page === 'users') return me.role === 'admin' ? await viewUsers() : go(homePath());
    return go(homePath());
  } catch (err) {
    if (seq === routeSeq) app.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'error' }, err.message)));
  }
}

function renderTopbar() {
  const items = [];
  if (me) {
    items.push(h('span', { class: 'who' }, me.name, ' ', h('span', { class: 'chip chip-role' }, me.role)));
    items.push(h('a', { class: 'btn btn-ghost btn-sm', href: isStaff() ? '#/events' : '#/home' }, isStaff() ? 'Events' : 'My events'));
    if (me.role === 'admin') items.push(h('a', { class: 'btn btn-ghost btn-sm', href: '#/users' }, 'Users'));
    items.push(h('button', {
      class: 'btn btn-ghost btn-sm',
      onclick: async () => { await api('POST', '/api/logout'); go('/login'); },
    }, 'Sign out'));
  }
  topbarActions.replaceChildren(...items);
}

// ---------- sign in / sign up ----------

function viewLogin() {
  const mount = mounter();
  const error = h('p', { class: 'error' });
  const username = h('input', { name: 'username', autocomplete: 'username', autocapitalize: 'none', required: true });
  const password = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });

  mount(h('div', { class: 'narrow' },
    h('div', { class: 'page-head' },
      h('h1', {}, 'Sign in'),
      pendingCode.get()
        ? h('p', { class: 'muted' }, `Sign in to join event ${pendingCode.get()}.`)
        : h('p', { class: 'muted' }, 'Shooters, hosts and admins all sign in here.')),
    h('div', { class: 'card' },
      h('form', {
        class: 'stack',
        onsubmit: formHandler(error, async () => {
          me = (await api('POST', '/api/login', { username: username.value, password: password.value })).user;
          afterSignIn();
        }),
      },
      h('label', {}, 'Username', username),
      h('label', {}, 'Password', password),
      error,
      h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Sign in'))),
    h('p', { class: 'muted center' }, 'New shooter? ', h('a', { href: '#/register' }, 'Create an account'))));

  username.focus();
}

function viewRegister() {
  const mount = mounter();
  const error = h('p', { class: 'error' });
  const name = h('input', { name: 'name', maxlength: 40, autocomplete: 'name', placeholder: 'Shown on leaderboards', required: true });
  const username = h('input', { name: 'username', maxlength: 30, autocomplete: 'username', autocapitalize: 'none', required: true });
  const password = h('input', { name: 'password', type: 'password', minlength: 8, autocomplete: 'new-password', required: true });

  mount(h('div', { class: 'narrow' },
    h('div', { class: 'page-head' },
      h('h1', {}, 'Create shooter account'),
      h('p', { class: 'muted' }, 'You’ll use this to join events and see your results.')),
    h('div', { class: 'card' },
      h('form', {
        class: 'stack',
        onsubmit: formHandler(error, async () => {
          me = (await api('POST', '/api/register', { name: name.value, username: username.value, password: password.value })).user;
          afterSignIn();
        }),
      },
      h('label', {}, 'Your name', name),
      h('label', {}, 'Username', username),
      h('label', {}, 'Password (8+ characters)', password),
      error,
      h('button', { class: 'btn btn-go btn-block', type: 'submit' }, 'Create account'))),
    h('p', { class: 'muted center' }, 'Already have an account? ', h('a', { href: '#/login' }, 'Sign in'))));

  name.focus();
}

async function joinFromLink(code) {
  if (!code) return go(homePath());
  if (!me) {
    pendingCode.set(code.toUpperCase());
    return go('/login');
  }
  pendingCode.clear();
  if (me.role !== 'shooter') {
    toast('Only shooter accounts can join events', true);
    return go(homePath());
  }
  try {
    const { event_id: eventId } = await api('POST', '/api/join', { code });
    go(`/event/${eventId}`);
  } catch (err) {
    toast(err.message, true);
    go('/home');
  }
}

// ---------- shooter home ----------

async function viewHome() {
  const mount = mounter();
  const { events } = await api('GET', '/api/events');
  const error = h('p', { class: 'error' });
  const codeInput = h('input', {
    class: 'code', name: 'code', maxlength: 6, autocomplete: 'off', autocapitalize: 'characters',
    spellcheck: 'false', placeholder: 'ABC123', 'aria-label': 'Invite code', required: true,
  });

  const list = events.length
    ? h('div', { class: 'item-list' }, events.map((ev) => h('a', { class: 'item', href: `#/event/${ev.id}` },
      h('div', {},
        h('div', { class: 'title' }, ev.name, ' ', statusChip(ev.status)),
        h('div', { class: 'muted small' }, `${fmtDate(ev.created_at)} · ${ev.participant_count} shooters`)),
      h('div', { class: 'result' }, shooterResult(ev)))))
    : h('div', { class: 'empty' }, 'You haven’t joined any events yet.');

  mount(h('div', {},
    h('div', { class: 'page-head' }, h('h1', {}, `Hi, ${me.name}`)),
    h('div', { class: 'card' },
      h('h2', {}, 'Join an event'),
      h('form', {
        class: 'stack',
        onsubmit: formHandler(error, async () => {
          const { event_id: eventId } = await api('POST', '/api/join', { code: codeInput.value });
          go(`/event/${eventId}`);
        }),
      },
      h('label', {}, 'Invite code from your host', codeInput),
      error,
      h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Join event'))),
    h('h2', {}, 'My events'),
    list,
    h('div', { class: 'card spaced' }, passwordForm())));
}

function shooterResult(ev) {
  if (ev.ms != null) return [h('div', { class: 'time' }, fmt(ev.ms)), h('div', { class: 'muted small' }, `#${ev.rank} of ${ev.participant_count}`)];
  if (ev.status === 'waiting') return h('span', { class: 'muted' }, 'Not started');
  if (ev.status === 'running') return h('span', { class: 'live-text' }, 'Running — open');
  return h('span', { class: 'muted' }, 'Did not finish');
}

// ---------- staff events ----------

async function viewEvents() {
  const mount = mounter();
  const { events } = await api('GET', '/api/events');
  const error = h('p', { class: 'error' });
  const nameInput = h('input', { name: 'name', maxlength: 80, placeholder: 'Saturday 10m air rifle', required: true });

  const item = (ev) => h('a', { class: 'item', href: `#/event/${ev.id}` },
    h('div', {},
      h('div', { class: 'title' }, ev.name, ' ', statusChip(ev.status)),
      h('div', { class: 'muted small' },
        `${fmtDate(ev.created_at)} · ${ev.participant_count} shooters`,
        me.role === 'admin' && ev.host_name ? ` · host ${ev.host_name}` : '')),
    ev.status === 'waiting' ? h('div', { class: 'code' }, ev.invite_code) : null);

  const active = events.filter((ev) => ev.status !== 'finished');
  const past = events.filter((ev) => ev.status === 'finished');

  mount(h('div', {},
    h('div', { class: 'page-head' },
      h('h1', {}, `Hi, ${me.name}`),
      h('p', { class: 'muted' }, 'Create an event, share the invite code, then start it for everyone at once.')),
    h('div', { class: 'card' },
      h('h2', {}, 'New event'),
      h('form', {
        class: 'stack',
        onsubmit: formHandler(error, async () => {
          const { event } = await api('POST', '/api/events', { name: nameInput.value });
          go(`/event/${event.id}`);
        }),
      },
      h('div', { class: 'form-inline' },
        h('label', {}, 'Event name', nameInput),
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create event')),
      error)),
    h('h2', {}, 'Current events'),
    active.length ? h('div', { class: 'item-list' }, active.map(item)) : h('div', { class: 'empty' }, 'No current events.'),
    h('h2', { class: 'spaced' }, 'Previous events'),
    past.length ? h('div', { class: 'item-list' }, past.map(item)) : h('div', { class: 'empty' }, 'Finished events will appear here.'),
    h('div', { class: 'card spaced' }, passwordForm())));
}

function passwordForm() {
  const error = h('p', { class: 'error' });
  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const form = h('form', {
    class: 'stack',
    onsubmit: formHandler(error, async () => {
      await api('POST', '/api/me/password', { current: current.value, next: next.value });
      form.reset();
      toast('Password changed');
    }),
  },
  h('label', {}, 'Current password', current),
  h('label', {}, 'New password (8+ characters)', next),
  error,
  h('button', { class: 'btn btn-ghost', type: 'submit' }, 'Change password'));
  return h('details', {}, h('summary', {}, 'Change password'), form);
}

// ---------- event (host controls, shooter stop, leaderboard) ----------

async function viewEvent(id) {
  const mount = mounter();
  let data;
  let lastSignature = '';
  let busy = false;

  async function load() {
    try {
      const next = await api('GET', `/api/events/${id}`);
      syncClock(next.now);
      data = next;
      // Only re-render on real changes, so a button isn't swapped out from under a finger mid-tap,
      // and never while a two-tap confirmation is armed.
      const signature = JSON.stringify({ ...next, now: 0 });
      if (signature !== lastSignature && !busy && !app.querySelector('.armed')) render();
    } catch (err) {
      if (err.status === 404 || err.status === 401) {
        toast(err.message, true);
        go(homePath());
      }
    }
  }

  async function act(promise) {
    busy = true;
    try {
      data = await promise;
      syncClock(data.now);
    } catch (err) {
      toast(err.message, true);
    } finally {
      busy = false;
      render();
    }
  }

  function render() {
    lastSignature = JSON.stringify({ ...data, now: 0 });
    const { event } = data;
    mount(h('div', {},
      h('p', {}, h('a', { href: isStaff() ? '#/events' : '#/home' }, isStaff() ? '← All events' : '← My events')),
      h('div', { class: 'page-head' },
        h('h1', {}, event.name, ' ', statusChip(event.status)),
        h('p', { class: 'muted' }, eventMeta(data))),
      data.canManage ? hostPanel() : null,
      data.me ? shooterPanel() : null,
      leaderboard()));
  }

  function hostPanel() {
    const { event } = data;
    if (event.status === 'waiting') {
      const joinLink = `${location.origin}${location.pathname}#/join/${event.invite_code}`;
      return h('div', {},
        h('div', { class: 'invite' },
          h('div', { class: 'small' }, 'Invite code'),
          h('div', { class: 'invite-code' }, event.invite_code),
          h('div', { class: 'invite-link' }, joinLink),
          h('div', { class: 'row center-row' },
            h('button', { class: 'btn btn-sm', onclick: () => copyText(event.invite_code) }, 'Copy code'),
            h('button', { class: 'btn btn-sm', onclick: () => copyText(joinLink) }, 'Copy link'))),
        h('div', { class: 'card host-controls' },
          data.participantCount
            ? confirmButton('Start for everyone', 'Tap again to start', () => act(api('POST', `/api/events/${id}/start`)), 'btn btn-go btn-huge')
            : h('button', { class: 'btn btn-go btn-huge', disabled: true }, 'Start for everyone'),
          h('p', { class: 'muted small center' },
            data.participantCount
              ? 'Starts the timer for every joined shooter at the same moment. Shooters can’t join after this.'
              : 'Waiting for shooters to join…'),
          h('div', { class: 'center-row row' }, deleteButton())));
    }
    if (event.status === 'running') {
      return h('div', { class: 'card host-controls is-live' },
        h('div', { class: 'small muted center' }, 'Elapsed since start'),
        h('div', { class: 'clock', dataset: { start: event.started_at } }, fmt(serverNow() - event.started_at)),
        h('p', { class: 'center' }, `${data.results.length} of ${data.participantCount} shooters stopped`),
        h('div', { class: 'center-row row' },
          confirmButton('End event', 'Tap again to end', () => act(api('POST', `/api/events/${id}/finish`)), 'btn btn-stop')),
        h('p', { class: 'muted small center' }, 'Anyone who hasn’t stopped when the event ends is marked “did not finish”.'));
    }
    return h('div', { class: 'row', style: 'margin-bottom:16px' }, deleteButton());
  }

  function deleteButton() {
    return confirmButton('Delete event', 'Tap to delete', async () => {
      await api('DELETE', `/api/events/${id}`);
      toast('Event deleted');
      go('/events');
    });
  }

  function shooterPanel() {
    const { event } = data;
    const mine = data.me;
    if (mine.stopped) {
      return h('div', { class: 'card my-result' },
        h('div', { class: 'small muted' }, 'Your time'),
        h('div', { class: 'clock' }, fmt(mine.ms)),
        h('div', { class: 'my-rank' }, `#${mine.rank} of ${data.participantCount}`));
    }
    if (event.status === 'waiting') {
      return h('div', { class: 'card waiting' },
        h('div', { class: 'pulse' }),
        h('div', {},
          h('strong', {}, 'You’re in. Waiting for the host to start…'),
          h('div', { class: 'muted small' }, 'Keep this screen open — your timer will start automatically.')));
    }
    if (event.status === 'running') {
      return h('div', { class: 'card stop-panel' },
        h('div', { class: 'clock', dataset: { start: event.started_at } }, fmt(serverNow() - event.started_at)),
        h('button', {
          class: 'btn btn-stop btn-stop-huge',
          onclick: (e) => {
            e.currentTarget.disabled = true;
            act(api('POST', `/api/events/${id}/stop`));
          },
        }, 'STOP'),
        h('p', { class: 'muted small center' }, 'Press once when you’re done. Your time is final.'));
    }
    return h('div', { class: 'banner' }, 'The event ended before you stopped — did not finish.');
  }

  function leaderboard() {
    const { event, results, pending } = data;
    if (event.status === 'waiting') {
      return h('div', { class: 'card' },
        h('h2', {}, `Joined (${pending.length})`),
        pending.length
          ? h('div', { class: 'name-list' }, pending.map((p) => h('span', { class: `name-pill ${p.user_id === data.me?.user_id ? 'is-me' : ''}` }, p.name)))
          : h('div', { class: 'empty' }, 'Nobody has joined yet.'));
    }

    const leader = results[0];
    const canClear = data.canManage && event.status === 'running';
    const table = results.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'board' },
        h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Shooter'), h('th', {}, 'Time'), h('th', {}, 'Gap'), canClear ? h('th', {}, '') : null)),
        h('tbody', {}, results.map((r) => h('tr', { class: r.user_id === data.me?.user_id ? 'is-me' : '' },
          h('td', {}, rankBadge(r.rank)),
          h('td', {}, r.name),
          h('td', { class: 'time' }, fmt(r.ms)),
          h('td', { class: 'muted' }, r === leader ? '—' : `+${fmt(r.ms - leader.ms)}`),
          canClear ? h('td', { class: 'actions' }, confirmButton('Clear', 'Sure?', () => act(api('POST', `/api/events/${id}/clear`, { user_id: r.user_id })))) : null)))))
      : h('div', { class: 'empty' }, 'No times yet.');

    const pendingTitle = event.status === 'running' ? 'Still shooting' : 'Did not finish';
    return h('div', { class: 'card' },
      h('h2', {}, 'Leaderboard'),
      table,
      pending.length ? h('div', { class: 'pending' },
        h('h3', {}, `${pendingTitle} (${pending.length})`),
        h('div', { class: 'name-list' }, pending.map((p) => h('span', {
          class: `name-pill ${event.status === 'running' ? 'is-running' : ''} ${p.user_id === data.me?.user_id ? 'is-me' : ''}`,
        }, p.name)))) : null);
  }

  await load();
  poll(load, 1500);
}

function eventMeta({ event, participantCount }) {
  const parts = [`${participantCount} shooters`];
  if (event.host_name) parts.push(`host ${event.host_name}`);
  if (event.started_at) parts.push(`started ${fmtDate(event.started_at)}`);
  else parts.push(`created ${fmtDate(event.created_at)}`);
  return parts.join(' · ');
}

function rankBadge(rank) {
  return h('span', { class: `rank ${rank <= 3 ? `rank-${rank}` : ''}` }, rank);
}

// ---------- users (admin) ----------

async function viewUsers() {
  const mount = mounter();
  const { users } = await api('GET', '/api/users');
  const error = h('p', { class: 'error' });
  const name = h('input', { name: 'name', maxlength: 40, autocomplete: 'off', required: true });
  const username = h('input', { name: 'username', maxlength: 30, autocomplete: 'off', autocapitalize: 'none', required: true });
  const password = h('input', { name: 'password', type: 'text', minlength: 8, autocomplete: 'off', required: true });
  const role = h('select', { name: 'role' },
    h('option', { value: 'host' }, 'Host'),
    h('option', { value: 'admin' }, 'Admin'),
    h('option', { value: 'shooter' }, 'Shooter'));

  mount(h('div', {},
    h('div', { class: 'page-head' },
      h('h1', {}, 'Users'),
      h('p', { class: 'muted' }, 'Hosts run their own events. Admins see every event and manage users. Shooters can also sign themselves up.')),
    h('div', { class: 'card' },
      h('h2', {}, 'Add a user'),
      h('form', {
        class: 'stack',
        onsubmit: formHandler(error, async () => {
          await api('POST', '/api/users', { name: name.value, username: username.value, password: password.value, role: role.value });
          toast(`Added ${username.value}`);
          router();
        }),
      },
      h('label', {}, 'Name', name),
      h('label', {}, 'Username', username),
      h('label', {}, 'Temporary password (8+ characters)', password),
      h('label', {}, 'Role', role),
      error,
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add user'))),
    h('div', { class: 'card' },
      h('div', { class: 'table-wrap' }, h('table', { class: 'board' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Username'), h('th', {}, 'Role'), h('th', {}, ''))),
        h('tbody', {}, users.map((u) => h('tr', {},
          h('td', {}, u.name, u.id === me.id ? h('span', { class: 'muted' }, ' (you)') : null),
          h('td', { class: 'muted' }, u.username),
          h('td', {}, h('span', { class: 'chip chip-role' }, u.role)),
          h('td', { class: 'actions' }, u.id === me.id ? null : confirmButton('Remove', 'Sure?', async () => {
            await api('DELETE', `/api/users/${u.id}`);
            toast(`Removed ${u.username}`);
            router();
          }))))))))));
}

window.addEventListener('hashchange', router);
router();
