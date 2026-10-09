# Shutdown Management

Plant shutdown tracking dashboard — milestone schedule, work-permit progress,
safety activities and Excel import for four SKIC plants (BM1, BM3, BM16, BM17).

Express API + static HTML frontend, backed by PostgreSQL. Backend and frontend
ship as a single container image.

## Stack

| Layer     | Technology                                                   |
|-----------|--------------------------------------------------------------|
| Backend   | Node.js 20, Express 4                                        |
| Frontend  | Static HTML/CSS/JS in `public/`, served by Express           |
| Database  | PostgreSQL 17 (Azure), schema `ai_project`, `shutdown_mnm_*` |
| Container | Single multi-stage Dockerfile, non-root, ~221 MB             |

## Quick start

```bash
npm install
cp .env.example .env    # then fill in DB_PASSWORD
npm run migrate         # create tables + import data.json if present
npm start               # http://localhost:3000
```

Default login is `admin` / `admin` — change it immediately after first sign-in.

## Environment

All configuration comes from environment variables; see [.env.example](.env.example).

| Variable            | Required | Default      | Notes                                       |
|---------------------|----------|--------------|---------------------------------------------|
| `DB_USER`           | yes      | —            | Database role                               |
| `DB_PASSWORD`       | yes      | —            | Use Secret Manager in production            |
| `DB_HOST`           | yes      | —            | Azure PostgreSQL host                       |
| `DB_PORT`           | no       | `5432`       |                                             |
| `DB_NAME`           | yes      | —            | `rms-scgp-dwh`                              |
| `DB_SCHEMA`         | no       | `ai_project` | Shared schema; tables prefixed              |
| `DB_SSL_MODE`       | no       | `require`    | `require` \| `verify-full` \| `disable`     |
| `DB_POOL_MAX`       | no       | `5`          | Connections per instance                    |
| `PORT`              | no       | `3000`       | Cloud Run injects `8080`                    |
| `HOST`              | no       | `0.0.0.0`    |                                             |
| `NODE_ENV`          | no       | —            | `production` adds `Secure` to cookies       |
| `SESSION_TTL_HOURS` | no       | `12`         | Login session lifetime                      |

## Database

The app shares the `ai_project` schema with other projects, so every table
carries a `shutdown_mnm_` prefix.

| Table                      | Holds                                              |
|----------------------------|----------------------------------------------------|
| `shutdown_mnm_plants`      | Four plants + per-plant id counters, last upload   |
| `shutdown_mnm_users`       | Accounts, scrypt salt + hash, last login           |
| `shutdown_mnm_tasks`       | Work items (`TASK-nnn` per plant)                  |
| `shutdown_mnm_activity`    | Audit feed, capped at 200 rows per plant           |
| `shutdown_mnm_schedule`    | Six milestones per plant                           |
| `shutdown_mnm_safety`      | Safety activities (`SAFE-nnn`) in three categories |
| `shutdown_mnm_sessions`    | Login sessions, shared across instances            |
| `shutdown_mnm_history`     | Closed shutdowns: counts + tasks/safety/milestones |

Schema lives in [schema.sql](schema.sql) and is idempotent (`CREATE TABLE IF NOT EXISTS`).

### Migration commands

```bash
npm run migrate          # apply schema, then import data.json (refuses if tables non-empty)
npm run migrate:schema   # create tables only
npm run migrate:reset    # TRUNCATE shutdown_mnm_* first, then re-import
```

Password hashes carry over unchanged, so no one has to reset a password.

## Docker

```bash
docker build -t shutdown-management .
docker run --rm -p 8080:8080 --env-file .env -e PORT=8080 shutdown-management
```

One image contains the API and the frontend. It runs as the non-root `node`
user, uses `dumb-init` as PID 1 so `SIGTERM` is forwarded, and writes Excel
uploads to `/tmp` (the only writable path on Cloud Run).

## Cloud Run

The repo is deployable straight from source — Cloud Run detects the Dockerfile.

Set on the service:

- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_SCHEMA`, `DB_SSL_MODE` as env vars
- `DB_PASSWORD` from Secret Manager
- `NODE_ENV=production`
- Leave `PORT` unset — Cloud Run injects it

The database is on Azure, not Google Cloud, so the service needs egress to the
public internet (the default) and the Azure firewall must allow Cloud Run's
outbound addresses. Use a Serverless VPC connector with a static NAT IP if the
firewall requires a fixed source.

Keep `DB_POOL_MAX` low: each instance opens its own pool, and Azure caps total
server connections.

### Endpoints for probes

| Path          | Checks                                            |
|---------------|---------------------------------------------------|
| `/api/health` | Liveness — process only, no database call         |
| `/api/ready`  | Readiness — round-trips a query, `503` if DB down  |

## API

All routes require an authenticated session cookie except `/api/login`,
`/api/health` and `/api/ready`. Plant is selected with `?plant=SKIC%20BM16`
(defaults to `SKIC BM16`).

| Method   | Path                          | Purpose                     |
|----------|-------------------------------|-----------------------------|
| `POST`   | `/api/login`                  | Sign in, sets `sid` cookie  |
| `POST`   | `/api/logout`                 | End session                 |
| `GET`    | `/api/me`                     | Current user                |
| `GET`    | `/api/users`                  | List users (admin)          |
| `POST`   | `/api/users`                  | Create user (admin)         |
| `DELETE` | `/api/users/:username`        | Delete user (admin)         |
| `GET`    | `/api/tasks`                  | Tasks for plant             |
| `POST`   | `/api/tasks`                  | Create task                 |
| `PUT`    | `/api/tasks/:id/progress`     | Update progress             |
| `PUT`    | `/api/tasks/:id/note`         | Update note                 |
| `DELETE` | `/api/tasks/:id`              | Delete task                 |
| `DELETE` | `/api/tasks`                  | Clear tasks + safety items  |
| `GET`    | `/api/activity`               | Recent activity (30)        |
| `GET`    | `/api/schedule`               | Milestone schedule          |
| `PUT`    | `/api/schedule`               | Save milestone schedule     |
| `GET`    | `/api/safety`                 | Safety activities           |
| `POST`   | `/api/safety/:category`       | Add safety activity         |
| `PUT`    | `/api/safety/:category/:id`   | Edit safety activity        |
| `DELETE` | `/api/safety/:category/:id`   | Delete safety activity      |
| `POST`   | `/api/upload`                 | Import Excel (.xlsx/.xls)   |
| `GET`    | `/api/upload/last`            | Last import metadata        |

## Layout

```
server.js      Express app, routes, sessions, Excel import
db.js          Data layer — all SQL lives here
pool.js        Connection pool, TLS, transactions
schema.sql     Table definitions
migrate.js     data.json -> PostgreSQL, idempotent
public/        Frontend (single index.html)
Dockerfile     Single image, backend + frontend
```

## Security notes

- `.env` and `data.json` are gitignored; `data.json` holds password hashes.
- Passwords use `scrypt` with a per-user salt, compared in constant time.
- Sessions are database-backed with a 12-hour TTL and hourly cleanup.
- Change the default `admin` password before exposing the service.
