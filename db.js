// PostgreSQL data layer (schema: ai_project, tables prefixed shutdown_mnm_).
// Every method is async; server.js awaits them.
const crypto = require('crypto');
const { query, withTx } = require('./pool');

const DEFAULT_PLANT = 'SKIC BM16';
const PLANTS = ['SKIC BM1', 'SKIC BM3', 'SKIC BM17', 'SKIC BM16'];

const SCHEDULE_MILESTONES = ['shutdown', 'repair_done', 'warm_stream', 'function_test', 'startup', 'on_reel'];
const SAFETY_CATEGORIES = ['power_outage', 'site_prep', 'high_risk'];

const USER_ROLES = ['admin', 'user'];

const ACTIVITY_KEEP = 200; // rows retained per plant

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function nowTime() {
  const n = new Date();
  return `${n.getHours().toString().padStart(2, '0')}:${n.getMinutes().toString().padStart(2, '0')} น.`;
}

function plantKey(plant) { return PLANTS.includes(plant) ? plant : DEFAULT_PLANT; }

function emptySchedule() {
  const s = {};
  for (const k of SCHEDULE_MILESTONES) s[k] = { date: '', time: '' };
  return s;
}

// ── Row mappers ───────────────────────────────────────────────────────────────
function taskRow(r) {
  return {
    id: r.id, tag: r.tag, title: r.title, area: r.area, assignee: r.assignee,
    progress: r.progress, status: r.status, note: r.note, duration: r.duration,
    start_time: r.start_time, end_time: r.end_time,
    updated_at: r.updated_at, updated_by: r.updated_by,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

function safetyRow(r) {
  return {
    id: r.id, text: r.text, responsible: r.responsible, datetime: r.datetime, status: r.status,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
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
      'SELECT milestone, date, time FROM shutdown_mnm_schedule WHERE plant = $1',
      [plantKey(plant)]
    );
    const out = emptySchedule();
    for (const r of rows) if (out[r.milestone]) out[r.milestone] = { date: r.date, time: r.time };
    return out;
  },

  async saveSchedule(schedule, plant) {
    const p = plantKey(plant);
    const next = emptySchedule();
    for (const k of SCHEDULE_MILESTONES) {
      if (schedule && schedule[k]) {
        next[k] = { date: String(schedule[k].date || ''), time: String(schedule[k].time || '') };
      }
    }
    await withTx(async client => {
      for (const k of SCHEDULE_MILESTONES) {
        await client.query(
          `INSERT INTO shutdown_mnm_schedule (plant, milestone, date, time)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (plant, milestone) DO UPDATE SET date = EXCLUDED.date, time = EXCLUDED.time`,
          [p, k, next[k].date, next[k].time]
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

  async createTask({ tag, title, area, assignee, progress = 0, note = '', duration = '', start_time = '', end_time = '', updated_by = 'User', plant }) {
    const p = plantKey(plant);
    return withTx(async client => {
      const { rows: [seqRow] } = await client.query(
        'UPDATE shutdown_mnm_plants SET task_seq = task_seq + 1 WHERE name = $1 RETURNING task_seq',
        [p]
      );
      const id = `TASK-${String(seqRow.task_seq).padStart(3, '0')}`;
      const { rows: [row] } = await client.query(
        `INSERT INTO shutdown_mnm_tasks
           (plant, id, tag, title, area, assignee, progress, status, note, duration, start_time, end_time, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11,$12,$13) RETURNING *`,
        [p, id, String(tag).toUpperCase(), title, area, assignee, Number(progress) || 0,
         note, duration, start_time, end_time, nowTime(), updated_by]
      );
      return taskRow(row);
    });
  },

  async updateTaskProgress(id, progress, updated_by = 'User', plant) {
    const { rows } = await query(
      `UPDATE shutdown_mnm_tasks SET progress = $3, updated_at = $4, updated_by = $5
       WHERE plant = $1 AND id = $2 RETURNING *`,
      [plantKey(plant), id, Number(progress) || 0, nowTime(), updated_by]
    );
    return rows.length ? taskRow(rows[0]) : null;
  },

  async updateTaskStatus(id, status, updated_by = 'User', plant) {
    const { rows } = await query(
      `UPDATE shutdown_mnm_tasks SET status = $3, updated_at = $4, updated_by = $5
       WHERE plant = $1 AND id = $2 RETURNING *`,
      [plantKey(plant), id, status, nowTime(), updated_by]
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

  async updateTaskTimes(id, { start_time, end_time, duration }, updated_by = 'User', plant) {
    const { rows } = await query(
      `UPDATE shutdown_mnm_tasks SET start_time = $3, end_time = $4, duration = $5, updated_at = $6, updated_by = $7
       WHERE plant = $1 AND id = $2 RETURNING *`,
      [plantKey(plant), id, start_time, end_time, duration, nowTime(), updated_by]
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
             (plant, id, tag, title, area, assignee, progress, status, note, duration, start_time, end_time, updated_at, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11,$12,$13)`,
          [p, `TASK-${String(counter).padStart(3, '0')}`,
           t.tag || '', t.title || '', t.area || '', t.assignee || '',
           Number(t.progress) || 0, t.note || '', t.duration || '',
           t.start_time || '', t.end_time || '', t.updated_at || '', t.updated_by || 'Excel Import']
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
    // Same 200-row cap the JSON store enforced, applied per plant.
    await query(
      `DELETE FROM shutdown_mnm_activity WHERE plant = $1 AND id NOT IN (
         SELECT id FROM shutdown_mnm_activity WHERE plant = $1 ORDER BY id DESC LIMIT $2
       )`,
      [p, ACTIVITY_KEEP]
    );
  },
};

module.exports = db;
