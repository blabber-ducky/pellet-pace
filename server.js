import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'pellet-pace.db');
// HTTPS is the default; set HTTPS=0 when a reverse proxy terminates TLS in front of the app.
const USE_HTTPS = process.env.HTTPS !== '0';
const TLS_DIR = process.env.TLS_DIR || path.join(path.dirname(DB_PATH), 'tls');
// Comma-separated hostnames/IPs devices use to reach the app. Needed in Docker, where the
// container's own hostname and IPs aren't the ones on the LAN.
const TLS_HOSTS = (process.env.TLS_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
const SECURE_COOKIES = USE_HTTPS || process.env.COOKIE_SECURE === '1';

const SESSION_TTL = 14 * 24 * 3600 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const SCHEMA_VERSION = 2;

// ---------- database ----------

let db;
try {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
} catch (err) {
  console.error(
    `Cannot open the database at ${DB_PATH}: ${err.message}\n`
      + `Make sure its folder exists and is writable by uid ${process.getuid?.()} `
      + '(in Docker with a host folder, set PUID/PGID to the folder owner).',
  );
  process.exit(1);
}

// Version 1 (games/laps, shooters without accounts) is replaced by version 2 (events, shooter accounts).
// Staff accounts carry over; old game data is left in its tables but no longer used.
if (db.prepare('PRAGMA user_version').get().user_version < SCHEMA_VERSION) {
  db.exec('PRAGMA foreign_keys = OFF; BEGIN;');
  try {
    const hadUsers = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'`).get();
    db.exec(`
      CREATE TABLE users_v2 (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'host', 'shooter')),
        created_at INTEGER NOT NULL
      );
    `);
    if (hadUsers) {
      db.exec(`
        INSERT INTO users_v2 (id, username, name, password_hash, role, created_at)
          SELECT id, username, username, password_hash, role, created_at FROM users;
        DROP TABLE users;
      `);
    }
    db.exec(`
      ALTER TABLE users_v2 RENAME TO users;
      DROP TABLE IF EXISTS sessions;

      CREATE TABLE sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        invite_code TEXT NOT NULL UNIQUE,
        host_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'running', 'finished')),
        started_at INTEGER,
        finished_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE entries (
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at INTEGER NOT NULL,
        stopped_at INTEGER,
        PRIMARY KEY (event_id, user_id)
      );
      CREATE INDEX entries_by_user ON entries (user_id);

      PRAGMA user_version = ${SCHEMA_VERSION};
      COMMIT;
    `);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}
db.exec('PRAGMA foreign_keys = ON;');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

if (!db.prepare(`SELECT 1 FROM users WHERE role = 'admin'`).get()) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO users (username, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(username, 'Admin', hashPassword(password), 'admin', Date.now());
  console.log(`Created admin account -> username: ${username}  password: ${password}`);
}

db.prepare('DELETE FROM sessions WHERE created_at < ?').run(Date.now() - SESSION_TTL);

function newInviteCode() {
  const exists = db.prepare('SELECT 1 FROM events WHERE invite_code = ?');
  for (;;) {
    const bytes = crypto.randomBytes(6);
    const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    if (!exists.get(code)) return code;
  }
}

// ---------- http helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, maxAgeMs) {
  const maxAge = Math.floor(maxAgeMs / 1000);
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE_COOKIES ? '; Secure' : ''}`;
}

async function readJson(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return {};
  // Requiring a JSON content type blocks cross-site form posts (CSRF).
  if (!(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'Expected JSON');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function text(value, field, max = 60) {
  const v = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!v) throw new HttpError(400, `${field} is required`);
  if (v.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return v;
}

function username(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(v)) {
    throw new HttpError(400, 'Username must be 3–30 letters, numbers, dots, dashes or underscores');
  }
  return v;
}

function newPassword(value) {
  const v = typeof value === 'string' ? value : '';
  if (v.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  return v;
}

// Simple in-memory brute-force guard for login and sign-up.
const authFailures = new Map();
function checkAuthRate(ip) {
  const entry = authFailures.get(ip);
  if (entry && entry.count >= 10 && Date.now() - entry.first < 15 * 60 * 1000) {
    throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  }
}
function recordAuthFailure(ip) {
  const entry = authFailures.get(ip);
  if (!entry || Date.now() - entry.first > 15 * 60 * 1000) authFailures.set(ip, { count: 1, first: Date.now() });
  else entry.count++;
}

// ---------- sessions ----------

function startSession(ctx, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, Date.now());
  ctx.cookies.push(cookie('pp_session', token, SESSION_TTL));
}

function loadUser(cookies) {
  if (!cookies.pp_session) return null;
  return db.prepare(`
    SELECT u.id, u.username, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.created_at > ?
  `).get(cookies.pp_session, Date.now() - SESSION_TTL) || null;
}

function requireUser(ctx, ...roles) {
  if (!ctx.user) throw new HttpError(401, 'Please sign in');
  if (roles.length && !roles.includes(ctx.user.role)) throw new HttpError(403, 'Not allowed for your account');
  return ctx.user;
}

const isStaff = (user) => user.role === 'admin' || user.role === 'host';

// Hosts manage their own events, admins manage all; shooters may view events they entered.
function loadEvent(ctx, id) {
  const user = requireUser(ctx);
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(Number(id));
  if (!event) throw new HttpError(404, 'Event not found');
  const canManage = user.role === 'admin' || (user.role === 'host' && event.host_id === user.id);
  const entry = user.role === 'shooter'
    ? db.prepare('SELECT * FROM entries WHERE event_id = ? AND user_id = ?').get(event.id, user.id)
    : null;
  if (!canManage && !entry) throw new HttpError(404, 'Event not found');
  return { event, canManage, entry };
}

function loadManagedEvent(ctx, id) {
  const { event, canManage } = loadEvent(ctx, id);
  if (!canManage) throw new HttpError(403, 'Only the host can do that');
  return event;
}

// ---------- leaderboard ----------

function withRanks(rows) {
  rows.forEach((row, i) => {
    row.rank = i > 0 && rows[i - 1].ms === row.ms ? rows[i - 1].rank : i + 1;
  });
  return rows;
}

function publicEvent(event, canManage) {
  const host = event.host_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(event.host_id) : null;
  return {
    id: event.id,
    name: event.name,
    status: event.status,
    started_at: event.started_at,
    finished_at: event.finished_at,
    created_at: event.created_at,
    host_name: host?.name ?? null,
    invite_code: canManage ? event.invite_code : undefined,
  };
}

function eventDetail(event, user, canManage) {
  const entries = db.prepare(`
    SELECT e.user_id, u.name, e.stopped_at FROM entries e JOIN users u ON u.id = e.user_id
    WHERE e.event_id = ? ORDER BY u.name
  `).all(event.id);
  const results = withRanks(entries
    .filter((e) => e.stopped_at != null)
    .map((e) => ({ user_id: e.user_id, name: e.name, ms: e.stopped_at - event.started_at }))
    .sort((a, b) => a.ms - b.ms));
  const pending = entries.filter((e) => e.stopped_at == null).map((e) => ({ user_id: e.user_id, name: e.name }));
  const mine = results.find((r) => r.user_id === user.id);

  return {
    event: publicEvent(event, canManage),
    canManage,
    participantCount: entries.length,
    results,
    pending,
    me: user.role === 'shooter' ? { user_id: user.id, stopped: Boolean(mine), ms: mine?.ms ?? null, rank: mine?.rank ?? null } : null,
    now: Date.now(),
  };
}

// ---------- routes ----------

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

// --- accounts ---

route('GET', /^\/api\/me$/, (ctx) => ({ user: ctx.user }));

route('POST', /^\/api\/login$/, (ctx) => {
  checkAuthRate(ctx.ip);
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(ctx.body.username || '').trim());
  if (!user || !verifyPassword(String(ctx.body.password || ''), user.password_hash)) {
    recordAuthFailure(ctx.ip);
    throw new HttpError(401, 'Wrong username or password');
  }
  startSession(ctx, user.id);
  return { user: { id: user.id, username: user.username, name: user.name, role: user.role } };
});

// Anyone can create a shooter account; hosts and admins are created by an admin.
route('POST', /^\/api\/register$/, (ctx) => {
  checkAuthRate(ctx.ip);
  const name = text(ctx.body.name, 'Name', 40);
  const login = username(ctx.body.username);
  const password = newPassword(ctx.body.password);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(login)) {
    recordAuthFailure(ctx.ip);
    throw new HttpError(409, 'That username is taken');
  }
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO users (username, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(login, name, hashPassword(password), 'shooter', Date.now());
  startSession(ctx, Number(lastInsertRowid));
  return { user: { id: Number(lastInsertRowid), username: login, name, role: 'shooter' } };
});

route('POST', /^\/api\/logout$/, (ctx) => {
  if (ctx.rawCookies.pp_session) db.prepare('DELETE FROM sessions WHERE token = ?').run(ctx.rawCookies.pp_session);
  ctx.cookies.push(cookie('pp_session', '', 0));
  return { ok: true };
});

route('POST', /^\/api\/me\/password$/, (ctx) => {
  const me = requireUser(ctx);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(me.id);
  if (!verifyPassword(String(ctx.body.current || ''), user.password_hash)) {
    throw new HttpError(400, 'Current password is wrong');
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword(ctx.body.next)), me.id);
  return { ok: true };
});

// --- events ---

route('GET', /^\/api\/events$/, (ctx) => {
  const user = requireUser(ctx);
  if (isStaff(user)) {
    const sql = `
      SELECT ev.id, ev.name, ev.invite_code, ev.status, ev.started_at, ev.finished_at, ev.created_at,
             u.name AS host_name, (SELECT COUNT(*) FROM entries x WHERE x.event_id = ev.id) AS participant_count
      FROM events ev LEFT JOIN users u ON u.id = ev.host_id
      ${user.role === 'admin' ? '' : 'WHERE ev.host_id = ?'}
      ORDER BY ev.created_at DESC`;
    return { events: user.role === 'admin' ? db.prepare(sql).all() : db.prepare(sql).all(user.id) };
  }
  const rows = db.prepare(`
    SELECT ev.id, ev.name, ev.status, ev.started_at, ev.finished_at, ev.created_at, en.stopped_at,
           (SELECT COUNT(*) FROM entries x WHERE x.event_id = ev.id) AS participant_count,
           CASE WHEN en.stopped_at IS NULL THEN NULL ELSE
             (SELECT COUNT(*) FROM entries x
              WHERE x.event_id = ev.id AND x.stopped_at IS NOT NULL AND x.stopped_at < en.stopped_at) + 1
           END AS rank
    FROM entries en JOIN events ev ON ev.id = en.event_id
    WHERE en.user_id = ? ORDER BY ev.created_at DESC
  `).all(user.id);
  return {
    events: rows.map(({ stopped_at, ...row }) => ({ ...row, ms: stopped_at == null ? null : stopped_at - row.started_at })),
  };
});

route('POST', /^\/api\/events$/, (ctx) => {
  const user = requireUser(ctx, 'admin', 'host');
  const name = text(ctx.body.name, 'Event name', 80);
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO events (name, invite_code, host_id, created_at) VALUES (?, ?, ?, ?)',
  ).run(name, newInviteCode(), user.id, Date.now());
  return { event: { id: Number(lastInsertRowid) } };
});

route('GET', /^\/api\/events\/(\d+)$/, (ctx) => {
  const { event, canManage } = loadEvent(ctx, ctx.params[0]);
  return eventDetail(event, ctx.user, canManage);
});

route('POST', /^\/api\/events\/(\d+)\/start$/, (ctx) => {
  const event = loadManagedEvent(ctx, ctx.params[0]);
  if (event.status !== 'waiting') throw new HttpError(409, 'This event has already started');
  if (!db.prepare('SELECT 1 FROM entries WHERE event_id = ?').get(event.id)) {
    throw new HttpError(409, 'Wait for at least one shooter to join');
  }
  const startedAt = Date.now();
  db.prepare(`UPDATE events SET status = 'running', started_at = ? WHERE id = ?`).run(startedAt, event.id);
  return eventDetail({ ...event, status: 'running', started_at: startedAt }, ctx.user, true);
});

route('POST', /^\/api\/events\/(\d+)\/finish$/, (ctx) => {
  const event = loadManagedEvent(ctx, ctx.params[0]);
  if (event.status !== 'running') throw new HttpError(409, 'Only a running event can be ended');
  const finishedAt = Date.now();
  db.prepare(`UPDATE events SET status = 'finished', finished_at = ? WHERE id = ?`).run(finishedAt, event.id);
  return eventDetail({ ...event, status: 'finished', finished_at: finishedAt }, ctx.user, true);
});

// Undo a shooter's stop (e.g. pressed by accident): their timer resumes from the shared start.
route('POST', /^\/api\/events\/(\d+)\/clear$/, (ctx) => {
  const event = loadManagedEvent(ctx, ctx.params[0]);
  if (event.status !== 'running') throw new HttpError(409, 'Times can only be cleared while the event is running');
  db.prepare('UPDATE entries SET stopped_at = NULL WHERE event_id = ? AND user_id = ?').run(event.id, Number(ctx.body.user_id));
  return eventDetail(event, ctx.user, true);
});

route('DELETE', /^\/api\/events\/(\d+)$/, (ctx) => {
  const event = loadManagedEvent(ctx, ctx.params[0]);
  db.prepare('DELETE FROM events WHERE id = ?').run(event.id);
  return { ok: true };
});

route('POST', /^\/api\/join$/, (ctx) => {
  const user = requireUser(ctx, 'shooter');
  const code = String(ctx.body.code || '').trim().toUpperCase();
  const event = db.prepare('SELECT * FROM events WHERE invite_code = ?').get(code);
  if (!event) throw new HttpError(404, 'No event with that invite code');
  if (db.prepare('SELECT 1 FROM entries WHERE event_id = ? AND user_id = ?').get(event.id, user.id)) {
    return { event_id: event.id };
  }
  if (event.status !== 'waiting') throw new HttpError(409, 'This event has already started');
  db.prepare('INSERT INTO entries (event_id, user_id, joined_at) VALUES (?, ?, ?)').run(event.id, user.id, Date.now());
  return { event_id: event.id };
});

route('POST', /^\/api\/events\/(\d+)\/stop$/, (ctx) => {
  requireUser(ctx, 'shooter');
  const { event, entry } = loadEvent(ctx, ctx.params[0]);
  if (event.status !== 'running') throw new HttpError(409, event.status === 'waiting' ? 'The event hasn’t started yet' : 'This event has ended');
  if (entry.stopped_at != null) throw new HttpError(409, 'Your time is already recorded');
  db.prepare('UPDATE entries SET stopped_at = ? WHERE event_id = ? AND user_id = ? AND stopped_at IS NULL')
    .run(Date.now(), event.id, ctx.user.id);
  return eventDetail(event, ctx.user, false);
});

// --- users (admin) ---

route('GET', /^\/api\/users$/, (ctx) => {
  requireUser(ctx, 'admin');
  return {
    users: db.prepare(`
      SELECT id, username, name, role, created_at FROM users
      ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'host' THEN 1 ELSE 2 END, name
    `).all(),
  };
});

route('POST', /^\/api\/users$/, (ctx) => {
  requireUser(ctx, 'admin');
  const login = username(ctx.body.username);
  const name = text(ctx.body.name, 'Name', 40);
  const password = newPassword(ctx.body.password);
  const role = ['admin', 'host', 'shooter'].includes(ctx.body.role) ? ctx.body.role : 'host';
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(login)) {
    throw new HttpError(409, 'That username is taken');
  }
  db.prepare('INSERT INTO users (username, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(login, name, hashPassword(password), role, Date.now());
  return { ok: true };
});

route('DELETE', /^\/api\/users\/(\d+)$/, (ctx) => {
  const admin = requireUser(ctx, 'admin');
  const id = Number(ctx.params[0]);
  if (id === admin.id) throw new HttpError(400, "You can't delete your own account");
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return { ok: true };
});

// ---------- server ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

async function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Not found');
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

async function handleRequest(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    return serveStatic(req, res, pathname);
  }

  const ctx = { cookies: [], ip: req.socket.remoteAddress };
  try {
    const match = routes.find((r) => r.method === req.method && r.pattern.test(pathname));
    if (!match) throw new HttpError(404, 'Not found');
    ctx.params = pathname.match(match.pattern).slice(1);
    ctx.rawCookies = parseCookies(req);
    ctx.user = loadUser(ctx.rawCookies);
    ctx.body = await readJson(req);
    const result = await match.handler(ctx);
    if (ctx.cookies.length) res.setHeader('Set-Cookie', ctx.cookies);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(result));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (ctx.cookies.length) res.setHeader('Set-Cookie', ctx.cookies);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: status === 500 ? 'Something went wrong' : err.message }));
  }
}

// ---------- TLS ----------

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && !i.internal && i.family === 'IPv4')
    .map((i) => i.address);
}

// The names a self-signed certificate must cover: TLS_HOSTS when set, otherwise this machine's
// hostname and current LAN IPs.
function certHosts() {
  const hosts = ['localhost', '127.0.0.1'];
  if (TLS_HOSTS.length) {
    hosts.push(...TLS_HOSTS);
  } else {
    const hostname = os.hostname();
    if (/^[A-Za-z0-9.-]+$/.test(hostname)) {
      hosts.push(hostname);
      if (!hostname.endsWith('.local')) hosts.push(`${hostname}.local`);
    }
    hosts.push(...lanAddresses());
  }
  return [...new Set(hosts)].map((host) => (net.isIP(host) ? { type: 'IP', host } : { type: 'DNS', host }));
}

// Loads TLS_CERT/TLS_KEY if given, otherwise a self-signed certificate that is (re)generated with
// OpenSSL whenever it is missing, about to expire, or doesn't cover the names from certHosts().
function loadTls() {
  if (process.env.TLS_CERT || process.env.TLS_KEY) {
    if (!process.env.TLS_CERT || !process.env.TLS_KEY) {
      console.error('Set both TLS_CERT and TLS_KEY, or neither.');
      process.exit(1);
    }
    return { cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) };
  }

  const certFile = path.join(TLS_DIR, 'cert.pem');
  const keyFile = path.join(TLS_DIR, 'key.pem');
  const hosts = certHosts();

  if (existsSync(certFile) && existsSync(keyFile)) {
    const cert = new crypto.X509Certificate(readFileSync(certFile));
    const covered = new Set((cert.subjectAltName || '').split(', '));
    const fresh = new Date(cert.validTo).getTime() > Date.now() + 7 * 24 * 3600 * 1000;
    if (fresh && hosts.every(({ type, host }) => covered.has(type === 'IP' ? `IP Address:${host}` : `DNS:${host}`))) {
      return { cert: readFileSync(certFile), key: readFileSync(keyFile) };
    }
  }

  mkdirSync(TLS_DIR, { recursive: true });
  const san = hosts.map(({ type, host }) => `${type}:${host}`).join(',');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
      '-subj', '/CN=Pellet Pace', '-addext', `subjectAltName=${san}`,
      '-keyout', keyFile, '-out', certFile,
    ], { stdio: 'pipe' });
  } catch (err) {
    console.error(
      'Could not create a self-signed certificate. Install OpenSSL, set TLS_CERT and TLS_KEY, or run with HTTPS=0.\n'
        + (err.stderr?.toString() || err.message),
    );
    process.exit(1);
  }
  chmodSync(keyFile, 0o600);
  console.log(`Created self-signed certificate in ${TLS_DIR} for ${san}`);
  return { cert: readFileSync(certFile), key: readFileSync(keyFile) };
}

// ---------- listen ----------

function printUrls(scheme) {
  console.log('Pellet Pace running at:');
  for (const host of ['localhost', ...(TLS_HOSTS.length ? TLS_HOSTS : lanAddresses())]) {
    console.log(`  ${scheme}://${host.includes(':') ? `[${host}]` : host}:${PORT}`);
  }
}

// Close the database cleanly on `docker stop` / Ctrl+C (Node as PID 1 ignores SIGTERM otherwise).
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    db.close();
    process.exit(0);
  });
}

if (USE_HTTPS) {
  const secureServer = https.createServer(loadTls(), handleRequest);
  // Anyone who types http:// on the same port is redirected to https:// instead of seeing garbage.
  const redirectServer = http.createServer((req, res) => {
    res.writeHead(301, { Location: `https://${req.headers.host || `localhost:${PORT}`}${req.url}` });
    res.end();
  });
  net.createServer((socket) => {
    socket.once('data', (chunk) => {
      socket.pause();
      socket.unshift(chunk);
      // 0x16 is the first byte of a TLS handshake record.
      (chunk[0] === 0x16 ? secureServer : redirectServer).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
    socket.on('error', () => socket.destroy());
  }).listen(PORT, () => {
    printUrls('https');
    console.log('The certificate is self-signed, so browsers will show a warning the first time — choose to proceed.');
  });
} else {
  http.createServer(handleRequest).listen(PORT, () => printUrls('http'));
}
