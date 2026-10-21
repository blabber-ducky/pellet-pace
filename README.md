# Pellet Pace

Shared-start timing and live leaderboards for shooting range events. No dependencies — just
Node.js 22.13+ (uses the built-in `node:sqlite`).

```sh
npm start                     # https://localhost:3000
```

On first start an `admin` account is created and its password is printed to the console.
Set `ADMIN_USERNAME` / `ADMIN_PASSWORD` beforehand to choose them yourself.

## Docker

```sh
cp .env.example .env          # then edit TLS_HOSTS
docker compose up -d --build  # https://<this machine>:3000
docker compose logs           # shows the admin password on first start
```

- The image contains only code. Deployment data (database + certificate) lives outside it, in the Docker
  volume `pellet-pace-data` by default, so it survives rebuilds and `docker compose down`
  (only `docker compose down -v` deletes it).
- To keep data in a host folder instead, create the folder and set `DATA_DIR`, `PUID` and `PGID` in `.env`
  (the ids of the folder's owner, from `id -u` / `id -g`).
- Back up the volume: `docker run --rm --user root -v pellet-pace-data:/d -v "$PWD":/b pellet-pace tar czf /b/pellet-backup.tgz -C /d .`
  (or just copy the host folder when using `DATA_DIR`).
- `TLS_HOSTS` must list the IPs/hostnames devices use to reach this machine (e.g. `192.168.1.20,range-pc.local`),
  because inside the container the app can't see the host's LAN addresses. Changing it regenerates the certificate.
- Update after code changes: `docker compose up -d --build`. Stop: `docker compose down`.
- The project's own `./data` folder is only used by `npm start` (local development) and is never copied into the image.

## How an event runs

1. A **host** (or admin) creates an event by name and gets an invite code / join link.
2. **Shooters** sign in (or create an account), enter the code, and wait on the event screen.
3. The host presses **Start for everyone** — one shared start time for all joined shooters.
   Nobody can join after this.
4. Each shooter presses **STOP** once when done. That time is final.
5. The host presses **End event**. Anyone who hadn't stopped is listed as "did not finish".

Times are recorded by the **server**, so a device's clock can't affect results. If a shooter hits
STOP by accident, the host can **Clear** that time while the event is running; the shooter's timer
resumes from the shared start.

## Roles

- **Admin** — everything a host can do, sees every event, manages users (Users page).
- **Host** — creates and runs their own events, sees all of their current and previous events.
- **Shooter** — signs up themselves (or is added by an admin), joins events with an invite code,
  sees the live leaderboard for events they're in and their history of previous events.

## HTTPS

HTTPS is on by default. On first start a self-signed certificate is created with OpenSSL in `data/tls/`,
covering `localhost`, the machine's hostname (and `hostname.local`) and its current LAN IPs. It is
regenerated automatically if the machine's IP changes or the certificate is about to expire.
Browsers will warn about the self-signed certificate the first time on each device — choose
"Advanced → Proceed". Plain `http://` requests on the same port are redirected to `https://`.

- Use your own certificate: set `TLS_CERT` and `TLS_KEY` to PEM file paths.
- Behind a reverse proxy that handles TLS: set `HTTPS=0` (and `COOKIE_SECURE=1` if the proxy serves HTTPS).

| Env var         | Default               | Purpose                                         |
| --------------- | --------------------- | ----------------------------------------------- |
| `PORT`          | `3000`                | Port (HTTPS, with HTTP redirect on the same port) |
| `DB_PATH`       | `data/pellet-pace.db` | SQLite database file                            |
| `HTTPS`         | on                    | Set to `0` to serve plain HTTP                  |
| `TLS_CERT` / `TLS_KEY` | unset          | Your own certificate and key instead of self-signed |
| `TLS_DIR`       | `data/tls`            | Where the self-signed certificate is stored     |
| `TLS_HOSTS`     | auto-detected         | Comma-separated names/IPs for the self-signed certificate |
| `COOKIE_SECURE` | unset                 | With `HTTPS=0`, set to `1` if a proxy serves HTTPS |

## Upgrading from the laps version

The database upgrades itself on start. Admin and host accounts are kept; everyone is signed out once.
Old games/laps data is not converted (it stays in the unused `games`, `players` and `runs` tables).
