# Deployment

Pellet Pace is a single Node.js process. It serves the web app and a JSON API on one port and keeps
everything in one SQLite file. Phones and tablets on the range reach it over the local network.

- [Requirements](#requirements)
- [Option A: Docker (recommended)](#option-a-docker-recommended)
- [Option B: Node directly](#option-b-node-directly)
- [Configuration reference](#configuration-reference)
- [HTTPS and certificates](#https-and-certificates)
- [Running behind a reverse proxy](#running-behind-a-reverse-proxy)
- [Backups and restore](#backups-and-restore)
- [Updating](#updating)
- [Operations and troubleshooting](#operations-and-troubleshooting)

## Requirements

- One machine on the same network as the shooters' devices (a range PC, a mini PC or a Raspberry Pi is enough).
- **Docker** with Compose, **or** **Node.js 22.13 or later** (it needs the built-in `node:sqlite`).
- **OpenSSL** on the `PATH` when the app creates its own certificate (the default). The Docker image includes it.
- A fixed LAN address for the machine. Reserve one in the router (DHCP reservation), because the certificate
  and the links people bookmark use that address.
- Inbound TCP on the chosen port (default `3000`) allowed by the host firewall.

## Option A: Docker (recommended)

```sh
cp .env.example .env          # set TLS_HOSTS (and optionally ADMIN_PASSWORD)
docker compose up -d --build
docker compose logs           # first start: shows the admin username and password
```

Then open `https://<TLS_HOSTS address>:3000` on any device.

What the Compose setup does:

| Item | Value |
| --- | --- |
| Container / image | `pellet-pace` / `pellet-pace:latest`, built from the local `Dockerfile` (`node:22-alpine` + `openssl`) |
| Port | `${HOST_PORT:-3000}` on the host → `3000` in the container |
| Data | `/app/data` in the container (database `pellet-pace.db`, certificate in `tls/`) |
| Data storage | Docker volume `pellet-pace-data`, or the host folder in `DATA_DIR` |
| User | Runs as the unprivileged `node` user, or `PUID:PGID` from `.env` |
| Restart | `unless-stopped`, so it comes back after a reboot |
| Health check | `GET /api/me` every 30 s |

### `.env` settings

| Variable | Needed? | Purpose |
| --- | --- | --- |
| `TLS_HOSTS` | **Yes** | Comma-separated IPs/hostnames devices use to reach this machine, e.g. `192.168.1.20,range-pc.local`. Inside a container the app can't see the host's LAN addresses, so it can't detect them. |
| `HOST_PORT` | No | Host port to publish (default `3000`). |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | No | Used **only** when the database has no admin yet. If the password is empty, a random one is printed in the logs. |
| `DATA_DIR` | No | Host folder for the data instead of the named volume. Create the folder first. |
| `PUID` / `PGID` | With `DATA_DIR` | The folder owner's ids (`id -u`, `id -g`), so the container can write there. |
| `HTTPS` | No | Set to `0` behind a TLS-terminating proxy (see below). |

### Where the data lives

The image holds only code. The database and certificate stay in the volume (or `DATA_DIR`), so they
survive `docker compose up --build`, `docker compose down` and image rebuilds.
**`docker compose down -v` deletes the volume and all data.**

The repository's own `./data` folder is used only by `npm start` and is never copied into the image
(see `.dockerignore`).

## Option B: Node directly

```sh
node --version                # must be 22.13 or newer
npm start                     # no npm install needed: there are no dependencies
```

Data goes to `./data/pellet-pace.db` and `./data/tls/` unless `DB_PATH` / `TLS_DIR` say otherwise.
Without `TLS_HOSTS` the certificate covers `localhost`, the machine's hostname, `<hostname>.local`
and every current LAN IPv4 address.

To keep it running, use a process manager. For example, a systemd unit:

```ini
# /etc/systemd/system/pellet-pace.service
[Unit]
Description=Pellet Pace
After=network-online.target
Wants=network-online.target

[Service]
User=pellet
WorkingDirectory=/opt/pellet-pace
Environment=DB_PATH=/var/lib/pellet-pace/pellet-pace.db
ExecStart=/usr/bin/node --no-warnings=ExperimentalWarning server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now pellet-pace
journalctl -u pellet-pace     # first start: admin password
```

The `User` must be able to write to the folder containing `DB_PATH`.

## Configuration reference

All configuration is through environment variables. Nothing is read from a config file.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listening port. With HTTPS on, plain HTTP on the same port is redirected to HTTPS. |
| `DB_PATH` | `data/pellet-pace.db` (Docker: `/app/data/pellet-pace.db`) | SQLite database file. Its folder is created if missing. |
| `HTTPS` | on | `0` serves plain HTTP. Any other value or unset means HTTPS. |
| `TLS_CERT` / `TLS_KEY` | unset | PEM certificate and key to use instead of a self-signed one. Set both or neither. |
| `TLS_DIR` | `<folder of DB_PATH>/tls` | Where the self-signed `cert.pem` / `key.pem` are kept. |
| `TLS_HOSTS` | auto-detected | Names/IPs the self-signed certificate must cover (also the URLs printed at start-up). |
| `COOKIE_SECURE` | unset | With `HTTPS=0`, set to `1` if a proxy serves the site over HTTPS. |
| `ADMIN_USERNAME` | `admin` | Username of the admin created on first start. |
| `ADMIN_PASSWORD` | random | Password of the admin created on first start. |

## HTTPS and certificates

HTTPS is on by default, so session cookies are never sent in clear text over the range Wi-Fi.

**Self-signed (default).** On start the app checks `TLS_DIR/cert.pem`. It makes a new certificate
(RSA 2048, valid 825 days) if the file is missing, expires within 7 days, or doesn't cover every
address in `TLS_HOSTS` (or the detected ones). Every device shows a certificate warning the first
time and after each regeneration. Users choose *Advanced → Proceed* (wording differs per browser).
To avoid regenerations, keep the machine's IP fixed and set `TLS_HOSTS` explicitly.

**Your own certificate.** Set `TLS_CERT` and `TLS_KEY` to PEM files, for example from an internal CA
whose root is installed on the range devices. In Docker, mount the files into the container
and point the variables at the mounted paths. The app reads them only at start-up, so restart it after renewing them.

## Running behind a reverse proxy

If nginx, Caddy, Traefik or similar terminates TLS:

```sh
HTTPS=0
COOKIE_SECURE=1     # the browser talks HTTPS to the proxy
```

Things to know:

- The app does not read `X-Forwarded-For`. The sign-in rate limit (10 failures per IP in 15 minutes)
  therefore sees **every user as the proxy's IP**. A few mistyped passwords can lock out sign-in for
  everyone for 15 minutes. Add rate limiting at the proxy, or run without a proxy on a trusted LAN.
- No WebSockets are used, so a plain HTTP proxy is enough. Clients poll every 1.5 seconds.
- Serve the app at the root path (`/`). The front end calls `/api/...` with absolute paths.

## Backups and restore

Everything is in the database file. The certificate is regenerated automatically if lost.

The database runs in WAL mode, so copying only `pellet-pace.db` while the app is running can miss
recent writes. Choose one of these:

**Consistent copy while running** (Docker):

```sh
docker compose exec pellet-pace rm -f /app/data/backup.db
docker compose exec pellet-pace node --no-warnings -e \
  "new (require('node:sqlite').DatabaseSync)(process.env.DB_PATH).exec(\"VACUUM INTO '/app/data/backup.db'\")"
docker compose cp pellet-pace:/app/data/backup.db ./pellet-backup-$(date +%F).db
docker compose exec pellet-pace rm /app/data/backup.db
```

**Whole data folder, with the app stopped:**

```sh
docker compose stop
docker run --rm --user root -v pellet-pace-data:/d -v "$PWD":/b pellet-pace tar czf /b/pellet-backup.tgz -C /d .
docker compose start
```

With `DATA_DIR` or `npm start`, stop the app and copy the folder.

### Restore

A restore **replaces all current data** with the backup. If you might need what's there now, back it up
first. Run the commands from the folder that contains the backup file, and change the file name to match.

**From a `.db` backup into the Docker volume:**

```sh
docker compose stop
docker run --rm --user root -v pellet-pace-data:/d -v "$PWD":/b pellet-pace sh -c \
  'rm -f /d/pellet-pace.db-wal /d/pellet-pace.db-shm && cp /b/pellet-backup-2026-10-21.db /d/pellet-pace.db && chown node:node /d/pellet-pace.db'
docker compose start
```

**From a `.tgz` backup into the Docker volume** (this also restores the certificate):

```sh
docker compose stop
docker run --rm --user root -v pellet-pace-data:/d -v "$PWD":/b pellet-pace sh -c \
  'find /d -mindepth 1 -delete && tar xzf /b/pellet-backup.tgz -C /d && chown -R node:node /d'
docker compose start
```

**Into a host folder** (`DATA_DIR`, or `./data` with `npm start`). Run these as the folder's owner:

```sh
docker compose stop                              # or stop the Node process
cd /srv/pellet-pace                              # your data folder
rm -f pellet-pace.db-wal pellet-pace.db-shm
cp ~/pellet-backup-2026-10-21.db pellet-pace.db  # or: tar xzf ~/pellet-backup.tgz -C .
docker compose start                             # or start it again
```

The `-wal`/`-shm` files belong to the database that's being replaced. Always delete them, or SQLite may
apply them to the restored file.

**Check the restore:** sign in and confirm your events are there. If `docker compose logs` shows
`Created admin account` right after the restore, the app found no database. Check the file name
and location, then restore again.

A backup made with an older version of the app can be restored as-is. It is upgraded automatically on start.

### Scheduled backups

For a nightly backup with cron (`crontab -e`), add this line. Change the folder to your copy of the repository:

```cron
0 3 * * * cd /opt/pellet-pace && docker compose exec -T pellet-pace rm -f /app/data/backup.db && docker compose exec -T pellet-pace node --no-warnings -e "new (require('node:sqlite').DatabaseSync)(process.env.DB_PATH).exec(\"VACUUM INTO '/app/data/backup.db'\")" && docker compose cp pellet-pace:/app/data/backup.db backups/pellet-backup-$(date +\%F).db
```

Create the `backups` folder first. In a crontab, `%` must be written as `\%`. Copy the backups off the machine now and then.

## Updating

```sh
git pull
docker compose up -d --build      # or restart the Node process
```

Schema changes are applied automatically on start (`PRAGMA user_version`). Take a backup first.
Upgrading from the old laps version signs everyone out once and keeps admin and host accounts. The old
game data stays in the unused `games`, `players` and `runs` tables.

## Operations and troubleshooting

**Lost admin password.** Any admin can reset another user's password on the **Users** page. If no
admin can sign in, set a new password directly:

```sh
docker compose exec pellet-pace node --no-warnings -e "
const c = require('node:crypto'), s = c.randomBytes(16);
const hash = s.toString('hex') + ':' + c.scryptSync(process.argv[2], s, 64).toString('hex');
const db = new (require('node:sqlite').DatabaseSync)(process.env.DB_PATH);
const r = db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, process.argv[1]);
db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = ?)').run(process.argv[1]);
console.log(r.changes ? 'Password updated' : 'No such user');" admin 'new-password-here'
```

Without Docker, run the same `node -e` command from the project folder with `DB_PATH` set. Like a reset
from the Users page, it signs that user out everywhere.

| Symptom | Cause / fix |
| --- | --- |
| `Cannot open the database at …` on start | The data folder isn't writable by the process user. In Docker with `DATA_DIR`, set `PUID`/`PGID` to the folder's owner. |
| `Could not create a self-signed certificate` | OpenSSL is missing. Install it, set `TLS_CERT`/`TLS_KEY`, or use `HTTPS=0`. |
| Certificate warning appears again on every device | The certificate was regenerated because the IP or `TLS_HOSTS` changed. Fix the IP with a DHCP reservation. |
| Devices can't connect, but `localhost` works | Firewall, wrong IP, or devices on a guest/isolated Wi-Fi network. |
| "Too many attempts" for everyone | Sign-in rate limit, often behind a proxy (see above). It clears after 15 minutes or on restart. |
| No admin password in the logs | The database already had an admin, and the password is printed only once. Use the reset above. |
| Everyone signed out | Sessions last 14 days. They are also cleared by the upgrade from the laps version. |

**Logs.** The app logs to stdout/stderr: start-up URLs, certificate creation, the first-start admin password,
and stack traces for unexpected (500) errors. In Docker: `docker compose logs -f`.

**Stopping.** `SIGTERM`/`SIGINT` close the database cleanly (`docker compose down`, `systemctl stop`, Ctrl+C).
