# Development guide

- [Quick start](#quick-start)
- [Project layout](#project-layout)
- [Architecture](#architecture)
- [Data model](#data-model)
- [HTTP API](#http-api)
- [Front end](#front-end)
- [Security notes](#security-notes)
- [Common changes](#common-changes)
- [Testing](#testing)

## Quick start

```sh
node --version        # 22.13+ (needs built-in node:sqlite)
npm start             # https://localhost:3000, data in ./data
```

There is nothing to install and no build step. Edit a file and restart the server. Static files are
served with `Cache-Control: no-cache`, so a browser reload picks up front-end changes.

Useful variations:

```sh
HTTPS=0 npm start                          # plain http, no certificate warnings while developing
DB_PATH=/tmp/pp-test.db npm start          # throwaway database
ADMIN_PASSWORD=devpassword npm start       # known admin password on a fresh database
rm -rf data                                # reset everything (database + certificate)
```

## Project layout

```
server.js            Entire back end: schema/migrations, auth, API routes, static files, TLS, listener
public/index.html    Page shell (top bar, #app, toast)
public/app.js        Entire front end: hash router, views, polling, helpers
public/styles.css    Styles, light and dark themes via CSS custom properties
public/icon.svg      Logo and favicon
Dockerfile           node:22-alpine + openssl, runs as `node`, data in /app/data
docker-compose.yml   Deployment, driven by .env (see .env.example)
docs/                User, deployment and development docs
```

## Architecture

```
 phone / tablet (browser)                           server.js (one Node process)
 ┌───────────────────────┐   GET /api/events/:id    ┌───────────────────────────┐
 │ app.js                │ ───── every 1.5 s ─────▶ │ router → handler          │
 │  hash router + views  │ ◀──── JSON + now ─────── │   ↕ DatabaseSync (sync)   │
 │  50 ms clock ticker   │   POST start/stop/...    │ SQLite file (WAL)         │
 └───────────────────────┘ ──────────────────────▶  └───────────────────────────┘
```

**Server (`server.js`)**, top to bottom:

1. **Database.** Opens `DB_PATH` with `node:sqlite` (synchronous), WAL mode, foreign keys on. Runs
   migrations keyed on `PRAGMA user_version` (current `SCHEMA_VERSION = 2`). Creates the first admin if none exists.
   Prunes expired sessions.
2. **HTTP helpers.** `HttpError(status, message)`, cookie parsing, `readJson` (requires
   `Content-Type: application/json`, 16 KB limit), and validators `text()`, `username()`, `newPassword()`.
3. **Auth.** scrypt password hashes (`salt:hash` hex). Random 32-byte session tokens are stored in `sessions` and
   sent as the `pp_session` cookie (HttpOnly, SameSite=Lax, Secure when HTTPS, 14 days). An in-memory
   rate limit allows 10 failed logins/sign-ups per IP per 15 minutes.
4. **Access control.** `requireUser(ctx, ...roles)`, `loadEvent` (admin: any event; host: own events;
   shooter: events they entered, otherwise 404) and `loadManagedEvent` (must be able to manage).
5. **Leaderboard.** `eventDetail()` builds the full event payload. `withRanks()` gives equal times equal rank.
6. **Routes.** `route(method, regex, handler)`. A handler receives `ctx`
   (`user`, `body`, `params`, `ip`, `cookies` to set) and returns a JSON-serialisable object, or throws `HttpError`.
   To send a file instead, it returns `new Download(filename, contentType, body)` (used by the CSV export).
7. **Server.** `/api/*` goes to the router. Other paths are static files from `public/` (GET/HEAD only, path-traversal
   checked). Every response sets `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`.
8. **TLS.** `loadTls()` uses `TLS_CERT`/`TLS_KEY` or a self-signed certificate made with the `openssl` CLI.
   With HTTPS on, a raw `net` server checks the first byte of each connection. A TLS handshake (`0x16`)
   goes to the HTTPS server. Anything else goes to a server that answers with a 301 redirect to `https://`.

**Timing model.** All timestamps are server `Date.now()` in milliseconds. `start` sets `events.started_at`.
`stop` sets `entries.stopped_at`. A result is `stopped_at - started_at`. Every event payload includes
`now`. The client keeps `clockOffset = serverNow - Date.now()` so live clocks follow the server, whatever the device's clock says.

**Event lifecycle**

```
 waiting ──start (≥1 entry)──▶ running ──finish──▶ finished
   ▲ join allowed only here      │ stop (once per shooter)
                                 │ clear (host undoes a stop)
```

## Data model

Schema version 2 (`PRAGMA user_version = 2`):

| Table | Columns | Notes |
| --- | --- | --- |
| `users` | `id`, `username` (UNIQUE, NOCASE), `name`, `password_hash`, `role` (`admin`/`host`/`shooter`), `created_at` | |
| `sessions` | `token` (PK), `user_id` → users (CASCADE), `created_at` | Expire 14 days after `created_at`. |
| `events` | `id`, `name`, `invite_code` (UNIQUE), `host_id` → users (SET NULL), `status` (`waiting`/`running`/`finished`), `started_at`, `finished_at`, `created_at` | |
| `entries` | (`event_id`, `user_id`) PK, `joined_at`, `stopped_at` | One row per shooter per event. CASCADE on both. Index `entries_by_user`. |

Databases upgraded from version 1 may also contain the unused `games`, `players` and `runs` tables.

Invite codes are 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`. The alphabet leaves out the look-alike characters 0/O, 1/I/L.

## HTTP API

Every endpoint is under `/api`, takes and returns JSON, and uses the session cookie. Request bodies
**must** be sent with `Content-Type: application/json`, even when empty. Errors are returned as `{ "error": "message" }`
with a 4xx status. Unexpected failures return 500 with a generic message, and the stack trace goes to the server log.

| Method & path | Who | Body | Returns |
| --- | --- | --- | --- |
| `GET /me` | anyone | — | `{ user }` or `{ user: null }` |
| `POST /login` | anyone | `username`, `password` | `{ user }` + cookie |
| `POST /register` | anyone | `name`, `username`, `password` | `{ user }` (shooter) + cookie |
| `POST /logout` | anyone | — | `{ ok }` |
| `POST /me/password` | signed in | `current`, `next` | `{ ok }` |
| `GET /events` | signed in | — | Staff: `{ events }` they manage (all, for admin), with `invite_code`, `host_name`, `participant_count`. Shooter: `{ events }` they joined, with `ms`, `rank`. |
| `POST /events` | host, admin | `name` (≤ 80) | `{ event: { id } }` |
| `GET /events/:id` | manager or entrant | — | Event detail (below) |
| `POST /events/:id/start` | manager | — | Event detail. 409 unless `waiting` with at least one entry. |
| `POST /events/:id/finish` | manager | — | Event detail. 409 unless `running`. |
| `POST /events/:id/clear` | manager | `user_id` | Event detail. 409 unless `running`. |
| `GET /events/:id/results.csv` | manager | — | CSV download (`Content-Disposition: attachment`): Rank, Shooter, Time, Time (ms), Gap, Status. UTF-8 with BOM, CRLF line endings. Names starting with `= + - @` get a `'` prefix so spreadsheets don't run them as formulas. |
| `DELETE /events/:id` | manager | — | `{ ok }` |
| `POST /join` | shooter | `code` | `{ event_id }`. Repeat joins are allowed. 409 once the event has started. |
| `POST /events/:id/stop` | entrant | — | Event detail. 409 if not running or already stopped. |
| `GET /users` | admin | — | `{ users }` |
| `POST /users` | admin | `name`, `username`, `password`, `role` | `{ ok }` |
| `DELETE /users/:id` | admin | — | `{ ok }`. An admin can't delete their own account. |
| `POST /users/:id/password` | admin | `password` | `{ ok }`. Sets the password and deletes all of that user's sessions. 400 for your own account (use `/me/password`). |
| `GET /stats` | admin | — | `{ users, events, entries, shooters, staff }` (below) |

*Manager* means an admin, or the host who created the event.

**Event detail** payload:

```jsonc
{
  "event": { "id", "name", "status", "started_at", "finished_at", "created_at", "host_name",
             "invite_code" /* managers only */ },
  "canManage": true,
  "participantCount": 12,
  "results": [{ "user_id", "name", "ms", "rank" }],   // stopped, fastest first
  "pending": [{ "user_id", "name" }],                 // not stopped (DNF once finished)
  "me": { "user_id", "stopped", "ms", "rank" },       // shooters only, else null
  "now": 1760000000000                                // server clock
}
```

**Stats** payload. Ranks use the same rule as leaderboards (ties share a rank). `wins`/`podiums` count only
finished events:

```jsonc
{
  "users":   { "admin": 1, "host": 2, "shooter": 30 },
  "events":  { "waiting": 0, "running": 1, "finished": 12 },
  "entries": { "total": 240, "finished": 228, "in_finished_events": 225, "dnf": 9 },
  "shooters": [{ "id", "name", "username", "created_at", "events", "finished", "dnf", "wins", "podiums", "last_event_at" }],
  "staff":    [{ "id", "name", "username", "role", "events", "finished", "entries", "last_event_at" }]
}
```

`last_event_at` is the latest join time for shooters and the latest event creation time for staff. It is `null` if there are none.

Quick manual check with curl:

```sh
B=https://localhost:3000/api; J='Content-Type: application/json'
curl -sk -c jar -H "$J" -d '{"username":"admin","password":"…"}' $B/login
curl -sk -b jar -H "$J" -d '{"name":"Test"}' $B/events
curl -sk -b jar $B/events
```

## Front end

`public/app.js` is a single ES module with no framework.

- **`h(tag, attrs, ...children)`** builds DOM nodes. Strings become **text nodes**, so user-supplied names
  are never parsed as HTML. Attributes starting with `on` become event listeners.
- **`api(method, url, body)`** wraps `fetch`, sends JSON, and throws an `Error` with the server's message and `.status`.
- **Routing.** Routes are in the URL hash: `#/login`, `#/register`, `#/join/CODE`, `#/home` (shooter),
  `#/events` (staff), `#/event/ID`, `#/users` and `#/stats` (admin). `router()` runs on every `hashchange`, reloads `/api/me`,
  runs the previous view's `cleanups` and renders the new view.
- **`mounter()`** guards against out-of-order renders. A view that resolves after the user has navigated away does nothing.
- **`poll(fn, ms)`** registers an interval that is cleared on navigation. The event view polls every 1.5 s.
  It re-renders only when the payload (minus `now`) changes, and never while an action is in flight
  or a two-tap button is armed. This stops buttons being swapped out under a finger.
- **Live clocks.** Any element with `data-start` is updated every 50 ms from `serverNow()`.
- **`confirmButton`** is the two-tap pattern used for destructive or irreversible actions.
- **`pendingCode`** keeps an invite code in `sessionStorage` while a signed-out user signs in.
- **Styles.** Use the CSS custom properties in `:root`. Dark mode redefines them under
  `@media (prefers-color-scheme: dark)`.

## Security notes

- **CSRF.** Every state-changing request needs a JSON content type. Browsers can't send that cross-site
  without a CORS preflight, and the server never answers one. `SameSite=Lax` cookies add a second layer.
- **XSS.** Build DOM with `h()` and text nodes. Don't use `innerHTML` with data.
- **Authorisation.** Every route checks permissions on the server through `requireUser` / `loadEvent` /
  `loadManagedEvent`. Events a user can't see return 404, not 403, so their existence isn't leaked.
- **Rate limiting** is in-memory and per socket address. It resets on restart and doesn't understand proxies.
- **CSV export** puts a `'` before names that start with `= + - @`, so a hostile name can't run as a spreadsheet formula.
- **Not present:** self-service password reset (only admins can reset passwords), CSP header, audit log, account lockout per username.

## Common changes

**Add an API route.** Add a `route('METHOD', /^\/api\/...$/, (ctx) => { ... })` in the right section of
`server.js`. Start with `requireUser` or `loadEvent`/`loadManagedEvent`. Validate input with
`text()`/`username()`/`newPassword()` or explicit checks. Throw `HttpError` for client errors. Return a plain object.

**Change the schema.** Don't edit the existing version-2 block. Bump `SCHEMA_VERSION` and add a new
`if (user_version < 3)` step after it, inside a transaction, that brings a version-2 database up to date and sets
`PRAGMA user_version = 3`. Make sure a fresh database (which runs every step) and an existing one both
end up identical. Test both cases.

**Add a view.** Write an `async function viewX()` that calls `mounter()`, fetches data and mounts one node
tree. Add it to `router()`, plus a top-bar link in `renderTopbar()` if needed.

**Add configuration.** Read it from `process.env` at the top of `server.js`. Then document it in
`docs/deployment.md` (configuration reference), `README.md`, and, if Docker users need it,
`docker-compose.yml` and `.env.example`.

## Testing

There is no automated test suite yet. Before committing, check by hand:

1. A fresh database starts and prints the admin password (`DB_PATH=/tmp/x.db`).
2. Sign up as a shooter in one browser and sign in as admin/host in another (or a private window).
3. Create an event, join it by code **and** by link (the link while signed out), and start it.
4. Stop as the shooter, clear the time as the host, stop again, then end the event and check that DNF is shown.
5. Check the shooter's **My events** history, **Export CSV** as the host, and the admin's **Users**
   (including **Reset a password**) and **Stats** pages.
6. Check the layout at phone width in both light and dark mode.
7. For Docker changes: `docker compose up -d --build`, check the health status in `docker compose ps`,
   then restart and confirm the data persisted.
