// Signing for cookies, keyed by SESSION_SECRET.
//
// The secret must be stable across restarts and identical on every Cloud Run
// instance — otherwise a cookie signed by one instance is rejected by the next.
// Production refuses to start without it; development falls back to a random
// per-process key (and says so) so a fresh checkout still runs.
const crypto = require('crypto');

const MIN_SECRET_LENGTH = 32;

function loadSecret() {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= MIN_SECRET_LENGTH) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`SESSION_SECRET must be set to a stable random string of at least ${MIN_SECRET_LENGTH} characters`);
  }
  console.warn(`[security] SESSION_SECRET missing or shorter than ${MIN_SECRET_LENGTH} chars — using a random key; logins will not survive a restart`);
  return crypto.randomBytes(32).toString('hex');
}

const SECRET = loadSecret();

function mac(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

// "<value>.<mac>"
function sign(value) {
  return `${value}.${mac(value)}`;
}

// Returns the original value, or null if the signature is missing or wrong.
function unsign(signed) {
  if (typeof signed !== 'string') return null;
  const idx = signed.lastIndexOf('.');
  if (idx < 1) return null;
  const value = signed.slice(0, idx);
  const given = Buffer.from(signed.slice(idx + 1));
  const expected = Buffer.from(mac(value));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return value;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { sign, unsign, safeEqual };
