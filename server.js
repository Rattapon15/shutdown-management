require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const XLSX    = require('xlsx');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const crypto  = require('crypto');
const db      = require('./db');
const { sign, unsign } = require('./security');
const entra   = require('./entra');
const { pool } = require('./pool');

const app  = express();
// Cloud Run injects PORT and requires binding 0.0.0.0.
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

app.set('trust proxy', true); // Cloud Run terminates TLS upstream
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Entra redirects back here; the SPA's MSAL code finishes the sign-in on this page.
app.get('/oauth2/callback', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Wraps an async route so a rejected promise becomes a 500 instead of an
// unhandled rejection that takes the process down.
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ─── Session handling (cookie -> Postgres-backed session) ─────────────────────
// Sessions live in the database, not process memory, so a signed-in user keeps
// their session when Cloud Run routes them to a different instance.
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);
const SECURE_COOKIES = process.env.NODE_ENV === 'production';

function cookieAttrs(maxAge, cookiePath = '/') {
  return [
    'HttpOnly', `Path=${cookiePath}`, 'SameSite=Lax',
    SECURE_COOKIES ? 'Secure' : null,
    maxAge !== undefined ? `Max-Age=${maxAge}` : null,
  ].filter(Boolean).join('; ');
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return cookies;
}

// The sid cookie is "<token>.<hmac>"; the signature is checked before the
// database is touched, so forged or garbage cookies cost nothing.
function sessionToken(req) {
  const signed = parseCookies(req).sid;
  return signed ? unsign(signed) : null;
}

const requireAuth = ah(async (req, res, next) => {
  const token = sessionToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const session = await db.getSession(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  req.user = session;
  next();
});

// Two roles: 'admin' can edit everything; 'user' (the default, incl. new Microsoft sign-ins)
// may only add jobs, update a task's 5-stage progress, start/end times, and cancel/restore it.
function requireWrite(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Read-only account — ask an admin for edit access' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// Cloud Run's filesystem is in-memory and read-only outside /tmp, so uploads —
// which are parsed and deleted within the request — go to the OS temp dir.
const uploadsDir = process.env.UPLOAD_DIR || path.join(os.tmpdir(), 'shutdown-uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^\w.-]/g, '_'))
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .xlsx/.xls files allowed'), ok);
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
// Liveness only — deliberately does not touch the database, so a brief DB blip
// doesn't make Cloud Run recycle otherwise-healthy instances.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Readiness — verifies the database round-trips.
app.get('/api/ready', ah(async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'up' });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'down', error: err.message });
  }
}));

// ─── Auth routes ──────────────────────────────────────────────────────────────
// Username/password sign-in is switched off by default: everyone signs in with
// Microsoft. Set ALLOW_LOCAL_LOGIN=true to bring it (and local-user creation) back.
const ALLOW_LOCAL_LOGIN = process.env.ALLOW_LOCAL_LOGIN === 'true';
const requireLocalLogin = (req, res, next) => {
  if (!ALLOW_LOCAL_LOGIN) return res.status(403).json({ error: 'Password sign-in is disabled — use Microsoft sign-in' });
  next();
};

app.post('/api/login', requireLocalLogin, ah(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = await db.verifyLogin(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  const token = crypto.randomBytes(24).toString('hex');
  await db.createSession(token, user.username, user.role, SESSION_TTL_HOURS);
  res.setHeader('Set-Cookie', `sid=${sign(token)}; ${cookieAttrs(SESSION_TTL_HOURS * 3600)}`);
  res.json({ ok: true, username: user.username, role: user.role, last_login: user.last_login });
}));

// ─── Microsoft Entra ID ───────────────────────────────────────────────────────
app.get('/api/auth/config', (req, res) => {
  res.json({ ...entra.publicConfig, localLogin: ALLOW_LOCAL_LOGIN });
});

// Issues the state + nonce for one sign-in attempt and remembers them in a signed
// cookie. The browser passes both to MSAL, so they come back inside the redirect.
app.post('/api/auth/start', (req, res) => {
  const tx = entra.startTransaction();
  res.setHeader('Set-Cookie', `${entra.TX_COOKIE}=${tx.cookieValue}; ${cookieAttrs(tx.maxAge, '/api/auth')}`);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ state: tx.state, nonce: tx.nonce });
});

app.post('/api/auth/entra', ah(async (req, res) => {
  const txCookie = parseCookies(req)[entra.TX_COOKIE];
  const clearTx = `${entra.TX_COOKIE}=; ${cookieAttrs(0, '/api/auth')}`;
  let identity;
  try {
    identity = await entra.verifyCallback(req.body || {}, txCookie);
  } catch (err) {
    if (!(err instanceof entra.AuthError)) throw err;
    console.warn('[entra] rejected sign-in:', err.message);
    res.setHeader('Set-Cookie', clearTx);
    return res.status(401).json({ error: err.message });
  }

  let user;
  try {
    user = await db.findOrCreateEntraUser(identity);
  } catch (err) {
    res.setHeader('Set-Cookie', clearTx);
    return res.status(409).json({ error: err.message });
  }

  const token = crypto.randomBytes(24).toString('hex');
  await db.createSession(token, user.username, user.role, SESSION_TTL_HOURS);
  // One response, two cookies: start the session and burn the single-use transaction.
  res.setHeader('Set-Cookie', [
    `sid=${sign(token)}; ${cookieAttrs(SESSION_TTL_HOURS * 3600)}`,
    clearTx,
  ]);
  res.json({ ok: true, username: user.username, role: user.role, last_login: user.last_login });
}));

app.post('/api/logout', ah(async (req, res) => {
  const token = sessionToken(req);
  if (token) await db.deleteSession(token);
  res.setHeader('Set-Cookie', `sid=; ${cookieAttrs(0)}`);
  res.json({ ok: true });
}));

app.get('/api/me', requireAuth, ah(async (req, res) => {
  res.json({ ...req.user, last_login: await db.getLastLogin(req.user.username) });
}));

app.get('/api/users', requireAuth, requireAdmin, ah(async (req, res) => {
  res.json(await db.listUsers());
}));

app.post('/api/users', requireAuth, requireAdmin, requireLocalLogin, ah(async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const user = await db.createUser({ username, password, role: db.USER_ROLES.includes(role) ? role : 'user' });
    await db.logActivity('SYSTEM', `เพิ่มผู้ใช้งานใหม่: ${username} (${user.role})`, req.user.username);
    res.json({ ok: true, username: user.username, role: user.role });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.put('/api/users/:username/role', requireAuth, requireAdmin, ah(async (req, res) => {
  const { role } = req.body;
  if (!db.USER_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    await db.setUserRole(req.params.username, role);
    await db.logActivity('SYSTEM', `เปลี่ยนสิทธิ์ผู้ใช้งาน: ${req.params.username} → ${role}`, req.user.username);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.delete('/api/users/:username', requireAuth, requireAdmin, ah(async (req, res) => {
  if (req.params.username === req.user.username) return res.status(400).json({ error: 'Cannot delete your own account' });
  try {
    await db.deleteUser(req.params.username);
    await db.logActivity('SYSTEM', `ลบผู้ใช้งาน: ${req.params.username}`, req.user.username);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ─── Tasks ────────────────────────────────────────────────────────────────────
function getPlant(req) {
  const p = req.query.plant || req.body?.plant;
  return db.PLANTS.includes(p) ? p : db.DEFAULT_PLANT;
}

app.get('/api/tasks', requireAuth, ah(async (req, res) => {
  res.json(await db.getTasks(getPlant(req)));
}));

app.post('/api/tasks', requireAuth, ah(async (req, res) => {
  const { tag, title, area, assignee, progress, note, start_time, end_time, updated_by } = req.body;
  const plant = getPlant(req);
  if (!tag || !title || !area || !assignee) return res.status(400).json({ error: 'Missing required fields' });
  const task = await db.createTask({ tag, title, area, assignee, progress, note, start_time, end_time, updated_by, plant });
  await db.logActivity(task.tag, `สร้างรายการงานใหม่: "${title}"`, updated_by || 'User', plant);
  res.json({ id: task.id, tag: task.tag });
}));

app.put('/api/tasks/:id/progress', requireAuth, ah(async (req, res) => {
  const { progress, updated_by } = req.body;
  const plant = getPlant(req);
  const labels = { 0:'ยังไม่เปิด Permit', 25:'เปิด Permit แล้ว', 50:'อยู่ระหว่างทำงาน', 75:'รอปิด Permit', 100:'ปิด Permit สมบูรณ์' };
  if (!(progress in labels)) return res.status(400).json({ error: 'Invalid progress' });
  const task = await db.updateTaskProgress(req.params.id, progress, updated_by, plant);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  await db.logActivity(task.tag, `อัปเดตเป็น ${progress}% (${labels[progress] || progress+'%'})`, updated_by || 'User', plant);
  res.json({ ok: true });
}));

app.put('/api/tasks/:id/status', requireAuth, ah(async (req, res) => {
  const { status, updated_by } = req.body;
  const plant = getPlant(req);
  if (!['active', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  if (status === 'cancelled' && !reason) return res.status(400).json({ error: 'กรุณาระบุสาเหตุของการยกเลิกงาน' });
  const task = await db.updateTaskStatus(req.params.id, status, updated_by, plant, reason);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  await db.logActivity(task.tag,
    status === 'cancelled' ? `ยกเลิกงาน (Cancel Job): "${reason.slice(0, 60)}"` : 'เปิดงานกลับมาใช้งาน',
    updated_by || 'User', plant);
  res.json({ ok: true });
}));

app.put('/api/tasks/:id/note', requireAuth, requireWrite, ah(async (req, res) => {
  const { note, updated_by } = req.body;
  const plant = getPlant(req);
  const task = await db.updateTaskNote(req.params.id, note, updated_by, plant);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  await db.logActivity(task.tag, `บันทึกโน้ตใหม่: "${String(note).slice(0,40)}"`, updated_by || 'User', plant);
  res.json({ ok: true });
}));

// Event note from the Gantt "Note" button; open to every role, like cancel. Empty clears it.
app.put('/api/tasks/:id/event-note', requireAuth, ah(async (req, res) => {
  const note = String(req.body.note ?? '').trim().slice(0, 500);
  const { updated_by } = req.body;
  const plant = getPlant(req);
  const task = await db.updateTaskEventNote(req.params.id, note, updated_by, plant);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  await db.logActivity(task.tag, note ? `บันทึก Note: "${note.slice(0, 60)}"` : 'ลบ Note', updated_by || 'User', plant);
  res.json({ ok: true, task });
}));

// HH:MM (24h, "24:00" allowed as end-of-day) or empty to clear.
const isValidHM = v => v === '' || /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(v);
// YYYY-MM-DD or empty (= day inferred from the shutdown grid).
const isValidYMD = v => v === '' || (/^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)));

app.put('/api/tasks/:id/times', requireAuth, ah(async (req, res) => {
  const start_time = String(req.body.start_time ?? '').trim();
  const end_time   = String(req.body.end_time ?? '').trim();
  const duration   = String(req.body.duration ?? '').trim().slice(0, 40);
  // Dates are optional so older clients that only send times leave them untouched.
  const start_date = req.body.start_date === undefined ? undefined : String(req.body.start_date).trim();
  const end_date   = req.body.end_date === undefined ? undefined : String(req.body.end_date).trim();
  const { updated_by } = req.body;
  if (!isValidHM(start_time) || !isValidHM(end_time)) {
    return res.status(400).json({ error: 'Time must be HH:MM (00:00–24:00)' });
  }
  if ((start_date !== undefined && !isValidYMD(start_date)) || (end_date !== undefined && !isValidYMD(end_date))) {
    return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
  }
  const plant = getPlant(req);
  const task = await db.updateTaskTimes(req.params.id, { start_time, end_time, duration, start_date, end_date }, updated_by, plant);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const fmt = (d, t) => [d, t].filter(Boolean).join(' ') || '—';
  await db.logActivity(task.tag, `แก้ไขเวลา ${fmt(task.start_date, start_time)} / ${fmt(task.end_date, end_time)}`, updated_by || 'User', plant);
  res.json({ ok: true, task });
}));

app.delete('/api/tasks/:id', requireAuth, requireWrite, ah(async (req, res) => {
  const plant = getPlant(req);
  const task = await db.deleteTask(req.params.id, plant);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  await db.logActivity(task.tag, `ลบรายการงาน: "${task.title}"`, req.user?.username || 'User', plant);
  res.json({ ok: true });
}));

app.delete('/api/tasks', requireAuth, requireWrite, ah(async (req, res) => {
  const plant = getPlant(req);
  const count = await db.clearAllTasks(plant);
  const safetyCount = await db.clearAllSafetyActivities(plant);
  await db.logActivity('SYSTEM', `ล้างข้อมูลตารางงานทั้งหมด (${count} รายการ) และ Safety Activities (${safetyCount} รายการ)`, req.user?.username || 'User', plant);
  res.json({ ok: true, cleared: count, safetyCleared: safetyCount });
}));

app.get('/api/upload/last', requireAuth, ah(async (req, res) => {
  res.json(await db.getLastExcelUpload(getPlant(req)));
}));

// Shutdown window edited (e.g. postponed): stores the new start/end ("YYYY-MM-DDTHH:MM",
// local time) and moves every task by deltaMinutes — how far the start moved — along
// with the date frame (baseDate + the minute of day the schedule grid opens).
const isLocalDateTime = v => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

app.put('/api/shutdown/range', requireAuth, requireWrite, ah(async (req, res) => {
  const deltaMin = Number(req.body.deltaMinutes);
  const baseDate = String(req.body.baseDate || '');
  const gridStartMin = Number(req.body.gridStartMin);
  const rangeStart = String(req.body.rangeStart || '');
  const rangeEnd = String(req.body.rangeEnd || '');
  if (!Number.isInteger(deltaMin) || Math.abs(deltaMin) > 366 * 1440
      || !/^\d{4}-\d{2}-\d{2}$/.test(baseDate) || Number.isNaN(Date.parse(baseDate))
      || !Number.isInteger(gridStartMin) || gridStartMin < 0 || gridStartMin >= 1440) {
    return res.status(400).json({ error: 'Invalid shift' });
  }
  if (!isLocalDateTime(rangeStart) || !isLocalDateTime(rangeEnd) || rangeEnd <= rangeStart) {
    return res.status(400).json({ error: 'End must be after start' });
  }
  const plant = getPlant(req);
  const result = await db.shiftShutdown(plant, deltaMin,
    { baseDate, gridStartMin, gridStartHour: Math.floor(gridStartMin / 60), rangeStart, rangeEnd });
  const fmt = v => `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)} ${v.slice(11)}`;
  let action = `แก้ไขช่วงเวลา Shutdown ${fmt(rangeStart)} – ${fmt(rangeEnd)}`;
  if (deltaMin) {
    const abs = Math.abs(deltaMin), d = Math.floor(abs / 1440), h = Math.floor(abs % 1440 / 60), m = abs % 60;
    const amount = [d && `${d} วัน`, h && `${h} ชม.`, m && `${m} นาที`].filter(Boolean).join(' ');
    action += ` · ${deltaMin < 0 ? 'เลื่อนเร็วขึ้น' : 'เลื่อนออกไป'} ${amount} (${result.shifted} งานปรับเวลา)`;
  }
  await db.logActivity('SYSTEM', action, req.user?.username || 'User', plant);
  res.json(result);
}));

// ─── Shutdown history / Overall Plant ─────────────────────────────────────────
// "Close shutdown": saves the shutdown to history, then empties the plant
// (tasks, safety items, milestones, Excel frame) for the next one. This is the
// only path that writes history — Clear All and Excel upload never do.
app.post('/api/shutdown/close', requireAuth, requireWrite, ah(async (req, res) => {
  const plant = getPlant(req);
  const actor = req.user?.username || 'User';
  const rec = await db.closeShutdown(plant, actor, { reset: true });
  if (!rec) return res.status(400).json({ error: 'ไม่มีข้อมูล Shutdown ให้ปิด (ยังไม่มีรายการงาน หรือยังไม่ได้กำหนดวันที่)' });
  const pct = rec.total ? (rec.done / rec.total * 100).toFixed(1) : '0.0';
  await db.logActivity('SYSTEM', `ปิดงาน Shutdown ${rec.start_date} และบันทึก History (${rec.done}/${rec.total} งาน, ${pct}%)`, actor, plant);
  res.json(rec);
}));

app.get('/api/history', requireAuth, ah(async (req, res) => {
  const plant = db.PLANTS.includes(req.query.plant) ? req.query.plant : undefined;
  const y = Number(req.query.year);
  const year = Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : undefined;
  res.json(await db.listHistory({ plant, year }));
}));

app.get('/api/history/:id', requireAuth, ah(async (req, res) => {
  const id = Number(req.params.id);
  const rec = Number.isSafeInteger(id) && id > 0 ? await db.getHistory(id) : null;
  if (!rec) return res.status(404).json({ error: 'History not found' });
  res.json(rec);
}));

app.delete('/api/history/:id', requireAuth, requireWrite, ah(async (req, res) => {
  const id = Number(req.params.id);
  const rec = Number.isSafeInteger(id) && id > 0 ? await db.deleteHistory(id) : null;
  if (!rec) return res.status(404).json({ error: 'History not found' });
  await db.logActivity('SYSTEM', `ลบ History Shutdown ${rec.start_date}`, req.user?.username || 'User', rec.plant);
  res.json({ ok: true });
}));

app.get('/api/overall', requireAuth, ah(async (req, res) => {
  const y = Number(req.query.year);
  const year = Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : new Date().getFullYear();
  let recorded = [];
  try { recorded = await db.listHistory({ year }); }
  catch (err) { console.error('[history read]', err.message); }
  const plants = await Promise.all(db.PLANTS.map(async plant => {
    const snap = await db.getShutdownSnapshot(plant);
    const live = snap?.total && { plant, start_date: snap.start_date, end_date: snap.end_date,
      total: snap.total, done: snap.done, touched: snap.touched };
    const entries = recorded
      .filter(r => r.plant === plant && r.start_date !== live?.start_date)
      .map(r => ({ ...r, live: false }));
    if (live && live.start_date.startsWith(`${year}-`)) entries.push({ ...live, live: true });
    entries.sort((a, b) => a.start_date.localeCompare(b.start_date));
    return { plant, entries };
  }));
  res.json({ year, plants });
}));

// ─── Activity ─────────────────────────────────────────────────────────────────
app.get('/api/activity', requireAuth, ah(async (req, res) => {
  res.json(await db.getActivity(30, getPlant(req)));
}));

// ─── Shutdown schedule (milestone times) ──────────────────────────────────────
app.get('/api/schedule', requireAuth, ah(async (req, res) => {
  res.json(await db.getSchedule(getPlant(req)));
}));

app.put('/api/schedule', requireAuth, requireWrite, ah(async (req, res) => {
  const plant = getPlant(req);
  const schedule = await db.saveSchedule(req.body.schedule, plant);
  await db.logActivity('SYSTEM', 'บันทึกแผนงาน Shutdown (Milestone Schedule)', req.user?.username || 'User', plant);
  res.json(schedule);
}));

// ─── Shutdown Safety Activities ───────────────────────────────────────────────
app.get('/api/safety', requireAuth, ah(async (req, res) => {
  res.json(await db.getSafetyActivities(getPlant(req)));
}));

app.post('/api/safety/:category', requireAuth, requireWrite, ah(async (req, res) => {
  if (!db.SAFETY_CATEGORIES.includes(req.params.category)) return res.status(400).json({ error: 'Invalid category' });
  const plant = getPlant(req);
  const item = await db.createSafetyActivity(req.params.category, req.body, plant);
  await db.logActivity('SAFETY', `เพิ่มรายการ Safety Activity: ${item.text}`, req.user?.username || 'User', plant);
  res.json(item);
}));

app.put('/api/safety/:category/:id', requireAuth, requireWrite, ah(async (req, res) => {
  if (!db.SAFETY_CATEGORIES.includes(req.params.category)) return res.status(400).json({ error: 'Invalid category' });
  const plant = getPlant(req);
  const item = await db.updateSafetyActivity(req.params.category, req.params.id, req.body, plant);
  if (!item) return res.status(404).json({ error: 'Not found' });
  await db.logActivity('SAFETY', `แก้ไขรายการ Safety Activity: ${item.text}`, req.user?.username || 'User', plant);
  res.json(item);
}));

app.delete('/api/safety/:category/:id', requireAuth, requireWrite, ah(async (req, res) => {
  if (!db.SAFETY_CATEGORIES.includes(req.params.category)) return res.status(400).json({ error: 'Invalid category' });
  const plant = getPlant(req);
  const item = await db.deleteSafetyActivity(req.params.category, req.params.id, plant);
  if (!item) return res.status(404).json({ error: 'Not found' });
  await db.logActivity('SAFETY', `ลบรายการ Safety Activity: ${item.text}`, req.user?.username || 'User', plant);
  res.json({ ok: true });
}));

// ─── POST upload Excel ────────────────────────────────────────────────────────
function excelTimeToHHMM(val) {
  if (typeof val === 'number' && isFinite(val)) {
    const totalMinutes = Math.round(val * 24 * 60);
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }
  return String(val || '').trim();
}

// A plan Start/End cell is either a bare time of day (0.375 = 09:00) or, in multi-day
// schedules, a full date-time serial (46287.375 = 22 Sep 09:00). Returns the HH:MM and,
// for the latter, the calendar date too — otherwise date is '' and the day is inferred
// from the hourly grid.
function excelDateTime(val) {
  if (typeof val === 'number' && isFinite(val) && val > 40000 && val < 60000) {
    let day = Math.floor(val);
    let mins = Math.round((val - day) * 1440);
    if (mins >= 1440) { day += 1; mins -= 1440; }
    return {
      date: XLSX.SSF.format('yyyy-mm-dd', day),
      time: `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`,
    };
  }
  if (val === '' || val === undefined) return { date: '', time: '' };
  return { date: '', time: excelTimeToHHMM(val) };
}

// ── Which day does a task fall on? ──
// Tasks only carry a time-of-day. The template's hourly bar grid spans ~2 days:
// one header row has the date serial at the first column of each day, the row
// below it has each column's hour, and a task's bar is painted wherever the
// column hour lies between its start and end. The grid opens at its first hour
// on day 1 (04:00 on 26 Aug in BM #17), so a start before that hour is a day-2
// time. The client places tasks with that rule, given the grid's first date and hour.
function findGanttGridStart(rawRows, lastCol) {
  for (let ri = 0; ri < Math.min(rawRows.length, 8); ri++) {
    const row = rawRows[ri];
    for (let ci = 0; ci <= lastCol && ci < row.length; ci++) {
      if (typeof row[ci] !== 'number' || row[ci] <= 40000 || row[ci] >= 60000) continue;
      const hour = (rawRows[ri + 1] || [])[ci];
      // Single-day files hold a bare hour (0.1667); multi-day ones a full date-time (46286.1667).
      const frac = typeof hour === 'number' ? hour - (hour > 40000 ? Math.floor(hour) : 0) : -1;
      return {
        baseDate: XLSX.SSF.format('yyyy-mm-dd', Math.floor(row[ci])),
        gridStartHour: frac >= 0 && frac < 1 ? Math.round(frac * 24) % 24 : 0,
      };
    }
  }
  return null;
}

app.post('/api/upload', requireAuth, requireWrite, upload.single('file'), ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    // Read as raw arrays to handle merged-cell schedules
    const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });

    if (!rawRows.length) return res.status(400).json({ error: 'Excel sheet is empty' });

    const toInsert = [];
    const plant = getPlant(req);
    let ganttGrid = null;

    // ── Strategy 1: Shutdown Schedule format (merged-cell, positional columns)
    // Detect: rows where col[2] is a positive integer (item number) and col[3] has text (task name)
    const scheduleRows = rawRows.filter(r =>
      typeof r[2] === 'number' && Number.isInteger(r[2]) && r[2] > 0 && String(r[3]).trim().length > 3
    );

    if (scheduleRows.length > 0) {
      // Locate the assignee column by header text instead of a fixed index — the
      // number of hourly Gantt columns (and therefore every column after it) shifts
      // depending on the shutdown's date/hour range, which broke assignee lookup on
      // files with a different grid width than the one the fixed offsets were tuned to.
      // The other fields (duration, start/end time) sit at fixed offsets *relative to*
      // the assignee column in this template, so we re-anchor them off it dynamically.
      const ASSIGNEE_HINTS = ['ผู้ปฏิบัติงาน', 'ผู้รับผิดชอบ', 'assignee', 'responsible'];
      let assigneeCol = -1;
      for (let ri = 0; ri < Math.min(rawRows.length, 30) && assigneeCol === -1; ri++) {
        const row = rawRows[ri];
        for (let ci = 0; ci < row.length; ci++) {
          const cell = String(row[ci] || '').trim().toLowerCase();
          if (cell && ASSIGNEE_HINTS.some(h => cell.includes(h))) { assigneeCol = ci; break; }
        }
      }
      // Fallback to the original hardcoded offset if the header couldn't be found
      const assigneeIdx = assigneeCol >= 0 ? assigneeCol : 82;
      const startIdx    = assigneeIdx - 6;
      const endIdx      = assigneeIdx - 5;
      const durationIdx = assigneeIdx - 2;

      // Find the base shutdown date (a date-serial cell near the top of the sheet,
      // used to build full datetimes for the "ตัดไฟ" rows below since they only carry a time-of-day).
      let baseDateSerial = null;
      for (let ri = 0; ri < Math.min(rawRows.length, 5) && baseDateSerial === null; ri++) {
        for (const cell of rawRows[ri]) {
          if (typeof cell === 'number' && cell > 40000 && cell < 60000) { baseDateSerial = cell; break; }
        }
      }
      const baseDateStr = baseDateSerial !== null ? XLSX.SSF.format('yyyy-mm-dd', baseDateSerial) : '';
      ganttGrid = findGanttGridStart(rawRows, startIdx - 1);

      // Carry forward area (col 0) and section (col 1) from the last non-empty row
      let lastArea = '', lastSection = '';
      const powerOutageRows = [];
      // The power-outage section is named differently per plant ("ตัดไฟ" in BM #17,
      // "ตัดระบบไฟฟ้า" in BM #1) but never "ตัดลม" (air). Its rows have no item
      // number and a blank section cell, so it ends at the first blank row or the
      // next area/section — otherwise the summary rows below it would be swept in.
      const POWER_SECTION = /^ตัด.*ไฟ/;
      let inPower = false;
      for (const raw of rawRows) {
        const area    = String(raw[0] || '').trim();
        const section = String(raw[1] || '').trim();
        if (area)    lastArea    = area;
        if (section) lastSection = section;

        // Power-outage rows are captured separately so they can seed the
        // "แผนการดับไฟ" safety-activity card.
        const title = String(raw[3] || '').trim();
        if (section) inPower = POWER_SECTION.test(section);
        else if (area || !title) inPower = false;
        if (inPower && title && title !== '-') {
          const start = excelDateTime(raw[startIdx]);
          const end   = excelDateTime(raw[endIdx]);
          const assignee = String(raw[assigneeIdx] || '').trim();
          powerOutageRows.push({ title, assignee, start_time: start.time, end_time: end.time, start_date: start.date });
        }

        const itemNo = raw[2];
        if (!Number.isInteger(itemNo) || itemNo <= 0 || !title) continue;

        const assignee   = String(raw[assigneeIdx] || '').trim() || 'ไม่ระบุ';
        const start = excelDateTime(raw[startIdx]);
        const end   = excelDateTime(raw[endIdx]);
        const duration  = raw[durationIdx] ? `${raw[durationIdx]} ชม.` : '';
        // Section shows just the work center (e.g. 751EE11), not the sheet's item number.
        const tag        = (lastSection||lastArea||'SD').replace(/\s+/g,'-').toUpperCase().slice(0,10);

        toInsert.push({
          tag, title,
          area:     lastArea || lastSection || 'General',
          assignee, progress: 0, note: '', duration,
          start_time: start.time, end_time: end.time, start_date: start.date, end_date: end.date,
          updated_at: '', updated_by: 'Excel Import'
        });
      }

      if (powerOutageRows.length > 0) {
        for (const row of powerOutageRows) {
          const day = row.start_date || baseDateStr;
          const datetime = (day && row.start_time) ? `${day}T${row.start_time}` : '';
          const timeRange = row.start_time && row.end_time ? ` (${row.start_time}-${row.end_time})` : '';
          await db.createSafetyActivity('power_outage', {
            text: `${row.title}${timeRange}`,
            responsible: row.assignee,
            datetime,
            status: 'pending'
          }, plant);
        }
        await db.logActivity('SAFETY', `นำเข้าแผนการดับไฟจาก Excel ${powerOutageRows.length} รายการ`, 'System', plant);
      }
    } else {
      // ── Strategy 2: Generic tabular format — find header row, map columns
      const COL_HINTS = {
        tag:      ['tag', 'section', 'machine tag', 'tag no', 'item no', 'เครื่องจักร'],
        title:    ['title', 'task', 'description', 'งาน', 'ชื่องาน', 'รายการงาน', 'activity'],
        area:     ['area', 'zone', 'location', 'department', 'โซน', 'พื้นที่', 'แผนก'],
        assignee: ['assignee', 'responsible', 'technician', 'engineer', 'ผู้รับผิดชอบ', 'ช่าง'],
        progress: ['progress', 'status', 'สถานะ', '%', 'completion'],
        note:     ['note', 'remark', 'comment', 'หมายเหตุ', 'บันทึก']
      };

      let headerRowIdx = -1;
      let colMap = {};
      for (let i = 0; i < Math.min(rawRows.length, 15); i++) {
        const row = rawRows[i].map(v => String(v).toLowerCase().trim());
        const matched = Object.values(COL_HINTS).flat().filter(h => row.some(c => c.includes(h)));
        if (matched.length >= 2) { headerRowIdx = i; break; }
      }

      if (headerRowIdx >= 0) {
        const headers = rawRows[headerRowIdx];
        for (const [field, hints] of Object.entries(COL_HINTS)) {
          const idx = headers.findIndex(h => hints.some(hint => String(h).toLowerCase().includes(hint)));
          if (idx >= 0) colMap[field] = idx;
        }
        for (let i = headerRowIdx + 1; i < rawRows.length; i++) {
          const r = rawRows[i];
          const title = colMap.title !== undefined ? String(r[colMap.title]||'').trim() : '';
          if (!title) continue;
          toInsert.push({
            tag:       colMap.tag !== undefined ? String(r[colMap.tag]||'').toUpperCase().trim() : `EQ-${i}`,
            title,
            area:      colMap.area !== undefined ? String(r[colMap.area]||'General').trim() : 'General',
            assignee:  colMap.assignee !== undefined ? String(r[colMap.assignee]||'ไม่ระบุ').trim() : 'ไม่ระบุ',
            progress:  0,
            note:      colMap.note !== undefined ? String(r[colMap.note]||'').trim() : '',
            updated_at: '', updated_by: 'Excel Import'
          });
        }
      }
    }

    const count = await db.bulkInsertTasks(toInsert, plant);
    await db.logActivity('EXCEL', `นำเข้าข้อมูลจาก Excel สำเร็จ ${count} รายการ (${req.file.originalname})`, 'System', plant);

    const uploadInfo = { fileName: req.file.originalname, uploadedAt: new Date().toISOString(), ...ganttGrid };
    await db.setLastExcelUpload(plant, uploadInfo);

    fs.unlink(req.file.path, () => {});
    res.json({ ok: true, imported: count, total: rawRows.length, lastUpload: uploadInfo });

  } catch (err) {
    console.error('Excel parse error:', err.message);
    fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Failed to parse Excel: ' + err.message });
  }
}));

// ─── Error handler ────────────────────────────────────────────────────────────
// Last in the chain: turns anything thrown by an async route into JSON rather
// than an HTML stack trace.
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.path, '-', err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ─── Startup ──────────────────────────────────────────────────────────────────
let server;

async function start() {
  await db.init();

  // Expired rows would otherwise accumulate forever; sessions are cheap to sweep.
  const purgeTimer = setInterval(() => {
    db.purgeExpiredSessions().catch(e => console.error('[session purge]', e.message));
  }, 60 * 60 * 1000);
  purgeTimer.unref();

  server = app.listen(PORT, HOST, () => {
    console.log(`\n  ╔══════════════════════════════════════════╗`);
    console.log(`  ║  PLANT OPS // SHUTDOWN MANAGEMENT        ║`);
    console.log(`  ║  http://localhost:${String(PORT).padEnd(23)}║`);
    console.log(`  ║  db: ${String(process.env.DB_NAME || '?').padEnd(36)}║`);
    console.log(`  ╚══════════════════════════════════════════╝\n`);
  });
}

// Cloud Run sends SIGTERM before reclaiming an instance; drain in-flight
// requests and close the pool so Postgres doesn't accumulate dead connections.
function shutdown(signal) {
  console.log(`\n[${signal}] shutting down…`);
  const done = () => pool.end().then(() => process.exit(0)).catch(() => process.exit(1));
  if (server) server.close(done); else done();
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

start().catch(err => {
  console.error('\n  STARTUP FAILED:', err.message, '\n');
  process.exit(1);
});
