const app = document.getElementById('app');
const topbarActions = document.getElementById('topbar-actions');
const toastEl = document.getElementById('toast');
const announcer = document.getElementById('announcer');

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

// Screen readers hear important changes through one persistent live region. The page itself isn't a live
// region, because it re-renders whenever the event data changes.
function announce(message) {
  announcer.textContent = '';
  setTimeout(() => { announcer.textContent = message; }, 50);
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
    const ta = h('textarea', { class: 'offscreen' });
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
  if (code) go(`/join/${code}`);
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
    if (page === 'stats') return me.role === 'admin' ? await viewStats() : go(homePath());
    return go(homePath());
  } catch (err) {
    if (seq === routeSeq) app.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'error' }, err.message)));
  }
}

// On phones the navigation collapses into a menu so the top bar stays one row.
const compactTopbar = window.matchMedia('(max-width: 520px)');
compactTopbar.addEventListener('change', () => renderTopbar());

function renderTopbar() {
  const items = [];
  if (me) {
    const nav = [
      h('a', { class: 'btn btn-ghost btn-sm', href: isStaff() ? '#/events' : '#/home' }, isStaff() ? 'Events' : 'My events'),
      me.role === 'admin' ? h('a', { class: 'btn btn-ghost btn-sm', href: '#/users' }, 'Users') : null,
      me.role === 'admin' ? h('a', { class: 'btn btn-ghost btn-sm', href: '#/stats' }, 'Stats') : null,
      h('button', {
        class: 'btn btn-ghost btn-sm',
        onclick: async () => { await api('POST', '/api/logout'); go('/login'); },
      }, 'Sign out'),
    ];
    items.push(h('span', { class: 'who' }, h('span', { class: 'who-name' }, me.name), ' ', h('span', { class: 'chip chip-role' }, me.role)));
    items.push(compactTopbar.matches ? navMenu(nav) : nav);
  }
  items.push(themeButton());
  topbarActions.replaceChildren(...items.flat());
}

// The menu closes as soon as a link in it is tapped, or on a tap outside it.
function navMenu(links) {
  const panel = h('div', {
    class: 'menu-panel',
    id: 'nav-menu',
    hidden: true,
    onclick: (e) => { if (e.target.closest('a, button')) setMenuOpen(false); },
  }, links);
  const toggle = h('button', {
    type: 'button',
    class: 'btn btn-ghost btn-sm',
    'aria-expanded': 'false',
    'aria-controls': 'nav-menu',
    onclick: () => setMenuOpen(panel.hidden),
  }, '☰ Menu');
  function setMenuOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  }
  const menu = h('div', { class: 'menu' }, toggle, panel);
  menu.close = () => setMenuOpen(false);
  return menu;
}

document.addEventListener('click', (e) => {
  const menu = topbarActions.querySelector('.menu');
  if (menu && !menu.contains(e.target)) menu.close();
});

// ---------- theme ----------

// 'auto' follows the device setting; a Light or Dark choice is remembered per browser.
// index.html applies the remembered choice before the first paint.
const THEMES = ['auto', 'light', 'dark'];
const THEME_ICON = { auto: '◐', light: '☀︎', dark: '☾' };
const THEME_NAME = { auto: 'Auto', light: 'Light', dark: 'Dark' };

function currentTheme() {
  try {
    const theme = localStorage.getItem('pp_theme');
    return THEMES.includes(theme) ? theme : 'auto';
  } catch {
    return 'auto';
  }
}

function setTheme(theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === 'auto') localStorage.removeItem('pp_theme');
    else localStorage.setItem('pp_theme', theme);
  } catch { /* not remembered, but still applied for this visit */ }
}

function themeButton() {
  const theme = document.documentElement.dataset.theme || 'auto';
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  return h('button', {
    type: 'button',
    class: 'btn btn-ghost btn-sm btn-icon',
    title: `Colour theme: ${THEME_NAME[theme]}${theme === 'auto' ? ' (follows this device)' : ''}. Tap for ${THEME_NAME[next]}.`,
    'aria-label': `Colour theme: ${THEME_NAME[theme]}. Switch to ${THEME_NAME[next]}.`,
    onclick: () => {
      setTheme(next);
      renderTopbar();
    },
  }, THEME_ICON[theme]);
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
  try {
    const { event_id: eventId } = await api('POST', '/api/join', { code });
    go(`/event/${eventId}`);
  } catch (err) {
    toast(err.message, true);
    go('/home');
  }
}

// ---------- shooter home ----------

// Every role can shoot, so the shooter home and the staff events page both show these.
function joinCard() {
  const error = h('p', { class: 'error' });
  const codeInput = h('input', {
    class: 'code', name: 'code', maxlength: 6, autocomplete: 'off', autocapitalize: 'characters',
    spellcheck: 'false', placeholder: 'ABC123', 'aria-label': 'Invite code', required: true,
  });
  return h('div', { class: 'card' },
    h('h2', {}, 'Join an event'),
    h('form', {
      class: 'stack',
      onsubmit: formHandler(error, async () => {
        const { event_id: eventId } = await api('POST', '/api/join', { code: codeInput.value });
        go(`/event/${eventId}`);
      }),
    },
    h('label', {}, 'Invite code from the host', codeInput),
    error,
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Join event')));
}

// "Show more" under a paged list: loads the page after `next` with fetchPage(cursor) -> { rows, next },
// hands the rows to append(), and removes itself when there is nothing left.
function moreButton(next, fetchPage, append) {
  if (next == null) return null;
  let cursor = next;
  const btn = h('button', {
    type: 'button',
    class: 'btn btn-ghost btn-block more',
    onclick: async () => {
      btn.disabled = true;
      try {
        const page = await fetchPage(cursor);
        append(page.rows);
        cursor = page.next;
        if (cursor == null) btn.remove();
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
      }
    },
  }, 'Show more');
  return btn;
}

async function eventHistory(list, before) {
  const { events, next } = await api('GET', `/api/events/history?list=${list}&before=${before}`);
  return { rows: events, next };
}

function joinedItem(ev) {
  return h('a', { class: 'item', href: `#/event/${ev.id}` },
    h('div', {},
      h('div', { class: 'title' }, ev.name, ' ', statusChip(ev.status)),
      h('div', { class: 'muted small' }, `${fmtDate(ev.created_at)} · ${ev.participant_count} shooters`)),
    h('div', { class: 'result' }, shooterResult(ev)));
}

function joinedList(events, next) {
  if (!events.length) return h('div', { class: 'empty' }, 'You haven’t joined any events yet.');
  const list = h('div', { class: 'item-list' }, events.map(joinedItem));
  return h('div', {}, list,
    moreButton(next, (before) => eventHistory('joined', before), (rows) => list.append(...rows.map(joinedItem))));
}

async function viewHome() {
  const mount = mounter();
  const { joined, next } = await api('GET', '/api/events');

  mount(h('div', {},
    h('div', { class: 'page-head' }, h('h1', {}, `Hi, ${me.name}`)),
    joinCard(),
    h('h2', {}, 'My events'),
    joinedList(joined, next.joined),
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
  const { events, joined, next } = await api('GET', '/api/events');
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
  const pastList = h('div', { class: 'item-list' }, past.map(item));

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
    past.length ? pastList : h('div', { class: 'empty' }, 'Finished events will appear here.'),
    moreButton(next.events, (before) => eventHistory('managed', before), (rows) => pastList.append(...rows.map(item))),
    h('h2', { class: 'spaced' }, 'Shooting'),
    h('p', { class: 'muted' }, 'You can shoot in any event: join with its invite code, or tap “I’m shooting too” on an event you run.'),
    joinCard(),
    h('h3', {}, 'My events'),
    joinedList(joined, next.joined),
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
  let pendingRender = false;
  let closed = false;
  let deleting = false;
  let wakeLock = null;

  // Every fresh copy of the event goes through here, whether from the live stream, the fallback poll or
  // an action. Only real changes re-render, so a button isn't swapped out from under a finger mid-tap;
  // while an action is in flight or a two-tap confirmation is armed, the render waits (see below).
  function apply(next, { force = false } = {}) {
    if (closed) return;
    syncClock(next.now);
    announceChanges(data, next);
    data = next;
    if (!force && JSON.stringify({ ...next, now: 0 }) === lastSignature) return;
    if (!force && (busy || app.querySelector('.armed'))) {
      pendingRender = true;
      return;
    }
    render();
  }

  function announceChanges(prev, next) {
    if (!prev) return;
    if (prev.event.status !== next.event.status && next.event.status !== 'waiting') {
      announce(next.event.status === 'running' ? 'The event has started.' : 'The event has ended.');
    }
    if (next.me?.stopped && !prev.me?.stopped) {
      announce(`Your time is ${fmt(next.me.ms)}, rank ${next.me.rank} of ${next.participantCount}.`);
    }
  }

  async function load() {
    try {
      apply(await api('GET', `/api/events/${id}`));
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
      const next = await promise;
      busy = false;
      apply(next, { force: true });
    } catch (err) {
      busy = false;
      toast(err.message, true);
      render();
    }
  }

  // Keeps the screen on while this device takes part (shooting or running the event), so the clock and
  // STOP stay visible. Browsers drop the lock when the page is hidden; it's taken again when it's shown.
  async function keepAwake() {
    if (!('wakeLock' in navigator)) return;
    const want = !closed && document.visibilityState === 'visible'
      && Boolean(data && data.event.status !== 'finished' && (data.me || data.canManage));
    try {
      if (want && !wakeLock) {
        wakeLock = navigator.wakeLock.request('screen'); // the pending request blocks duplicates
        const lock = await wakeLock;
        wakeLock = lock;
        lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
      } else if (!want && wakeLock) {
        const lock = await wakeLock;
        wakeLock = null;
        await lock.release();
      }
    } catch {
      wakeLock = null; // refused (e.g. battery saver): the screen may turn off as usual
    }
  }

  function render() {
    pendingRender = false;
    lastSignature = JSON.stringify({ ...data, now: 0 });
    keepAwake();
    const { event } = data;
    mount(h('div', {},
      h('p', {}, h('a', { href: isStaff() ? '#/events' : '#/home' }, isStaff() ? '← All events' : '← My events')),
      h('div', { class: 'page-head' },
        h('h1', {}, event.name, ' ', statusChip(event.status)),
        h('p', { class: 'muted' }, eventMeta(data))),
      // A host who is also shooting needs STOP above the host controls once the event is running.
      ...(data.me && event.status !== 'waiting'
        ? [shooterPanel(), data.canManage ? hostPanel() : null]
        : [data.canManage ? hostPanel() : null, data.me ? shooterPanel() : null]),
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
          data.canParticipate ? participateToggle() : null,
          h('div', { class: 'center-row row' }, deleteButton())));
    }
    if (event.status === 'running') {
      // The STOP panel above already shows the clock while the host is still shooting.
      const showClock = !data.me || data.me.stopped;
      return h('div', { class: 'card host-controls is-live' },
        showClock ? h('div', { class: 'small muted center' }, 'Elapsed since start') : null,
        showClock ? h('div', { class: 'clock', dataset: { start: event.started_at } }, fmt(serverNow() - event.started_at)) : null,
        h('p', { class: 'center' }, `${data.results.length} of ${data.participantCount} shooters stopped`),
        h('div', { class: 'center-row row' },
          confirmButton('End event', 'Tap again to end', () => act(api('POST', `/api/events/${id}/finish`)), 'btn btn-stop')),
        h('p', { class: 'muted small center' }, 'Anyone who hasn’t stopped when the event ends is marked “did not finish”.'));
    }
    return h('div', { class: 'row row-spaced' }, deleteButton());
  }

  function participateToggle() {
    const join = (value) => act(api('POST', `/api/events/${id}/participate`, { join: value }));
    if (!data.me) {
      return h('div', { class: 'center-row row' },
        h('button', { class: 'btn btn-ghost', onclick: () => join(true) }, 'I’m shooting too'));
    }
    return h('div', { class: 'participating' },
      h('span', {}, h('strong', {}, 'You’re shooting too.'), ' Your timer starts when you press Start; press STOP when you finish.'),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => join(false) }, 'Not shooting'));
  }

  function deleteButton() {
    return confirmButton('Delete event', 'Tap to delete', async () => {
      deleting = true; // the stream's "gone" message may arrive first; this device shows its own toast
      try {
        await api('DELETE', `/api/events/${id}`);
      } catch (err) {
        deleting = false;
        throw err;
      }
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
      // The host panel's "You're shooting too" note already covers this.
      if (data.canParticipate) return null;
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
      h('div', { class: 'card-head' },
        h('h2', {}, 'Leaderboard'),
        data.canManage ? h('a', { class: 'btn btn-ghost btn-sm', href: `/api/events/${id}/results.csv`, download: true }, 'Export CSV') : null),
      table,
      pending.length ? h('div', { class: 'pending' },
        h('h3', {}, `${pendingTitle} (${pending.length})`),
        h('div', { class: 'name-list' }, pending.map((p) => h('span', {
          class: `name-pill ${event.status === 'running' ? 'is-running' : ''} ${p.user_id === data.me?.user_id ? 'is-me' : ''}`,
        }, p.name)))) : null);
  }

  await load();
  // Live updates arrive over the stream; the slow poll is only a safety net and re-syncs the clock.
  const stream = new EventSource(`/api/events/${id}/stream`);
  stream.onmessage = (e) => apply(JSON.parse(e.data));
  stream.addEventListener('gone', () => {
    stream.close();
    if (deleting) return;
    toast('This event is no longer available', true);
    go(homePath());
  });
  poll(load, 15000);
  poll(() => {
    if (pendingRender && !busy && !app.querySelector('.armed')) render();
  }, 300);
  document.addEventListener('visibilitychange', keepAwake);
  cleanups.push(() => {
    closed = true;
    stream.close();
    document.removeEventListener('visibilitychange', keepAwake);
    keepAwake();
  });
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
      h('p', { class: 'muted' }, 'Hosts run their own events. Admins see every event and manage users. Shooters can also sign themselves up. '
        + 'Changing a role takes effect on that user’s next page load; their results and events are kept.')),
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
    resetPasswordForm(users),
    h('div', { class: 'card' },
      h('div', { class: 'table-wrap' }, h('table', { class: 'board stack-mobile' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Username'), h('th', {}, 'Role'), h('th', {}, ''))),
        h('tbody', {}, users.map((u) => h('tr', {},
          h('td', { class: 'cell-main' }, u.name, u.id === me.id ? h('span', { class: 'muted' }, ' (you)') : null),
          h('td', { class: 'muted', 'data-label': 'Username' }, u.username),
          // Admins' roles (including your own) can't be changed here; see roleSelect.
          h('td', { 'data-label': 'Role' }, u.role === 'admin' ? h('span', { class: 'chip chip-role' }, u.role) : roleSelect(u)),
          // Other admins can't be removed from the app either (only on the server).
          h('td', { class: 'actions cell-action' }, u.role === 'admin' ? null : confirmButton('Remove', 'Sure?', async () => {
            await api('DELETE', `/api/users/${u.id}`);
            toast(`Removed ${u.username}`);
            router();
          }))))))))));
}

// Saves as soon as a new role is picked; on failure the select goes back to the saved role.
// Only shown for shooters and hosts: an admin's role can't be changed from the app, so promoting
// someone to admin is confirmed first and then shown as a plain chip.
function roleSelect(user) {
  let saved = user.role;
  const select = h('select', {
    class: 'select-sm',
    'aria-label': `Role for ${user.username}`,
    onchange: async () => {
      if (select.value === 'admin'
        && !window.confirm(`Make ${user.name} an admin? Admins can't be demoted from the app afterwards.`)) {
        select.value = saved;
        return;
      }
      select.disabled = true;
      try {
        await api('POST', `/api/users/${user.id}/role`, { role: select.value });
        saved = select.value;
        toast(`${user.name} is now ${saved === 'admin' ? 'an admin' : `a ${saved}`}`);
        if (saved === 'admin') router();
      } catch (err) {
        select.value = saved;
        toast(err.message, true);
      } finally {
        select.disabled = false;
      }
    },
  }, ['shooter', 'host', 'admin'].map((role) => h('option', { value: role, selected: role === saved }, role[0].toUpperCase() + role.slice(1))));
  return select;
}

function resetPasswordForm(users) {
  const error = h('p', { class: 'error' });
  const user = h('select', { name: 'user', required: true },
    h('option', { value: '' }, 'Choose a user…'),
    users.filter((u) => u.role !== 'admin').map((u) => h('option', { value: u.id }, `${u.name} (${u.username})`)));
  const password = h('input', { name: 'password', type: 'text', minlength: 8, autocomplete: 'off', required: true });
  const form = h('form', {
    class: 'stack',
    onsubmit: formHandler(error, async () => {
      const label = user.selectedOptions[0].textContent;
      await api('POST', `/api/users/${user.value}/password`, { password: password.value });
      form.reset();
      toast(`New password set for ${label}`);
    }),
  },
  h('p', { class: 'muted small' }, 'For someone who forgot their password. They’re signed out everywhere and use the new one to sign in.'),
  h('label', {}, 'User', user),
  h('label', {}, 'New temporary password (8+ characters)', password),
  error,
  h('button', { class: 'btn btn-primary', type: 'submit' }, 'Reset password'));
  return h('div', { class: 'card' }, h('details', {}, h('summary', {}, 'Reset a password'), form));
}

// ---------- stats (admin) ----------

const fmtDay = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');

function statTile(label, value, sub) {
  return h('div', { class: 'stat' },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value' }, value),
    sub ? h('div', { class: 'muted small' }, sub) : null);
}

async function viewStats() {
  const mount = mounter();
  const { users, events, entries, shooters, staff, next_offset: nextOffset } = await api('GET', '/api/stats');
  // data-label is shown in place of the column heading when the tables stack into cards on a phone.
  const num = (label, value) => h('td', { class: 'num', 'data-label': label }, value);
  const numHead = (label) => h('th', { class: 'num' }, label);
  const shooterRow = (u) => h('tr', {},
    h('td', { class: 'cell-main' }, u.name, u.role === 'shooter' ? null : [' ', h('span', { class: 'chip chip-role' }, u.role)],
      h('div', { class: 'muted small' }, u.username)),
    num('Events', u.events), num('Finished', u.finished), num('DNF', u.dnf), num('Wins', u.wins), num('Podiums', u.podiums),
    h('td', { class: 'muted nowrap', 'data-label': 'Last event' }, fmtDay(u.last_event_at)));
  const shooterBody = h('tbody', {}, shooters.map(shooterRow));
  const finishRate = entries.in_finished_events
    ? `${Math.round(100 * (1 - entries.dnf / entries.in_finished_events))}%`
    : '—';

  mount(h('div', {},
    h('div', { class: 'page-head' },
      h('h1', {}, 'Stats'),
      h('p', { class: 'muted' }, 'Wins and podiums count finished events only.')),
    h('div', { class: 'stat-grid' },
      statTile('Users', users.admin + users.host + users.shooter, `${users.shooter} shooters · ${users.host} hosts · ${users.admin} admins`),
      statTile('Events', events.waiting + events.running + events.finished, `${events.running} live · ${events.waiting} waiting · ${events.finished} finished`),
      statTile('Entries', entries.total, `${entries.finished} times recorded`),
      statTile('Finish rate', finishRate, `${entries.dnf} did not finish`)),
    h('div', { class: 'card' },
      h('h2', {}, 'Shooters'),
      shooters.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'board stack-mobile' },
          h('thead', {}, h('tr', {},
            h('th', {}, 'Shooter'), numHead('Events'), numHead('Finished'), numHead('DNF'), numHead('Wins'), numHead('Podiums'), h('th', {}, 'Last event'))),
          shooterBody))
        : h('div', { class: 'empty' }, 'No shooters yet.'),
      moreButton(nextOffset, async (offset) => {
        const page = await api('GET', `/api/stats/shooters?offset=${offset}`);
        return { rows: page.shooters, next: page.next_offset };
      }, (rows) => shooterBody.append(...rows.map(shooterRow)))),
    h('div', { class: 'card' },
      h('h2', {}, 'Hosts and admins'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'board stack-mobile' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Name'), h('th', {}, 'Role'), numHead('Events'), numHead('Finished'), numHead('Entries'), h('th', {}, 'Last event'))),
        h('tbody', {}, staff.map((u) => h('tr', {},
          h('td', { class: 'cell-main' }, u.name, h('div', { class: 'muted small' }, u.username)),
          h('td', { 'data-label': 'Role' }, h('span', { class: 'chip chip-role' }, u.role)),
          num('Events', u.events), num('Finished', u.finished), num('Entries', u.entries),
          h('td', { class: 'muted nowrap', 'data-label': 'Last event' }, fmtDay(u.last_event_at))))))))));
}

setTheme(currentTheme());
window.addEventListener('hashchange', router);
router();
