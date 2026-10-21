# Agent instructions

Standing instructions for AI coding agents (and humans) working on Pellet Pace. Read this before
making changes. For background, see [docs/development.md](docs/development.md) (architecture, API,
data model), [docs/deployment.md](docs/deployment.md) and [docs/user-guide.md](docs/user-guide.md).

## What this project is

Shared-start timing and live leaderboards for shooting range events. A host starts one clock for
every joined shooter, and each shooter presses STOP on their own device. It runs on a single machine on a
range LAN, used from phones and tablets, often on weak Wi-Fi, by non-technical people under time pressure.

## Hard rules

1. **No dependencies.** `package.json` has no `dependencies` or `devDependencies`. Use only Node built-ins
   (`node:http`, `node:sqlite`, `node:crypto`, …) on the server and plain browser APIs on the client.
   Don't add npm packages, CDNs, frameworks, bundlers, transpilers or TypeScript without the maintainer's explicit approval.
2. **No build step.** Files in `public/` are served as written. `npm start` must keep working on a fresh clone.
3. **Node 22.13+ only.** Don't use APIs newer than Node 22. `node:sqlite` is still experimental there, so
   keep the `--no-warnings=ExperimentalWarning` flag in `package.json` and the `Dockerfile`.
4. **The server is the clock.** Every recorded time comes from server `Date.now()`. Never accept
   timestamps, durations or results from the client. Live client clocks must use `serverNow()`.
5. **Never break existing databases.** Schema changes go in a new `user_version` migration step (see
   "Change the schema" in docs/development.md). Don't edit the existing version-2 migration, and never drop user data.
   The legacy `games`/`players`/`runs` tables are deliberately left in place.
6. **Authorise on the server.** Every new route starts with `requireUser(...)` or
   `loadEvent`/`loadManagedEvent`. Return 404 for events the user can't see.
7. **Keep CSRF protection.** State-changing requests require `Content-Type: application/json` (`readJson`).
   Don't add form-encoded endpoints, CORS headers or state-changing GETs.
8. **No HTML injection.** Build DOM with `h()`. Never put user data into `innerHTML`, `outerHTML`,
   `insertAdjacentHTML` or `document.write`.
9. **Secrets stay out of git.** Never commit `.env`, `data/`, databases, certificates or keys.

## Code style

Match the existing code. It is deliberately compact:

- ES modules, 2-space indent, single quotes, semicolons, trailing commas in multi-line literals.
- `server.js` and `public/app.js` are single files, divided into sections by `// ---------- name ----------`
  banners. Put new code in the matching section. Don't split them into modules unless the maintainer asks.
- Synchronous `DatabaseSync` prepared statements with `?` placeholders. Never build SQL from user input
  (the only interpolation is the fixed `WHERE ev.host_id = ?` fragment chosen by role).
- Client errors are `throw new HttpError(status, 'Message a user can read')`. The message is shown to users
  as-is, so write it in plain, friendly English.
- Comments explain *why*, briefly. Don't comment the obvious.
- CSS: use the custom properties in `:root` and give every new colour a dark-mode value.

## UX principles

- **Big, obvious, mistake-tolerant.** Destructive or irreversible actions (start, end, clear, delete, remove)
  use `confirmButton` (two taps).
- **Don't move things under a finger.** The event view re-renders only on real data changes and never while a
  button is armed or a request is in flight. Keep that behaviour when you change it.
- **Phone first.** Check new UI at about 360 px wide, in light and dark mode.
- Keep the user-facing words *host*, *shooter*, *event*, *invite code*, *Start for everyone*, *STOP*, *End event*,
  *Clear* and *did not finish* consistent with the existing UI and docs.

## Git

- **Always work on the `main` branch.** Commit directly to `main`. Don't create feature branches.
- Commit or push only when the maintainer asks.
- A push to `main` publishes a new `latest` image to Docker Hub (see below). Every commit on `main` must
  work, because range machines may pull it.

## Docker image and CI

- `.github/workflows/docker.yml` builds `m1v1n/pellet-pace` for `linux/amd64` and `linux/arm64` and pushes it to
  Docker Hub. `docker-compose.yml` pulls that image and never builds locally. Keep both architectures working:
  no architecture-specific binaries or base images.
- Keep the image name `m1v1n/pellet-pace` the same in the workflow, `docker-compose.yml` and the docs.
- Never put Docker Hub credentials in the repository. The workflow reads the `DOCKERHUB_TOKEN` secret.

## Keep docs in sync

When behaviour changes, update the docs in the same change:

| You changed | Update |
| --- | --- |
| An environment variable or the Docker setup | `docs/deployment.md`, `README.md`, and `.env.example` / `docker-compose.yml` if relevant |
| The CI workflow, image tags or release process | `docs/development.md` (Docker images and releases) and this file |
| An API route, payload or the schema | `docs/development.md` |
| Anything a shooter, host or admin sees or does | `docs/user-guide.md` (and `README.md` "How an event runs" if the flow changed) |
| A standing convention | This file |

## Verifying changes

There is no automated test suite. Before declaring a change done:

1. Run `node --check server.js` and `node --check public/app.js`.
2. Start a throwaway instance: `HTTPS=0 DB_PATH=/tmp/pp-dev.db ADMIN_PASSWORD=devpassword npm start`.
3. Exercise the affected flow in a browser or with curl (see docs/development.md → Testing). For timing or
   event-flow changes, run the whole manual checklist.
4. For a schema change, test both a fresh database and a copy of an existing one.
5. For Docker changes, run `docker build -t m1v1n/pellet-pace:dev .` and `PELLET_PACE_TAG=dev docker compose up -d`, then check that
   `docker compose ps` shows the container as healthy. The image must keep building for both `linux/amd64` and `linux/arm64`.

If you can't run something, say so explicitly. Don't claim it works.

## Ask before

- Adding a dependency, build tooling or a new top-level directory.
- Changing the timing model, ranking/tie rules, or the event lifecycle (`waiting → running → finished`).
- Changing cookie, session, password-hashing or rate-limit behaviour.
- Anything that deletes or rewrites existing data in a migration.
- Committing, pushing or tagging releases. Pushing to `main` or pushing a `v*` tag publishes images to Docker Hub.
- Changing the image name, the target platforms or the workflow's triggers.
