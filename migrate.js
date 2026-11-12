#!/usr/bin/env node
// One-time migration: data.json -> PostgreSQL (ai_project.shutdown_mnm_*).
//
//   node migrate.js              apply schema.sql, then import data.json
//   node migrate.js --schema-only    create tables, import nothing
//   node migrate.js --reset      TRUNCATE the shutdown_mnm_* tables first
//
// Safe to re-run: without --reset it refuses to import into non-empty tables.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool, query, withTx, SCHEMA } = require('./pool');

const DATA_FILE = path.join(__dirname, 'data.json');
const PLANTS = ['SKIC BM1', 'SKIC BM3', 'SKIC BM17', 'SKIC BM16',
  'TPC Paper BP PM2', 'TPC Paper BP PM3', 'TPC Paper BP PM4', 'TPC Paper BP PM5', 'TPC Paper BP SNP',
  'SKIC WS BM4', 'SKIC WS BM5', 'SKIC WS BM6', 'SKIC WS BM7', 'SKIC WS BM8', 'SKIC WS BM9',
  'TCP TM BM10',
  'TPC Pulp BP CP', 'TPC Pulp BP SCP', 'TPC Pulp BP RB', 'TPC Pulp BP Chipping', 'TPC Pulp BP ECO',
  'TPC Pulp WS CP', 'TPC Pulp WS UBP', 'TPC Pulp WS RB', 'TPC Pulp WS Chipping',
  'SKIC Energy BP PB#11', 'SKIC Energy BP PB#12', 'SKIC Energy BP PB#16', 'SKIC Energy BP PB#17-TRP', 'SKIC Energy BP PB#19',
  'SKIC Energy BP TG#11', 'SKIC Energy BP TG#12', 'SKIC Energy BP TG#16', 'SKIC Energy BP TG#17-TRP', 'SKIC Energy BP TG#19',
  'SKIC Energy WS PB#14', 'SKIC Energy WS PB#18', 'SKIC Energy WS TG#14', 'SKIC Energy WS TG#18', 'SKIC Energy WS TG#6',
  'TCP Energy TM PB#2', 'TCP Energy TM TG#2'];
const SCHEDULE_MILESTONES = ['shutdown', 'repair_done', 'warm_stream', 'function_test', 'startup', 'on_reel'];
const SAFETY_CATEGORIES = ['power_outage', 'site_prep', 'high_risk'];

const args = process.argv.slice(2);
const schemaOnly = args.includes('--schema-only');
const reset = args.includes('--reset');

function log(...a) { console.log('  ', ...a); }

async function applySchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await query(sql);
  const { rows } = await query(
    `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'shutdown_mnm_%' ORDER BY 1`,
    [SCHEMA]
  );
  log(`schema applied — ${rows.length} tables:`, rows.map(r => r.tablename).join(', '));
}

async function resetTables() {
  await query(`TRUNCATE
    shutdown_mnm_sessions, shutdown_mnm_activity, shutdown_mnm_safety,
    shutdown_mnm_schedule, shutdown_mnm_tasks, shutdown_mnm_users,
    shutdown_mnm_plants RESTART IDENTITY CASCADE`);
  log('existing shutdown_mnm_* rows truncated');
}

async function isEmpty() {
  const { rows } = await query(
    `SELECT (SELECT count(*) FROM shutdown_mnm_tasks)::int AS tasks,
            (SELECT count(*) FROM shutdown_mnm_users)::int AS users`
  );
  return rows[0].tasks === 0 && rows[0].users === 0;
}

// Excel-imported rows carry no explicit timestamp; fall back to file mtime so
// ordering in the UI stays stable rather than collapsing to "now".
function tsOr(value, fallback) {
  const d = value ? new Date(value) : null;
  return d && !isNaN(d) ? d.toISOString() : fallback;
}

async function importData() {
  if (!fs.existsSync(DATA_FILE)) { log('no data.json found — nothing to import'); return; }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const fallbackTs = fs.statSync(DATA_FILE).mtime.toISOString();

  const counts = { plants: 0, users: 0, tasks: 0, activity: 0, schedule: 0, safety: 0 };

  await withTx(async client => {
    // Plants
    for (const name of PLANTS) {
      await client.query(
        'INSERT INTO shutdown_mnm_plants (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
        [name]
      );
      counts.plants++;
    }

    // Users — scrypt salt+hash carry over verbatim, so nobody resets a password.
    for (const u of data.users || []) {
      await client.query(
        `INSERT INTO shutdown_mnm_users (username, role, salt, hash, last_login, created_at)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (username) DO NOTHING`,
        [u.username, u.role || 'user', u.salt, u.hash,
         u.last_login ? new Date(u.last_login) : null, tsOr(u.created_at, fallbackTs)]
      );
      counts.users++;
    }

    for (const [plantName, p] of Object.entries(data.plants || {})) {
      if (!PLANTS.includes(plantName)) { log(`skipping unknown plant "${plantName}"`); continue; }

      // Tasks — preserve the original TASK-nnn ids the UI and activity log reference.
      let maxTaskNum = 0;
      for (const t of p.tasks || []) {
        const n = parseInt(String(t.id).replace('TASK-', ''), 10);
        if (!isNaN(n) && n > maxTaskNum) maxTaskNum = n;
        await client.query(
          `INSERT INTO shutdown_mnm_tasks
             (plant, id, tag, title, area, assignee, progress, status, note, duration,
              start_time, end_time, updated_at, updated_by, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (plant, id) DO NOTHING`,
          [plantName, t.id, t.tag || '', t.title || '', t.area || '', t.assignee || '',
           Number(t.progress) || 0, t.status || 'active', t.note || '', t.duration || '',
           t.start_time || '', t.end_time || '', t.updated_at || '', t.updated_by || '',
           tsOr(t.created_at, fallbackTs)]
        );
        counts.tasks++;
      }

      // Safety activities
      let maxSafeNum = 0;
      for (const cat of SAFETY_CATEGORIES) {
        for (const s of (p.safetyActivities && p.safetyActivities[cat]) || []) {
          const n = parseInt(String(s.id).replace('SAFE-', ''), 10);
          if (!isNaN(n) && n > maxSafeNum) maxSafeNum = n;
          await client.query(
            `INSERT INTO shutdown_mnm_safety
               (plant, category, id, text, responsible, datetime, status, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (plant, category, id) DO NOTHING`,
            [plantName, cat, s.id, s.text || '', s.responsible || '',
             s.datetime || '', s.status || 'pending', tsOr(s.created_at, fallbackTs)]
          );
          counts.safety++;
        }
      }

      // Counters continue from the highest id seen, so new rows never collide
      // with migrated ones.
      await client.query(
        'UPDATE shutdown_mnm_plants SET task_seq = $2, safety_seq = $3, last_excel_upload = $4 WHERE name = $1',
        [plantName, maxTaskNum, maxSafeNum, p.lastExcelUpload || null]
      );

      // Schedule
      for (const m of SCHEDULE_MILESTONES) {
        const v = (p.schedule && p.schedule[m]) || { date: '', time: '' };
        await client.query(
          `INSERT INTO shutdown_mnm_schedule (plant, milestone, date, time) VALUES ($1,$2,$3,$4)
           ON CONFLICT (plant, milestone) DO UPDATE SET date = EXCLUDED.date, time = EXCLUDED.time`,
          [plantName, m, String(v.date || ''), String(v.time || '')]
        );
        counts.schedule++;
      }

      // Activity — id is a fresh BIGSERIAL; insertion order preserves the
      // original sequence, which is all the feed's "newest first" sort needs.
      for (const a of [...(p.activity || [])].sort((x, y) => x.id - y.id)) {
        await client.query(
          `INSERT INTO shutdown_mnm_activity (plant, tag, action, actor, created_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [plantName, a.tag || '', a.action || '', a.actor || 'System', tsOr(a.created_at, fallbackTs)]
        );
        counts.activity++;
      }
    }
  });

  log('imported:', Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '));
}

async function verify() {
  const { rows: [r] } = await query(
    `SELECT (SELECT count(*) FROM shutdown_mnm_users)::int    AS users,
            (SELECT count(*) FROM shutdown_mnm_tasks)::int    AS tasks,
            (SELECT count(*) FROM shutdown_mnm_activity)::int AS activity,
            (SELECT count(*) FROM shutdown_mnm_safety)::int   AS safety,
            (SELECT count(*) FROM shutdown_mnm_schedule)::int AS schedule`
  );
  log('in database:', Object.entries(r).map(([k, v]) => `${k}=${v}`).join('  '));

  const { rows: perPlant } = await query(
    `SELECT p.name, count(t.id)::int AS tasks
     FROM shutdown_mnm_plants p LEFT JOIN shutdown_mnm_tasks t ON t.plant = p.name
     GROUP BY p.name ORDER BY p.name`
  );
  for (const p of perPlant) log(`  ${p.name}: ${p.tasks} tasks`);
}

(async () => {
  console.log(`\n  Shutdown Management — migrate to ${process.env.DB_NAME}.${SCHEMA}\n`);
  try {
    await applySchema();
    if (schemaOnly) { log('--schema-only: skipping data import'); return; }
    if (reset) await resetTables();
    else if (!await isEmpty()) {
      log('tables already contain data — re-run with --reset to overwrite. Aborting import.');
      await verify();
      return;
    }
    await importData();
    await verify();
    log('done.');
  } catch (err) {
    console.error('\n  MIGRATION FAILED:', err.message, '\n');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
