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

-- When the job last changed stage (progress step or cancel/restore), ISO 8601.
-- Shown under the job's Gantt bar, e.g. "ปิดเวลา 10:00". Empty until first update.
ALTER TABLE ai_project.shutdown_mnm_tasks
  ADD COLUMN IF NOT EXISTS stage_at TEXT NOT NULL DEFAULT '';

-- Why the job was cancelled, typed in when cancelling; cleared on restore.
-- Shown under the job's Gantt bar next to the cancel time.
ALTER TABLE ai_project.shutdown_mnm_tasks
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT NOT NULL DEFAULT '';

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
-- Activity export (date range, all plants) and the one-year retention prune.
CREATE INDEX IF NOT EXISTS shutdown_mnm_activity_created_idx
  ON ai_project.shutdown_mnm_activity (created_at);

-- One row per (plant, milestone); the six milestones are fixed in code.
-- date/time hold the Monthly Plan; actual_date/actual_time hold when it really happened.
CREATE TABLE IF NOT EXISTS ai_project.shutdown_mnm_schedule (
  plant        TEXT NOT NULL REFERENCES ai_project.shutdown_mnm_plants(name) ON DELETE CASCADE,
  milestone    TEXT NOT NULL,
  date         TEXT NOT NULL DEFAULT '',
  time         TEXT NOT NULL DEFAULT '',
  actual_date  TEXT NOT NULL DEFAULT '',
  actual_time  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (plant, milestone)
);
ALTER TABLE ai_project.shutdown_mnm_schedule ADD COLUMN IF NOT EXISTS actual_date TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_project.shutdown_mnm_schedule ADD COLUMN IF NOT EXISTS actual_time TEXT NOT NULL DEFAULT '';

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

-- Closed shutdowns, kept for the History view and the Overall Plant year table.
-- "Close shutdown" (or a clear / new Excel upload, as a safety net) copies the
-- plant's tasks, safety items and milestones here before they are reset, so the
-- next shutdown starts empty. One row per (plant, start_date): closing the same
-- shutdown again overwrites its record.
CREATE TABLE IF NOT EXISTS ai_project.shutdown_mnm_history (
  id          BIGSERIAL PRIMARY KEY,
  plant       TEXT    NOT NULL REFERENCES ai_project.shutdown_mnm_plants(name) ON DELETE CASCADE,
  start_date  TEXT    NOT NULL,              -- YYYY-MM-DD
  end_date    TEXT    NOT NULL DEFAULT '',   -- YYYY-MM-DD
  total       INTEGER NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0,
  cancelled   INTEGER NOT NULL DEFAULT 0,
  touched     INTEGER NOT NULL DEFAULT 0,    -- tasks moved past 0% or cancelled
  file_name   TEXT    NOT NULL DEFAULT '',
  schedule    JSONB   NOT NULL DEFAULT '{}'::jsonb,
  tasks       JSONB   NOT NULL DEFAULT '[]'::jsonb,
  safety      JSONB   NOT NULL DEFAULT '{}'::jsonb,
  closed_by   TEXT    NOT NULL DEFAULT '',
  closed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plant, start_date)
);
CREATE INDEX IF NOT EXISTS shutdown_mnm_history_start_idx
  ON ai_project.shutdown_mnm_history (start_date);

-- Calendar date (YYYY-MM-DD) of start_time / end_time for jobs that span several days.
-- Filled from multi-day Excel schedules, whose Start/End cells are full date-times;
-- blank for single-day files, where the day is inferred from the hourly grid.
ALTER TABLE ai_project.shutdown_mnm_tasks
  ADD COLUMN IF NOT EXISTS start_date TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_project.shutdown_mnm_tasks
  ADD COLUMN IF NOT EXISTS end_date TEXT NOT NULL DEFAULT '';

-- TRUE for jobs added by hand with "+ เพิ่มรายการงานหยุดซ่อม" rather than from the
-- Excel plan; drives the "Add work" stage tile.
ALTER TABLE ai_project.shutdown_mnm_tasks
  ADD COLUMN IF NOT EXISTS added BOOLEAN NOT NULL DEFAULT FALSE;
-- Backfill jobs added by hand before the column existed: the add-job API logs
-- "สร้างรายการงานใหม่" for the tag within moments of the insert; Excel imports don't.
UPDATE ai_project.shutdown_mnm_tasks t SET added = TRUE
WHERE NOT t.added AND EXISTS (
  SELECT 1 FROM ai_project.shutdown_mnm_activity a
  WHERE a.plant = t.plant AND a.tag = t.tag AND a.action LIKE 'สร้างรายการงานใหม่%'
    AND a.created_at BETWEEN t.created_at AND t.created_at + interval '1 minute');

-- Free-text note about the job (delays, findings, ...), entered from the Gantt "Note"
-- button and shown under the job's bar. Separate from `note`, which holds the Excel remark.
ALTER TABLE ai_project.shutdown_mnm_tasks
  ADD COLUMN IF NOT EXISTS event_note TEXT NOT NULL DEFAULT '';

-- History: Add Work job count, and the Excel upload time plus the Gantt shutdown window
-- ({uploadedAt, rangeStart, rangeEnd}) as they stood when the shutdown was closed.
ALTER TABLE ai_project.shutdown_mnm_history
  ADD COLUMN IF NOT EXISTS added INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_project.shutdown_mnm_history
  ADD COLUMN IF NOT EXISTS upload JSONB NOT NULL DEFAULT '{}'::jsonb;
UPDATE ai_project.shutdown_mnm_history h SET added = sub.n
FROM (SELECT id, count(*) FILTER (WHERE (e->>'added')::boolean)::int AS n
      FROM ai_project.shutdown_mnm_history, jsonb_array_elements(tasks) e GROUP BY id) sub
WHERE h.id = sub.id AND h.added = 0 AND sub.n > 0;
