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
- [Docker images and releases](#docker-images-and-releases)

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
public/app.js        Entire front end: hash router, views, live updates, helpers
public/styles.css    Styles, light and dark themes via CSS custom properties
public/icon.svg      Logo and favicon
Dockerfile           node:24-alpine + openssl + tzdata, runs as `node`, data in /app/data
docker-compose.yml   Deployment from the Docker Hub image, driven by .env (see .env.example)
.github/workflows/   docker.yml: builds amd64 + arm64 images and pushes them to Docker Hub
docs/                User, deployment and development docs
```

## Architecture

```
 phone / tablet (browser)                                 server.js (one Node process)
 ┌───────────────────────┐  GET /api/events/:id/stream    ┌───────────────────────────┐
 │ app.js                │ ◀═══ pushed JSON + now ═══════ │ router → handler          │
 │  hash router + views  │      (Server-Sent Events)      │   ↕ DatabaseSync (sync)   │
 │  50 ms clock ticker   │  POST start/stop/... ────────▶ │ SQLite file (WAL)         │
 └───────────────────────┘  (each change → notify(event)) └───────────────────────────┘
```

**Server (`server.js`)**, top to bottom:

1. **Database.** Opens `DB_PATH` with `node:sqlite` (synchronous), WAL mode, foreign keys on. Runs
   migrations keyed on `PRAGMA user_version` (current `SCHEMA_VERSION = 3`). Creates the first admin if none exists.
2. **HTTP helpers.** `HttpError(status, message)`, cookie parsing, `readJson` (requires
   `Content-Type: application/json`, 16 KB limit), and validators `text()`, `username()`, `newPassword()`.
3. **Auth.** scrypt password hashes (`salt:hash` hex), computed asynchronously so hashing doesn't stall other requests.
   Signing in with an unknown username checks a dummy hash, so it takes as long as a wrong password. Random 32-byte
   session tokens go to the browser as the `pp_session` cookie (HttpOnly, SameSite=Lax, Secure when HTTPS, 14 days);
   only their SHA-256 is stored in `sessions`. An in-memory rate limit allows 10 failed logins/sign-ups per IP per
   15 minutes.
4. **Access control.** `requireUser(ctx, ...roles)`, `loadEvent` (admin: any event; host: own events;
   anyone: events they have an entry in, otherwise 404) and `loadManagedEvent` (must be able to manage).
   Roles are cumulative (admin ⊇ host ⊇ shooter): anyone can join an event and press STOP. Shooter features depend on
   having an entry, not on the role.
5. **Leaderboard.** `eventDetail()` builds the full event payload. `withRanks()` gives equal times equal rank.
6. **Routes.** `route(method, regex, handler)`. A handler receives `ctx`
   (`user`, `body`, `params`, `ip`, `cookies` to set) and returns a JSON-serialisable object, or throws `HttpError`.
   To send a file instead, it returns `new Download(filename, contentType, body)` (used by the CSV export). To keep
   the response open as a live stream, it returns `new EventStream(eventId, userId)`. `ctx.query` holds the URL's
   search parameters.
7. **Live updates.** `GET /api/events/:id/stream` is a Server-Sent Events stream. Every route that changes an event
   calls `notify(eventId)`, which sends each subscriber its own `eventDetail()`. Changes to users call `notifyAll()`.
   A deleted event, or lost access, sends `event: gone` and closes the stream. A `: ping` comment every 25 s keeps
   idle streams open.
8. **Server.** `/api/*` goes to the router. Other paths are static files from `public/` (GET/HEAD only, path-traversal
   checked), cached in memory with a gzipped copy and an ETag, so browsers revalidate and get 304s. Every response
   sets `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY` and a strict
   `Content-Security-Policy`. The hash of the inline theme script in `index.html` is computed at start-up.
9. **Maintenance.** Runs at start-up and every 10 minutes. It prunes expired sessions and old rate-limit entries,
   and ends events that have been running longer than `AUTO_FINISH_HOURS` (default 24, `0` = off).
10. **TLS.** `loadTls()` uses `TLS_CERT`/`TLS_KEY` (checked by `loadCustomTls()`: readable, PEM, key matches, logs the expiry)
   or `TLS_DIR/cert.pem` + `key.pem`. Files there are only regenerated (with the `openssl` CLI) if the app made them itself
   (self-issued, `CN=Pellet Pace`). An operator's certificate placed there goes through `loadCustomTls()` and is never overwritten.
   With HTTPS on, a raw `net` server checks the first byte of each connection. A TLS handshake (`0x16`)
   goes to the HTTPS server. Anything else goes to a server that answers with a 301 redirect to `https://`.
   A connection that sends nothing within 10 s is closed.

**Timing model.** Event times come from `eventClock()`, the server's **monotonic** clock (`performance.now()`)
anchored to the wall clock at start-up, in milliseconds. A clock change or NTP step during an event can't shift
results. `start` sets `events.started_at`, `stop` sets `entries.stopped_at` and `finish` sets `events.finished_at`.
A result is `stopped_at - started_at`. Calendar fields (`created_at`, `joined_at`) use `Date.now()`. Every event
payload includes `now` from `eventClock()`. The client keeps `clockOffset = serverNow - Date.now()` so live clocks
follow the server, whatever the device's clock says.

**Event lifecycle**

```
 waiting ──start (≥1 entry)──▶ running ──finish──▶ finished
   ▲ join allowed only here      │ stop (once per shooter)
                                 │ clear (host undoes a stop)
```

## Data model

Schema version 3 (`PRAGMA user_version = 3`):

| Table | Columns | Notes |
| --- | --- | --- |
| `users` | `id`, `username` (UNIQUE, NOCASE), `name`, `password_hash`, `role` (`admin`/`host`/`shooter`), `created_at` | |
| `sessions` | `token` (PK: SHA-256 hex of the cookie value), `user_id` → users (CASCADE), `created_at` | Expire 14 days after `created_at`. Index `sessions_by_user`. Version 3 cleared all sessions once, when tokens started being stored hashed. |
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
| `GET /events` | signed in | — | `{ events, joined, next }`. Lists are paged by 20, newest first; `next.events` / `next.joined` are cursors for `/events/history` (or `null`). `joined`: events the user has an entry in, with `ms`, `rank` (every role). `events`: for staff, the events they manage (all, for admin) with `invite_code`, `host_name`, `participant_count`; for shooters, the same as `joined`. |
| `GET /events/history` | signed in | — | Next page: `?list=managed` (finished events you manage; staff only) or `?list=joined`, `&before=<cursor>`. Returns `{ events, next }`. |
| `POST /events` | host, admin | `name` (≤ 80) | `{ event: { id } }` |
| `GET /events/:id` | manager or entrant | — | Event detail (below) |
| `GET /events/:id/stream` | manager or entrant | — | `text/event-stream`: your event detail now and after every change; `event: gone` when it's deleted or you lose access. |
| `POST /events/:id/start` | manager | — | Event detail. 409 unless `waiting` with at least one entry. |
| `POST /events/:id/finish` | manager | — | Event detail. 409 unless `running`. |
| `POST /events/:id/clear` | manager | `user_id` | Event detail. 409 unless `running`. |
| `GET /events/:id/results.csv` | manager | — | CSV download (`Content-Disposition: attachment`): Rank, Shooter, Time, Time (ms), Gap, Status. UTF-8 with BOM, CRLF line endings. Names starting with `= + - @` get a `'` prefix so spreadsheets don't run them as formulas. |
| `DELETE /events/:id` | manager | — | `{ ok }` |
| `POST /join` | signed in (any role) | `code` | `{ event_id }`. Repeat joins are allowed. 409 once the event has started. |
| `POST /events/:id/participate` | manager | `join` (`true`/`false`) | Event detail. Joins or leaves the event as a shooter without the invite code. 409 once started. |
| `POST /events/:id/stop` | entrant | — | Event detail. 403 if you have no entry, 409 if not running or already stopped. |
| `GET /users` | admin | — | `{ users }` |
| `POST /users` | admin | `name`, `username`, `password`, `role` | `{ ok }` |
| `DELETE /users/:id` | admin | — | `{ ok }`. 400 for your own account, 403 for another admin. |
| `POST /users/:id/role` | admin | `role` (`admin`/`host`/`shooter`) | `{ ok }`. 400 for your own account or an unknown role, 403 if the target is an admin (admins can promote, not demote). Applies on the user's next request, because `loadUser` reads the role each time. Entries and hosted events are kept. |
| `POST /users/:id/password` | admin | `password` | `{ ok }`. Sets the password and deletes all of that user's sessions. 400 for your own account (use `/me/password`), 403 for another admin. |
| `GET /stats` | admin | — | `{ users, events, entries, shooters, next_offset, staff }` (below). `shooters` is the first 20. |
| `GET /stats/shooters` | admin | — | `?offset=N`: the next 20 shooters, `{ shooters, next_offset }` (`null` at the end). |

*Manager* means an admin, or the host who created the event.

**Event detail** payload:

```jsonc
{
  "event": { "id", "name", "status", "started_at", "finished_at", "created_at", "host_name",
             "invite_code" /* managers only */ },
  "canManage": true,
  "canParticipate": false,                            // manager, and the event is still waiting
  "participantCount": 12,
  "results": [{ "user_id", "name", "ms", "rank" }],   // stopped, fastest first
  "pending": [{ "user_id", "name" }],                 // not stopped (DNF once finished)
  "me": { "user_id", "stopped", "ms", "rank" },       // anyone with an entry (incl. the host), else null
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
- **`poll(fn, ms)`** registers an interval that is cleared on navigation.
- **Event view.** It opens an `EventSource` on `/api/events/:id/stream` and also polls every 15 s as a safety net.
  Everything goes through `apply()`, which re-renders only when the payload (minus `now`) changes. While an
  action is in flight or a two-tap button is armed, the render is deferred and done as soon as possible, so buttons
  aren't swapped out under a finger. `event: gone` sends the user home. While the device takes part (shooting or
  managing an event that isn't finished), `keepAwake()` holds a Screen Wake Lock and re-takes it when the page is
  shown again.
- **Announcements.** `announce(text)` writes to the hidden `#announcer` live region. The event view announces the
  start, the end and your own time. `#app` is deliberately not a live region, because it re-renders constantly.
- **Paging.** `moreButton(next, fetchPage, append)` adds "Show more" under paged lists (previous events, My events,
  Stats shooters) and removes itself when the cursor runs out.
- **Top bar.** At 520px and narrower (`compactTopbar` media query), the navigation collapses into a ☰ Menu
  (`navMenu()`). It closes when a link is tapped or on a tap outside it.
- **Tables on phones.** Add `stack-mobile` to a `.board` table and a `data-label` to each cell, and rows become cards at
  600px and narrower. `cell-main` spans the card as its title; `cell-action` holds a row button.
- **Live clocks.** Any element with `data-start` is updated every 50 ms from `serverNow()`.
- **`confirmButton`** is the two-tap pattern used for destructive or irreversible actions.
- **`pendingCode`** keeps an invite code in `sessionStorage` while a signed-out user signs in.
- **Styles.** No inline `style` attributes: the Content Security Policy blocks them, so use classes.
  Use the CSS custom properties in `:root`. The dark theme redefines them twice:
  under `@media (prefers-color-scheme: dark)` for `:root:not([data-theme="light"])` (Auto), and for
  `:root[data-theme="dark"]` (chosen Dark). Keep both blocks identical.
- **Theme.** The top-bar button cycles Auto → Light → Dark (`setTheme()` in `app.js`). It sets `data-theme` on `<html>`
  and stores the choice in `localStorage` as `pp_theme` (removed for Auto). A one-line script in `index.html` applies a
  stored choice before the first paint, so there's no flash of the other theme.

## Security notes

- **CSRF.** Every state-changing request needs a JSON content type. Browsers can't send that cross-site
  without a CORS preflight, and the server never answers one. `SameSite=Lax` cookies add a second layer.
- **XSS.** Build DOM with `h()` and text nodes. Don't use `innerHTML` with data.
- **Content Security Policy** allows only this app's own scripts, styles, images and connections, plus the inline
  theme script by its hash. No inline `style` attributes or `on…=` HTML handlers, and no embedding in frames.
- **Sessions** are stored as SHA-256 hashes, so a database copy or backup can't be used to sign in.
- **Admins** can't change, remove or reset the password of another admin. That's done on the server
  (see docs/deployment.md).
- **Authorisation.** Every route checks permissions on the server through `requireUser` / `loadEvent` /
  `loadManagedEvent`. Events a user can't see return 404, not 403, so their existence isn't leaked.
- **Rate limiting** is in-memory and per socket address. It resets on restart, is pruned every 10 minutes, and doesn't
  understand proxies.
- **CSV export** puts a `'` before names that start with `= + - @`, so a hostile name can't run as a spreadsheet formula.
- **Not present:** self-service password reset (only admins can reset passwords), audit log, account lockout per username.

## Common changes

**Add an API route.** Add a `route('METHOD', /^\/api\/...$/, (ctx) => { ... })` in the right section of
`server.js`. Start with `requireUser` or `loadEvent`/`loadManagedEvent`. Validate input with
`text()`/`username()`/`newPassword()` or explicit checks. Throw `HttpError` for client errors. Return a plain object.

**Change the schema.** Don't edit existing migration steps. Bump `SCHEMA_VERSION` and add a new
`if (user_version < 4)` step after the last one, inside a transaction, that brings a version-3 database up to date and sets
`PRAGMA user_version = 4`. Make sure a fresh database (which runs every step) and an existing one both
end up identical. Test both cases.

**Change an event.** After writing to `events` or `entries`, call `notify(event.id)` so every open screen updates.
After changing users, call `notifyAll()`.

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
   (including **Reset a password** and changing a role) and **Stats** pages.
6. Check the layout at phone width in both light and dark mode.
7. For Docker changes: build locally (`docker build -t m1v1n/pellet-pace:dev .`), run it with
   `PELLET_PACE_TAG=dev docker compose up -d`, check the health status in `docker compose ps`,
   then restart and confirm the data persisted.

## Docker images and releases

`.github/workflows/docker.yml` builds the image for **`linux/amd64`** and **`linux/arm64`** (arm64 under QEMU)
and pushes it to Docker Hub as [`m1v1n/pellet-pace`](https://hub.docker.com/r/m1v1n/pellet-pace).
`docker-compose.yml` pulls that image, so deployments don't need a copy of the source.

| Trigger | Image tags pushed |
| --- | --- |
| Push to `main` | `latest`, `sha-<short commit>` |
| Tag `v1.2.3` | `1.2.3`, `1.2`, `1` |
| Pull request | none: the image is only built, to check it still builds |
| Manual (*Actions → Docker image → Run workflow*) | same as the branch or tag it runs on |

**One-time setup:**

1. On Docker Hub, go to *Account settings → Personal access tokens* and create a token with **Read & Write** access.
2. In the GitHub repository, go to *Settings → Secrets and variables → Actions* and add a secret named
   `DOCKERHUB_TOKEN` with that token.
3. The first push creates the `m1v1n/pellet-pace` repository on Docker Hub. Check its visibility
   (public or private) there. Range machines need `docker login` to pull a private image.

**Making a release:**

```sh
git tag v1.2.0
git push origin v1.2.0
```

Deployments can then pin it with `PELLET_PACE_TAG=1.2.0` (or `1.2`, or `1`) in `.env`.

**Building locally:**

```sh
docker build -t m1v1n/pellet-pace:dev .               # your machine's architecture
PELLET_PACE_TAG=dev docker compose up -d              # run it with the normal compose file
docker buildx build --platform linux/amd64,linux/arm64 .   # check both architectures build
```
