-- Shutdown Management — PostgreSQL schema
-- Lives inside the shared "ai_project" schema on rms-scgp-dwh, so every table
-- carries the shutdown_mnm_ prefix to stay clear of the other projects there.

-- The ai_project schema is shared and pre-existing; the app's database role has
-- CREATE on the schema but not on the database, so it is never created here.

-- Plants also act as the atomic counter holder for the human-readable
-- TASK-nnn / SAFE-nnn ids, which the UI displays and the API routes on.
CREATE TABLE IF NOT EXISTS ai_project.shutdown_mnm_plants (
  name               TEXT PRIMARY KEY,
  task_seq           INTEGER     NOT NULL DEFAULT 0,
  safety_seq         INTEGER     NOT NULL DEFAULT 0,
  last_excel_upload  JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_project.shutdown_mnm_users (
  username    TEXT PRIMARY KEY,
  role        TEXT        NOT NULL DEFAULT 'user',
  salt        TEXT        NOT NULL,
  hash        TEXT        NOT NULL,
  last_login  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_project.shutdown_mnm_tasks (
  plant       TEXT    NOT NULL REFERENCES ai_project.shutdown_mnm_plants(name) ON DELETE CASCADE,
  id          TEXT    NOT NULL,
  tag         TEXT    NOT NULL DEFAULT '',
  title       TEXT    NOT NULL DEFAULT '',
  area        TEXT    NOT NULL DEFAULT '',
  assignee    TEXT    NOT NULL DEFAULT '',
  progress    INTEGER NOT NULL DEFAULT 0,
  note        TEXT    NOT NULL DEFAULT '',
  duration    TEXT    NOT NULL DEFAULT '',
  start_time  TEXT    NOT NULL DEFAULT '',
  end_time    TEXT    NOT NULL DEFAULT '',
  updated_at  TEXT    NOT NULL DEFAULT '',
  updated_by  TEXT    NOT NULL DEFAULT '',
  seq         BIGSERIAL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plant, id)
);
CREATE INDEX IF NOT EXISTS shutdown_mnm_tasks_plant_seq_idx
  ON ai_project.shutdown_mnm_tasks (plant, seq);

-- 'active' | 'cancelled' — kept separate from the 0/25/50/75/100 progress
-- stages so a cancelled job doesn't disturb the linear progression math.
ALTER TABLE ai_project.shutdown_mnm_tasks
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

CREATE TABLE IF NOT EXISTS ai_project.shutdown_mnm_activity (
  id          BIGSERIAL PRIMARY KEY,
  plant       TEXT NOT NULL REFERENCES ai_project.shutdown_mnm_plants(name) ON DELETE CASCADE,
  tag         TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL DEFAULT '',
  actor       TEXT NOT NULL DEFAULT 'System',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shutdown_mnm_activity_plant_id_idx
  ON ai_project.shutdown_mnm_activity (plant, id DESC);

-- One row per (plant, milestone); the six milestones are fixed in code.
CREATE TABLE IF NOT EXISTS ai_project.shutdown_mnm_schedule (
  plant      TEXT NOT NULL REFERENCES ai_project.shutdown_mnm_plants(name) ON DELETE CASCADE,
  milestone  TEXT NOT NULL,
  date       TEXT NOT NULL DEFAULT '',
  time       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (plant, milestone)
);

-- id is unique per plant, but the API addresses items as /:category/:id and the
-- legacy JSON data restarted numbering per category, so category is in the key.
CREATE TABLE IF NOT EXISTS ai_project.shutdown_mnm_safety (
  plant        TEXT NOT NULL REFERENCES ai_project.shutdown_mnm_plants(name) ON DELETE CASCADE,
  category     TEXT NOT NULL,
  id           TEXT NOT NULL,
  text         TEXT NOT NULL DEFAULT '',
  responsible  TEXT NOT NULL DEFAULT '',
  datetime     TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending',
  seq          BIGSERIAL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plant, category, id)
);
CREATE INDEX IF NOT EXISTS shutdown_mnm_safety_plant_cat_idx
  ON ai_project.shutdown_mnm_safety (plant, category, seq);

-- Microsoft Entra ID sign-in: these users have no local password, so salt/hash
-- become optional. entra_oid (the stable object id claim) is the identity key;
-- username is just the display handle (the account's email / UPN).
-- Roles: 'admin' (can edit) | 'user' (read-only, default for new Entra sign-ins).
-- The short-lived 'employee' role was folded into 'user'.
UPDATE ai_project.shutdown_mnm_users SET role = 'user' WHERE role = 'employee';
UPDATE ai_project.shutdown_mnm_sessions SET role = 'user' WHERE role = 'employee';
ALTER TABLE ai_project.shutdown_mnm_users ALTER COLUMN salt DROP NOT NULL;
ALTER TABLE ai_project.shutdown_mnm_users ALTER COLUMN hash DROP NOT NULL;
ALTER TABLE ai_project.shutdown_mnm_users ADD COLUMN IF NOT EXISTS entra_oid     TEXT;
ALTER TABLE ai_project.shutdown_mnm_users ADD COLUMN IF NOT EXISTS email         TEXT;
ALTER TABLE ai_project.shutdown_mnm_users ADD COLUMN IF NOT EXISTS display_name  TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS shutdown_mnm_users_entra_oid_idx
  ON ai_project.shutdown_mnm_users (entra_oid) WHERE entra_oid IS NOT NULL;

-- Login sessions live in the database rather than process memory so that more
-- than one Cloud Run instance can serve the same signed-in user.
CREATE TABLE IF NOT EXISTS ai_project.shutdown_mnm_sessions (
  token       TEXT PRIMARY KEY,
  username    TEXT        NOT NULL,
  role        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS shutdown_mnm_sessions_expires_idx
  ON ai_project.shutdown_mnm_sessions (expires_at);
