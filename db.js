// PostgreSQL data layer (schema: ai_project, tables prefixed shutdown_mnm_).
// Every method is async; server.js awaits them.
const crypto = require('crypto');
const { query, withTx } = require('./pool');

const DEFAULT_PLANT = 'SKIC BM16';
const PLANTS = ['SKIC BM1', 'SKIC BM3', 'SKIC BM17', 'SKIC BM16',
  'SKIC WS BM4', 'SKIC WS BM5', 'SKIC WS BM6', 'SKIC WS BM7', 'SKIC WS BM8', 'SKIC WS BM9',
  'TCP TM BM10',
  'TPC Pulp BP CP', 'TPC Pulp BP SCP', 'TPC Pulp BP RB', 'TPC Pulp BP Chipping', 'TPC Pulp BP ECO',
  'TPC Pulp WS CP', 'TPC Pulp WS UBP', 'TPC Pulp WS RB', 'TPC Pulp WS Chipping'];

const SCHEDULE_MILESTONES = ['shutdown', 'repair_done', 'warm_stream', 'function_test', 'startup', 'on_reel'];
const SAFETY_CATEGORIES = ['power_outage', 'site_prep', 'high_risk'];

const USER_ROLES = ['admin', 'user'];

const ACTIVITY_RETENTION = '1 year';  // activity rows older than this are pruned
const ACTIVITY_EXPORT_MAX = 100000;   // row cap for one activity export
let lastActivityPrune = 0;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function nowTime() {
  const n = new Date();
  return `${n.getHours().toString().padStart(2, '0')}:${n.getMinutes().toString().padStart(2, '0')} น.`;
}

function plantKey(plant) { return PLANTS.includes(plant) ? plant : DEFAULT_PLANT; }

// "22:30" + 180 → "01:30"; blank or unparseable values are left as they are.
function shiftHM(hm, deltaMin) {
  const m = String(hm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return hm;
  const mins = (((Number(m[1]) * 60 + Number(m[2]) + deltaMin) % 1440) + 1440) % 1440;
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

// Moves a dated time ("2026-09-22", "09:00") by deltaMin, carrying across midnight.
// Undated or blank times fall back to shiftHM, which only wraps the clock.
function shiftDateTime(date, hm, deltaMin) {
  const m = String(hm || '').match(/^(\d{1,2}):(\d{2})$/);
  const d = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || !d) return { date, hm: shiftHM(hm, deltaMin) };
  const day = Date.UTC(+d[1], +d[2] - 1, +d[3]) / 86400000;
  const total = day * 1440 + Number(m[1]) * 60 + Number(m[2]) + deltaMin;
  const newDay = Math.floor(total / 1440), rem = total - newDay * 1440;
  return {
    date: new Date(newDay * 86400000).toISOString().slice(0, 10),
    hm: `${String(Math.floor(rem / 60)).padStart(2, '0')}:${String(rem % 60).padStart(2, '0')}`,
  };
}

function emptySchedule() {
  const s = {};
  for (const k of SCHEDULE_MILESTONES) s[k] = { date: '', time: '', actual_date: '', actual_time: '' };
  return s;
}

// ── Row mappers ───────────────────────────────────────────────────────────────
function taskRow(r) {
  return {
    id: r.id, tag: r.tag, title: r.title, area: r.area, assignee: r.assignee,
    progress: r.progress, status: r.status, note: r.note, duration: r.duration,
    start_time: r.start_time, end_time: r.end_time,
    start_date: r.start_date || '', end_date: r.end_date || '',
    updated_at: r.updated_at, updated_by: r.updated_by, stage_at: r.stage_at || '',
    cancel_reason: r.cancel_reason || '', added: !!r.added, event_note: r.event_note || '',
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

function safetyRow(r) {
  return {
    id: r.id, text: r.text, responsible: r.responsible, datetime: r.datetime, status: r.status,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

function historyRow(r) {
  return {
    id: Number(r.id), plant: r.plant, start_date: r.start_date, end_date: r.end_date,
    total: r.total, done: r.done, cancelled: r.cancelled, touched: r.touched, added: r.added ?? 0,
    closed_by: r.closed_by, closed_at: iso(r.closed_at),
  };
}

function iso(v) { return v instanceof Date ? v.toISOString() : (v || null); }

// ── Schema bootstrap ──────────────────────────────────────────────────────────
// Ensures the four plant rows exist; the tables themselves come from schema.sql,
// applied by `npm run migrate`.
async function ensurePlants() {
  await query(
    `INSERT INTO shutdown_mnm_plants (name) SELECT unnest($1::text[])
     ON CONFLICT (name) DO NOTHING`,
    [PLANTS]
  );
}

async function seedAdminIfEmpty() {
  const { rows } = await query('SELECT 1 FROM shutdown_mnm_users LIMIT 1');
  if (rows.length) return;
  const salt = crypto.randomBytes(16).toString('hex');
  await query(
    `INSERT INTO shutdown_mnm_users (username, role, salt, hash)
     VALUES ('admin', 'admin', $1, $2) ON CONFLICT (username) DO NOTHING`,
    [salt, hashPassword('admin', salt)]
  );
  console.log('[db] seeded default admin user (username: admin / password: admin) — change it');
}

// Called once at startup from server.js before the HTTP listener binds.
async function init() {
  await ensurePlants();
  await seedAdminIfEmpty();
}

// ── Public API ────────────────────────────────────────────────────────────────
const db = {
  PLANTS,
  DEFAULT_PLANT,
  USER_ROLES,
  SCHEDULE_MILESTONES,
  SAFETY_CATEGORIES,
  init,
  hashPassword,

  // ── Schedule ────────────────────────────────────────────────────────────────
  async getSchedule(plant) {
    const { rows } = await query(
      'SELECT milestone, date, time, actual_date, actual_time FROM shutdown_mnm_schedule WHERE plant = $1',
      [plantKey(plant)]
    );
    const out = emptySchedule();
    for (const r of rows) {
      if (out[r.milestone]) {
        out[r.milestone] = {
          date: r.date, time: r.time,
          actual_date: r.actual_date, actual_time: r.actual_time
        };
      }
    }
    return out;
  },

  async saveSchedule(schedule, plant) {
    const p = plantKey(plant);
    const next = emptySchedule();
    for (const k of SCHEDULE_MILESTONES) {
      if (schedule && schedule[k]) {
        next[k] = {
          date: String(schedule[k].date || ''), time: String(schedule[k].time || ''),
          actual_date: String(schedule[k].actual_date || ''), actual_time: String(schedule[k].actual_time || '')
        };
      }
    }
    await withTx(async client => {
      for (const k of SCHEDULE_MILESTONES) {
        await client.query(
          `INSERT INTO shutdown_mnm_schedule (plant, milestone, date, time, actual_date, actual_time)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (plant, milestone) DO UPDATE SET
             date = EXCLUDED.date, time = EXCLUDED.time,
             actual_date = EXCLUDED.actual_date, actual_time = EXCLUDED.actual_time`,
          [p, k, next[k].date, next[k].time, next[k].actual_date, next[k].actual_time]
        );
      }
    });
    return next;
  },

  // ── Safety activities ───────────────────────────────────────────────────────
  async getSafetyActivities(plant) {
    const { rows } = await query(
      `SELECT category, id, text, responsible, datetime, status, created_at
       FROM shutdown_mnm_safety WHERE plant = $1 ORDER BY seq`,
      [plantKey(plant)]
    );
    const out = {};
    for (const c of SAFETY_CATEGORIES) out[c] = [];
    for (const r of rows) if (out[r.category]) out[r.category].push(safetyRow(r));
    return out;
  },

  async createSafetyActivity(category, { text, responsible = '', datetime = '', status = 'pending' }, plant) {
    if (!SAFETY_CATEGORIES.includes(category)) throw new Error('Invalid category');
    const p = plantKey(plant);
    return withTx(async client => {
      // UPDATE ... RETURNING takes a row lock, so concurrent creates can't
      // hand out the same SAFE-nnn id the way Math.max() over a JSON array did.
      const { rows: [seqRow] } = await client.query(
        'UPDATE shutdown_mnm_plants SET safety_seq = safety_seq + 1 WHERE name = $1 RETURNING safety_seq',
        [p]
      );
      const id = `SAFE-${String(seqRow.safety_seq).padStart(3, '0')}`;
      const { rows: [row] } = await client.query(
        `INSERT INTO shutdown_mnm_safety (plant, category, id, text, responsible, datetime, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, text, responsible, datetime, status, created_at`,
        [p, category, id, text, responsible, datetime, status]
      );
      return safetyRow(row);
    });
  },

  async updateSafetyActivity(category, id, { text, responsible, datetime, status }, plant) {
    if (!SAFETY_CATEGORIES.includes(category)) throw new Error('Invalid category');
    const { rows } = await query(
      `UPDATE shutdown_mnm_safety SET
         text        = COALESCE($4, text),
         responsible = COALESCE($5, responsible),
         datetime    = COALESCE($6, datetime),
         status      = COALESCE($7, status)
       WHERE plant = $1 AND category = $2 AND id = $3
       RETURNING id, text, responsible, datetime, status, created_at`,
      [plantKey(plant), category, id,
       text ?? null, responsible ?? null, datetime ?? null, status ?? null]
    );
    return rows.length ? safetyRow(rows[0]) : null;
  },

  async deleteSafetyActivity(category, id, plant) {
    if (!SAFETY_CATEGORIES.includes(category)) throw new Error('Invalid category');
    const { rows } = await query(
      `DELETE FROM shutdown_mnm_safety WHERE plant = $1 AND category = $2 AND id = $3
       RETURNING id, text, responsible, datetime, status, created_at`,
      [plantKey(plant), category, id]
    );
    return rows.length ? safetyRow(rows[0]) : null;
  },

  // ── Tasks ───────────────────────────────────────────────────────────────────
  async getTasks(plant) {
    const { rows } = await query(
      'SELECT * FROM shutdown_mnm_tasks WHERE plant = $1 ORDER BY seq',
      [plantKey(plant)]
    );
    return rows.map(taskRow);
  },

  async getTask(id, plant) {
    const { rows } = await query(
      'SELECT * FROM shutdown_mnm_tasks WHERE plant = $1 AND id = $2',
      [plantKey(plant), id]
    );
    return rows.length ? taskRow(rows[0]) : null;
  },

  async createTask({ tag, title, area, assignee, progress = 0, note = '', event_note = '', duration = '', start_time = '', end_time = '', start_date = '', end_date = '', updated_by = 'User', plant }) {
    const p = plantKey(plant);
    return withTx(async client => {
      const { rows: [seqRow] } = await client.query(
        'UPDATE shutdown_mnm_plants SET task_seq = task_seq + 1 WHERE name = $1 RETURNING task_seq',
        [p]
      );
      const id = `TASK-${String(seqRow.task_seq).padStart(3, '0')}`;
      const { rows: [row] } = await client.query(
        `INSERT INTO shutdown_mnm_tasks
           (plant, id, tag, title, area, assignee, progress, status, note, duration, start_time, end_time, updated_at, updated_by, added, event_note, start_date, end_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11,$12,$13,TRUE,$14,$15,$16) RETURNING *`,
        [p, id, String(tag).toUpperCase(), title, area, assignee, Number(progress) || 0,
         note, duration, start_time, end_time, nowTime(), updated_by, String(event_note || '').trim(),
         start_date, end_date]
      );
      return taskRow(row);
    });
  },

  async updateTaskProgress(id, progress, updated_by = 'User', plant) {
    const { rows } = await query(
      // stage_at only moves when the stage changes, so re-clicking 100% doesn't push
      // the close time (and the on-time/delay verdict) later.
      `UPDATE shutdown_mnm_tasks SET stage_at = CASE WHEN progress = $3 AND stage_at <> '' THEN stage_at ELSE $6 END,
         progress = $3, updated_at = $4, updated_by = $5
       WHERE plant = $1 AND id = $2 RETURNING *`,
      [plantKey(plant), id, Number(progress) || 0, nowTime(), updated_by, new Date().toISOString()]
    );
    return rows.length ? taskRow(rows[0]) : null;
  },

  async updateTaskStatus(id, status, updated_by = 'User', plant, cancel_reason = '') {
    const { rows } = await query(
      `UPDATE shutdown_mnm_tasks SET status = $3, updated_at = $4, updated_by = $5, stage_at = $6, cancel_reason = $7
       WHERE plant = $1 AND id = $2 RETURNING *`,
      [plantKey(plant), id, status, nowTime(), updated_by, new Date().toISOString(),
       status === 'cancelled' ? cancel_reason : '']
    );
    return rows.length ? taskRow(rows[0]) : null;
  },

  async updateTaskNote(id, note, updated_by = 'User', plant) {
    const { rows } = await query(
      `UPDATE shutdown_mnm_tasks SET note = $3, updated_at = $4, updated_by = $5
       WHERE plant = $1 AND id = $2 RETURNING *`,
      [plantKey(plant), id, note, nowTime(), updated_by]
    );
    return rows.length ? taskRow(rows[0]) : null;
  },

  // start_date / end_date: undefined keeps the stored date, '' clears it.
  async updateTaskTimes(id, { start_time, end_time, duration, start_date, end_date }, updated_by = 'User', plant) {
    const { rows } = await query(
      `UPDATE shutdown_mnm_tasks SET start_time = $3, end_time = $4, duration = $5, updated_at = $6, updated_by = $7,
         start_date = COALESCE($8, start_date), end_date = COALESCE($9, end_date)
       WHERE plant = $1 AND id = $2 RETURNING *`,
      [plantKey(plant), id, start_time, end_time, duration, nowTime(), updated_by, start_date ?? null, end_date ?? null]
    );
    return rows.length ? taskRow(rows[0]) : null;
  },

  // Edit Work form: every editable field at once. start_date / end_date: undefined keeps
  // the stored date. stage_at moves only when the stage changes, as in updateTaskProgress.
  async updateTaskDetails(id, f, updated_by = 'User', plant) {
    const { rows } = await query(
      `UPDATE shutdown_mnm_tasks SET tag = $3, title = $4, area = $5, assignee = $6,
         stage_at = CASE WHEN progress = $7 AND stage_at <> '' THEN stage_at ELSE $8 END, progress = $7,
         event_note = $9, start_time = $10, end_time = $11, duration = $12,
         start_date = COALESCE($13, start_date), end_date = COALESCE($14, end_date),
         updated_at = $15, updated_by = $16
       WHERE plant = $1 AND id = $2 RETURNING *`,
      [plantKey(plant), id, String(f.tag).toUpperCase(), f.title, f.area, f.assignee,
       Number(f.progress) || 0, new Date().toISOString(), f.event_note, f.start_time, f.end_time, f.duration,
       f.start_date ?? null, f.end_date ?? null, nowTime(), updated_by]
    );
    return rows.length ? taskRow(rows[0]) : null;
  },

  async updateTaskEventNote(id, note, updated_by = 'User', plant) {
    const { rows } = await query(
      `UPDATE shutdown_mnm_tasks SET event_note = $3, updated_at = $4, updated_by = $5
       WHERE plant = $1 AND id = $2 RETURNING *`,
      [plantKey(plant), id, note, nowTime(), updated_by]
    );
    return rows.length ? taskRow(rows[0]) : null;
  },

  async deleteTask(id, plant) {
    const { rows } = await query(
      'DELETE FROM shutdown_mnm_tasks WHERE plant = $1 AND id = $2 RETURNING *',
      [plantKey(plant), id]
    );
    return rows.length ? taskRow(rows[0]) : null;
  },

  async clearAllTasks(plant) {
    const p = plantKey(plant);
    return withTx(async client => {
      const { rowCount } = await client.query('DELETE FROM shutdown_mnm_tasks WHERE plant = $1', [p]);
      await client.query(
        'UPDATE shutdown_mnm_plants SET last_excel_upload = NULL, task_seq = 0 WHERE name = $1',
        [p]
      );
      return rowCount;
    });
  },

  async clearAllSafetyActivities(plant) {
    const p = plantKey(plant);
    return withTx(async client => {
      const { rowCount } = await client.query('DELETE FROM shutdown_mnm_safety WHERE plant = $1', [p]);
      await client.query('UPDATE shutdown_mnm_plants SET safety_seq = 0 WHERE name = $1', [p]);
      return rowCount;
    });
  },

  async getLastExcelUpload(plant) {
    const { rows } = await query(
      'SELECT last_excel_upload FROM shutdown_mnm_plants WHERE name = $1',
      [plantKey(plant)]
    );
    return rows.length ? rows[0].last_excel_upload : null;
  },

  async setLastExcelUpload(plant, info) {
    await query(
      'UPDATE shutdown_mnm_plants SET last_excel_upload = $2 WHERE name = $1',
      [plantKey(plant), info]
    );
    return info;
  },

  // Postpones (or brings forward) the whole shutdown by deltaMin minutes: every task's
  // HH:MM moves by the same amount and the frame fields (baseDate, gridStartMin, the
  // rangeStart/rangeEnd window) are merged into last_excel_upload, so each task keeps
  // its position relative to the others and its duration.
  async shiftShutdown(plant, deltaMin, frame) {
    const p = plantKey(plant);
    return withTx(async client => {
      let shifted = 0;
      // Undated tasks only carry a clock time, so a whole-day shift leaves them alone;
      // multi-day tasks carry their dates too, which always move.
      if (deltaMin !== 0) {
        const { rows } = await client.query(
          'SELECT id, start_time, end_time, start_date, end_date FROM shutdown_mnm_tasks WHERE plant = $1 FOR UPDATE', [p]
        );
        const ids = [], starts = [], ends = [], sDates = [], eDates = [];
        for (const r of rows) {
          const s = shiftDateTime(r.start_date, r.start_time, deltaMin);
          const e = shiftDateTime(r.end_date, r.end_time, deltaMin);
          if (s.hm === r.start_time && e.hm === r.end_time && s.date === r.start_date && e.date === r.end_date) continue;
          ids.push(r.id); starts.push(s.hm); ends.push(e.hm); sDates.push(s.date); eDates.push(e.date);
        }
        if (ids.length) {
          const res = await client.query(
            `UPDATE shutdown_mnm_tasks t SET start_time = u.s, end_time = u.e, start_date = u.sd, end_date = u.ed
             FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS u(id, s, e, sd, ed)
             WHERE t.plant = $1 AND t.id = u.id`,
            [p, ids, starts, ends, sDates, eDates]
          );
          shifted = res.rowCount;
        }
      }
      const { rows } = await client.query(
        `UPDATE shutdown_mnm_plants SET last_excel_upload = COALESCE(last_excel_upload, '{}'::jsonb) || $2::jsonb
         WHERE name = $1 RETURNING last_excel_upload`,
        [p, JSON.stringify(frame)]
      );
      return { shifted, lastUpload: rows.length ? rows[0].last_excel_upload : null };
    });
  },

  async bulkInsertTasks(tasks, plant) {
    if (!tasks.length) return 0;
    const p = plantKey(plant);
    return withTx(async client => {
      const { rows: [seqRow] } = await client.query(
        'UPDATE shutdown_mnm_plants SET task_seq = task_seq + $2 WHERE name = $1 RETURNING task_seq',
        [p, tasks.length]
      );
      let counter = seqRow.task_seq - tasks.length;
      for (const t of tasks) {
        counter++;
        await client.query(
          `INSERT INTO shutdown_mnm_tasks
             (plant, id, tag, title, area, assignee, progress, status, note, duration, start_time, end_time, start_date, end_date, updated_at, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11,$12,$13,$14,$15)`,
          [p, `TASK-${String(counter).padStart(3, '0')}`,
           t.tag || '', t.title || '', t.area || '', t.assignee || '',
           Number(t.progress) || 0, t.note || '', t.duration || '',
           t.start_time || '', t.end_time || '', t.start_date || '', t.end_date || '',
           t.updated_at || '', t.updated_by || 'Excel Import']
        );
      }
      return tasks.length;
    });
  },

  // ── Users ───────────────────────────────────────────────────────────────────
  async verifyLogin(username, password) {
    const { rows } = await query(
      'SELECT username, role, salt, hash, last_login FROM shutdown_mnm_users WHERE username = $1',
      [username]
    );
    if (!rows.length) return null;
    const user = rows[0];
    // Entra-only accounts have no local password to check against.
    if (!user.hash || !user.salt) return null;

    const expected = Buffer.from(user.hash, 'hex');
    const actual = crypto.scryptSync(password, user.salt, 64);
    // Constant-time compare so a wrong password can't be narrowed down by timing.
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;

    const prevLogin = iso(user.last_login);
    await query('UPDATE shutdown_mnm_users SET last_login = now() WHERE username = $1', [username]);
    return { username: user.username, role: user.role, last_login: prevLogin };
  },

  async getLastLogin(username) {
    const { rows } = await query('SELECT last_login FROM shutdown_mnm_users WHERE username = $1', [username]);
    return rows.length ? iso(rows[0].last_login) : null;
  },

  async listUsers() {
    const { rows } = await query(
      'SELECT username, role, email, entra_oid, created_at FROM shutdown_mnm_users ORDER BY created_at'
    );
    return rows.map(r => ({
      username: r.username, role: r.role, email: r.email,
      auth: r.entra_oid ? 'entra' : 'local', created_at: iso(r.created_at),
    }));
  },

  // Looks the user up by Entra object id; first sign-in creates a read-only
  // User. Never links to an existing local account by name — that would let
  // anyone whose email matches a local username take it over.
  async findOrCreateEntraUser({ oid, username, email, name }) {
    const touch = async () => {
      const { rows } = await query(
        'SELECT username, role, last_login FROM shutdown_mnm_users WHERE entra_oid = $1', [oid]
      );
      if (!rows.length) return null;
      await query(
        'UPDATE shutdown_mnm_users SET last_login = now(), email = $2, display_name = $3 WHERE entra_oid = $1',
        [oid, email, name]
      );
      return { username: rows[0].username, role: rows[0].role, last_login: iso(rows[0].last_login) };
    };

    const existing = await touch();
    if (existing) return existing;
    try {
      await query(
        `INSERT INTO shutdown_mnm_users (username, role, entra_oid, email, display_name, last_login)
         VALUES ($1, 'user', $2, $3, $4, now())`,
        [username, oid, email, name]
      );
      return { username, role: 'user', last_login: null };
    } catch (err) {
      if (err.code !== '23505') throw err;
      // Lost a race with a concurrent first sign-in of the same oid, or the name is taken.
      const raced = await touch();
      if (raced) return raced;
      throw new Error('This account name is already used by another user', { cause: err });
    }
  },

  async setUserRole(username, role) {
    if (!USER_ROLES.includes(role)) throw new Error('Invalid role');
    await withTx(async client => {
      const { rows } = await client.query(
        'SELECT role FROM shutdown_mnm_users WHERE username = $1 FOR UPDATE', [username]
      );
      if (!rows.length) throw new Error('User not found');
      if (rows[0].role === 'admin' && role !== 'admin') {
        const { rows: [c] } = await client.query(
          `SELECT count(*)::int AS n FROM shutdown_mnm_users WHERE role = 'admin' AND username <> $1`,
          [username]
        );
        if (c.n === 0) throw new Error('Cannot demote the last admin');
      }
      await client.query('UPDATE shutdown_mnm_users SET role = $2 WHERE username = $1', [username, role]);
      // Live sessions carry a copy of the role; keep them in step.
      await client.query('UPDATE shutdown_mnm_sessions SET role = $2 WHERE username = $1', [username, role]);
    });
  },

  async createUser({ username, password, role = 'user' }) {
    if (!USER_ROLES.includes(role)) throw new Error('Invalid role');
    const salt = crypto.randomBytes(16).toString('hex');
    try {
      await query(
        'INSERT INTO shutdown_mnm_users (username, role, salt, hash) VALUES ($1, $2, $3, $4)',
        [username, role, salt, hashPassword(password, salt)]
      );
    } catch (err) {
      if (err.code === '23505') throw new Error('Username already exists', { cause: err });
      throw err;
    }
    return { username, role };
  },

  async deleteUser(username) {
    await withTx(async client => {
      const { rows } = await client.query(
        'SELECT role FROM shutdown_mnm_users WHERE username = $1 FOR UPDATE',
        [username]
      );
      if (!rows.length) throw new Error('User not found');
      if (rows[0].role === 'admin') {
        const { rows: [c] } = await client.query(
          `SELECT count(*)::int AS n FROM shutdown_mnm_users WHERE role = 'admin' AND username <> $1`,
          [username]
        );
        if (c.n === 0) throw new Error('Cannot delete the last admin');
      }
      await client.query('DELETE FROM shutdown_mnm_users WHERE username = $1', [username]);
      await client.query('DELETE FROM shutdown_mnm_sessions WHERE username = $1', [username]);
    });
  },

  // ── Sessions ────────────────────────────────────────────────────────────────
  // Stored in Postgres so a user stays signed in across Cloud Run instances.
  async createSession(token, username, role, ttlHours = 12) {
    await query(
      `INSERT INTO shutdown_mnm_sessions (token, username, role, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval)`,
      [token, username, role, String(ttlHours)]
    );
  },

  async getSession(token) {
    const { rows } = await query(
      'SELECT username, role FROM shutdown_mnm_sessions WHERE token = $1 AND expires_at > now()',
      [token]
    );
    return rows.length ? rows[0] : null;
  },

  async deleteSession(token) {
    await query('DELETE FROM shutdown_mnm_sessions WHERE token = $1', [token]);
  },

  async purgeExpiredSessions() {
    const { rowCount } = await query('DELETE FROM shutdown_mnm_sessions WHERE expires_at <= now()');
    return rowCount;
  },

  // ── Shutdown history (closed shutdowns) ─────────────────────────────────────
  // The plant's current shutdown — dates from the edited range, the Excel grid or
  // the milestone schedule, counts from its tasks — or null when it has no date.
  async getShutdownSnapshot(plant, client = { query }) {
    const p = plantKey(plant);
    // Sequential: inside closeShutdown these share one transaction client.
    const { rows: [c] } = await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status <> 'cancelled' AND progress = 100)::int AS done,
                count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
                count(*) FILTER (WHERE progress > 0 OR status = 'cancelled')::int AS touched,
                count(*) FILTER (WHERE added AND status <> 'cancelled')::int AS added
         FROM shutdown_mnm_tasks WHERE plant = $1`, [p]);
    const { rows: [pl] } = await client.query('SELECT last_excel_upload FROM shutdown_mnm_plants WHERE name = $1', [p]);
    const { rows: sched } = await client.query(
      'SELECT milestone, date, time, actual_date, actual_time FROM shutdown_mnm_schedule WHERE plant = $1', [p]);
    const upload = pl?.last_excel_upload || null;
    const schedule = emptySchedule();
    for (const r of sched) {
      if (schedule[r.milestone]) {
        schedule[r.milestone] = { date: r.date, time: r.time, actual_date: r.actual_date, actual_time: r.actual_time };
      }
    }
    const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
    const start = [upload?.rangeStart?.slice(0, 10), upload?.baseDate, schedule.shutdown.date].find(isDate);
    if (!start) return null;
    const end = [upload?.rangeEnd?.slice(0, 10), schedule.on_reel.date, schedule.startup.date].find(isDate) || start;
    return { plant: p, start_date: start, end_date: end < start ? start : end,
      file_name: upload?.fileName || '', schedule, ...c,
      upload: { uploadedAt: upload?.uploadedAt || '', rangeStart: upload?.rangeStart || '', rangeEnd: upload?.rangeEnd || '' } };
  },

  // Copies the current shutdown (tasks, safety items, milestones) into history.
  // With reset, the plant is then emptied so the next shutdown starts from scratch.
  // Only "Close shutdown" calls this. Returns the record,
  // or null when there is nothing to keep (no tasks, or no shutdown date).
  async closeShutdown(plant, closedBy = 'User', { reset = false } = {}) {
    const p = plantKey(plant);
    return withTx(async client => {
      // Lock the plant row so two closes can't interleave.
      await client.query('SELECT 1 FROM shutdown_mnm_plants WHERE name = $1 FOR UPDATE', [p]);
      const s = await this.getShutdownSnapshot(p, client);
      if (!s || !s.total) return null;
      const { rows: tasks } = await client.query(
        'SELECT * FROM shutdown_mnm_tasks WHERE plant = $1 ORDER BY seq', [p]);
      const { rows: safetyRows } = await client.query(
        `SELECT category, id, text, responsible, datetime, status, created_at
         FROM shutdown_mnm_safety WHERE plant = $1 ORDER BY seq`, [p]);
      const safety = {};
      for (const c of SAFETY_CATEGORIES) safety[c] = [];
      for (const r of safetyRows) if (safety[r.category]) safety[r.category].push(safetyRow(r));
      const { rows: [rec] } = await client.query(
        `INSERT INTO shutdown_mnm_history
           (plant, start_date, end_date, total, done, cancelled, touched, added, file_name, upload,
            schedule, tasks, safety, closed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (plant, start_date) DO UPDATE SET
           end_date = EXCLUDED.end_date, total = EXCLUDED.total, done = EXCLUDED.done,
           cancelled = EXCLUDED.cancelled, touched = EXCLUDED.touched, added = EXCLUDED.added,
           file_name = EXCLUDED.file_name, upload = EXCLUDED.upload,
           schedule = EXCLUDED.schedule, tasks = EXCLUDED.tasks, safety = EXCLUDED.safety,
           closed_by = EXCLUDED.closed_by, closed_at = now()
         RETURNING id, plant, start_date, end_date, total, done, cancelled, touched, added, closed_by, closed_at`,
        [p, s.start_date, s.end_date, s.total, s.done, s.cancelled, s.touched, s.added, s.file_name,
         JSON.stringify(s.upload), JSON.stringify(s.schedule), JSON.stringify(tasks.map(taskRow)),
         JSON.stringify(safety), closedBy]
      );
      if (reset) {
        await client.query('DELETE FROM shutdown_mnm_tasks WHERE plant = $1', [p]);
        await client.query('DELETE FROM shutdown_mnm_safety WHERE plant = $1', [p]);
        await client.query('DELETE FROM shutdown_mnm_schedule WHERE plant = $1', [p]);
        await client.query(
          'UPDATE shutdown_mnm_plants SET last_excel_upload = NULL, task_seq = 0, safety_seq = 0 WHERE name = $1', [p]);
      }
      return historyRow(rec);
    });
  },

  // Summaries only (no task lists); plant and/or year narrow the list.
  async listHistory({ plant, year } = {}) {
    const where = [], args = [];
    if (plant) { args.push(plantKey(plant)); where.push(`plant = $${args.length}`); }
    if (year)  { args.push(`${year}-%`);    where.push(`start_date LIKE $${args.length}`); }
    const { rows } = await query(
      `SELECT id, plant, start_date, end_date, total, done, cancelled, touched, added, closed_by, closed_at
       FROM shutdown_mnm_history ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY start_date DESC`, args
    );
    return rows.map(historyRow);
  },

  async getHistory(id) {
    const { rows } = await query('SELECT * FROM shutdown_mnm_history WHERE id = $1', [id]);
    return rows.length ? { ...historyRow(rows[0]), file_name: rows[0].file_name, upload: rows[0].upload,
      schedule: rows[0].schedule, tasks: rows[0].tasks, safety: rows[0].safety } : null;
  },

  async deleteHistory(id) {
    const { rows } = await query(
      'DELETE FROM shutdown_mnm_history WHERE id = $1 RETURNING id, plant, start_date', [id]);
    return rows[0] || null;
  },

  // ── Activity ────────────────────────────────────────────────────────────────
  async getActivity(limit = 30, plant) {
    const { rows } = await query(
      `SELECT id, tag, action, actor, created_at FROM shutdown_mnm_activity
       WHERE plant = $1 ORDER BY id DESC LIMIT $2`,
      [plantKey(plant), limit]
    );
    return rows.map(r => ({ id: Number(r.id), tag: r.tag, action: r.action, actor: r.actor, created_at: iso(r.created_at) }));
  },

  async logActivity(tag, action, actor = 'System', plant) {
    const p = plantKey(plant);
    await query(
      'INSERT INTO shutdown_mnm_activity (plant, tag, action, actor) VALUES ($1, $2, $3, $4)',
      [p, tag, action, actor]
    );
    // Keep a year of history (for the activity export); prune at most once an hour.
    if (Date.now() - lastActivityPrune > 3600 * 1000) {
      lastActivityPrune = Date.now();
      await query(`DELETE FROM shutdown_mnm_activity WHERE created_at < now() - $1::interval`, [ACTIVITY_RETENTION]);
    }
  },

  // Activity export: rows between two instants, optionally for one plant and/or actor.
  async getActivityRange({ plant, from, to, actor }) {
    const args = [from, to];
    const where = ['created_at >= $1', 'created_at < $2'];
    if (plant) { args.push(plant); where.push(`plant = $${args.length}`); }
    if (actor) { args.push(actor); where.push(`actor = $${args.length}`); }
    args.push(ACTIVITY_EXPORT_MAX);
    const { rows } = await query(
      `SELECT id, plant, tag, action, actor, created_at FROM shutdown_mnm_activity
       WHERE ${where.join(' AND ')} ORDER BY created_at, id LIMIT $${args.length}`, args
    );
    return rows.map(r => ({ id: Number(r.id), plant: r.plant, tag: r.tag, action: r.action, actor: r.actor, created_at: iso(r.created_at) }));
  },

  // Everyone who appears in the retained history, for the export dialog's user filter.
  async getActivityActors(plant) {
    const { rows } = await query(
      `SELECT actor, COUNT(*)::int AS n FROM shutdown_mnm_activity
       ${plant ? 'WHERE plant = $1' : ''} GROUP BY actor ORDER BY actor`,
      plant ? [plant] : []
    );
    return rows;
  },
};

module.exports = db;
