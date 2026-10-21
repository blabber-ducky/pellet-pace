# Deployment

Pellet Pace is a single Node.js process. It serves the web app and a JSON API on one port and keeps
everything in one SQLite file. Phones and tablets on the range reach it over the local network.

- [Requirements](#requirements)
- [Option A: Docker (recommended)](#option-a-docker-recommended)
- [Option B: Node directly](#option-b-node-directly)
- [Configuration reference](#configuration-reference)
- [HTTPS and certificates](#https-and-certificates)
  - [Using your own certificate](#using-your-own-certificate)
- [Running behind a reverse proxy](#running-behind-a-reverse-proxy)
- [Backups and restore](#backups-and-restore)
- [Updating](#updating)
- [Operations and troubleshooting](#operations-and-troubleshooting)

## Requirements

- One machine on the same network as the shooters' devices (a range PC, a mini PC or a Raspberry Pi is enough).
- **Docker** with Compose, **or** **Node.js 22.13 or later** (it needs the built-in `node:sqlite`).
- **OpenSSL** on the `PATH` when the app creates its own certificate (the default). The Docker image includes it.
- Internet access the first time and when updating, to pull the image from Docker Hub. After that the
  range network can be offline.
- A fixed LAN address for the machine. Reserve one in the router (DHCP reservation), because the certificate
  and the links people bookmark use that address.
- Inbound TCP on the chosen port (default `3000`) allowed by the host firewall.

## Option A: Docker (recommended)

```sh
cp .env.example .env          # set TLS_HOSTS (and optionally ADMIN_PASSWORD)
docker compose up -d          # pulls m1v1n/pellet-pace from Docker Hub
docker compose logs           # first start: shows the admin username and password
```

Then open `https://<TLS_HOSTS address>:3000` on any device.

What the Compose setup does:

| Item | Value |
| --- | --- |
| Container / image | `pellet-pace` / `m1v1n/pellet-pace:${PELLET_PACE_TAG:-latest}` from Docker Hub, for amd64 and arm64 (`node:22-alpine` + `openssl`) |
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
| `PELLET_PACE_TAG` | No | Image version: `latest` (default, newest `main`), or a release such as `1.2.0` / `1.2` / `1`. |
| `HOST_PORT` | No | Host port to publish (default `3000`). |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | No | Used **only** when the database has no admin yet. If the password is empty, a random one is printed in the logs. |
| `DATA_DIR` | No | Host folder for the data instead of the named volume. Create the folder first. |
| `TLS_CERT` / `TLS_KEY` | No | Your own certificate and key, as `/certs/...` paths ([details](#using-your-own-certificate)). Leave unset for self-signed. |
| `TLS_CERT_DIR` | No | Host folder mounted read-only at `/certs` (default `./certs`). |
| `PUID` / `PGID` | With `DATA_DIR` | The folder owner's ids (`id -u`, `id -g`), so the container can write there. |
| `HTTPS` | No | Set to `0` behind a TLS-terminating proxy (see below). |

### Where the data lives

The image holds only code. The database and certificate stay in the volume (or `DATA_DIR`), so they
survive `docker compose pull`, `docker compose down` and image updates.
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
| `TLS_CERT` / `TLS_KEY` | unset | PEM certificate (chain) and unencrypted key to use instead of a self-signed one. Set both or neither. See [Using your own certificate](#using-your-own-certificate). |
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

### Using your own certificate

Use your own certificate if you have a domain name with a real certificate (e.g. Let's Encrypt), or an internal CA
whose root is installed on the range devices. Devices then connect without a warning, as long as they
use a name the certificate covers.

You need two PEM files:
- **the certificate:** for Let's Encrypt, use `fullchain.pem` (your certificate followed by the intermediates), and
- **its private key**, unencrypted (no passphrase).

**Docker:**

1. Put both files in a `certs` folder next to `docker-compose.yml`:

   ```sh
   mkdir -p certs
   cp /path/to/fullchain.pem /path/to/privkey.pem certs/
   sudo chown 1000:1000 certs/*.pem    # the container user (your PUID if you changed it)
   chmod 600 certs/privkey.pem
   ```

2. Add to `.env`. These are paths **inside** the container, where the folder is mounted read-only at `/certs`:

   ```sh
   TLS_CERT=/certs/fullchain.pem
   TLS_KEY=/certs/privkey.pem
   ```

   To keep the files somewhere else, for example where certbot writes them, also set `TLS_CERT_DIR` to that host folder.
   Mount the folder that holds the real files, not one that only contains symlinks to them.
   With certbot, that's `/etc/letsencrypt/archive/<domain>` (the files there are numbered, e.g. `fullchain3.pem`),
   or a deploy hook that copies the new files into `certs/`.

3. Run `docker compose up -d`, then `docker compose logs`. You should see a line like:

   ```
   Using TLS certificate /certs/fullchain.pem for DNS:range.example.com, valid until 2027-01-19
   ```

**Node:** set `TLS_CERT` and `TLS_KEY` to the files' real paths. They must be readable by the user running the app.

**Renewing:** the files are read only at start-up. After replacing them, run `docker compose restart` (or restart
the Node process). The log warns at start-up when the certificate expires within 14 days.

**Going back to self-signed:** remove `TLS_CERT` and `TLS_KEY` from `.env` and run `docker compose up -d`.

The certificate folder is always mounted, so Docker creates an empty `certs` folder if there isn't one. That's
harmless: it's ignored by git and unused until `TLS_CERT`/`TLS_KEY` are set. If a certificate can't be loaded, the app
exits with a `TLS_CERT / TLS_KEY:` message, and Docker keeps restarting it until you fix it. Check `docker compose logs`.

When `TLS_CERT`/`TLS_KEY` are set, `TLS_HOSTS` and `TLS_DIR` are not used for the certificate.
The certificate must cover the name devices use, so the address you give out must be a name on the
certificate, not the bare IP address.

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
docker run --rm --user root -v pellet-pace-data:/d -v "$PWD":/b m1v1n/pellet-pace tar czf /b/pellet-backup.tgz -C /d .
docker compose start
```

With `DATA_DIR` or `npm start`, stop the app and copy the folder.

### Restore

A restore **replaces all current data** with the backup. If you might need what's there now, back it up
first. Run the commands from the folder that contains the backup file, and change the file name to match.

**From a `.db` backup into the Docker volume:**

```sh
docker compose stop
docker run --rm --user root -v pellet-pace-data:/d -v "$PWD":/b m1v1n/pellet-pace sh -c \
  'rm -f /d/pellet-pace.db-wal /d/pellet-pace.db-shm && cp /b/pellet-backup-2026-10-21.db /d/pellet-pace.db && chown node:node /d/pellet-pace.db'
docker compose start
```

**From a `.tgz` backup into the Docker volume** (this also restores the certificate):

```sh
docker compose stop
docker run --rm --user root -v pellet-pace-data:/d -v "$PWD":/b m1v1n/pellet-pace sh -c \
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

**Docker:**

```sh
docker compose pull               # newest image for PELLET_PACE_TAG
docker compose up -d              # recreates the container; data is kept
```

To go back to an earlier version, set `PELLET_PACE_TAG` to that release in `.env` and run the same two commands.
Restore a backup made before the upgrade if the newer version changed the schema.

**Node:** `git pull`, then restart the process.

Schema changes are applied automatically on start (`PRAGMA user_version`). Take a backup first.
Upgrading from the old laps version signs everyone out once and keeps admin and host accounts. The old
game data stays in the unused `games`, `players` and `runs` tables.

## Operations and troubleshooting

**Lost admin password.** Any admin can reset another user's password, or make another account an admin, on the **Users** page. If no
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
| `TLS_CERT / TLS_KEY: Cannot read /certs/…` | The file isn't in the mounted folder. Check `TLS_CERT_DIR` and the file names, and don't point at symlinks into a folder that isn't mounted. |
| `TLS_CERT / TLS_KEY: … is not readable by uid 1000` | `chown 1000:1000` the files (or your `PUID`), or make the certificate world-readable and `chmod 640` the key with a matching group. |
| `TLS_CERT / TLS_KEY: … is not the key for …` | The key and certificate don't belong together. After a renewal, both files must come from the same renewal. |
| `TLS_CERT / TLS_KEY: … is not a PEM certificate` | The file is DER or PFX. Convert it: `openssl x509 -in cert.der -inform der -out cert.pem`, or for PFX `openssl pkcs12 -in cert.pfx -nokeys -out cert.pem` and `openssl pkcs12 -in cert.pfx -nocerts -nodes -out key.pem`. |
| `TLS_CERT / TLS_KEY: … is protected by a passphrase` | The app can't ask for a passphrase. Save an unencrypted copy: `openssl pkey -in enc.key -out key.pem`. |
| Browser warns although you use your own certificate | The device used an address the certificate doesn't cover (e.g. the IP), or the CA root isn't installed on the device. |
| Certificate warning appears again on every device | The certificate was regenerated because the IP or `TLS_HOSTS` changed. Fix the IP with a DHCP reservation. |
| Devices can't connect, but `localhost` works | Firewall, wrong IP, or devices on a guest/isolated Wi-Fi network. |
| "Too many attempts" for everyone | Sign-in rate limit, often behind a proxy (see above). It clears after 15 minutes or on restart. |
| No admin password in the logs | The database already had an admin, and the password is printed only once. Use the reset above. |
| Everyone signed out | Sessions last 14 days. They are also cleared by the upgrade from the laps version. |

**Logs.** The app logs to stdout/stderr: start-up URLs, certificate creation, the first-start admin password,
and stack traces for unexpected (500) errors. In Docker: `docker compose logs -f`.

**Stopping.** `SIGTERM`/`SIGINT` close the database cleanly (`docker compose down`, `systemctl stop`, Ctrl+C).
