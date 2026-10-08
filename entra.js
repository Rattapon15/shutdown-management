// Microsoft Entra ID sign-in, server half.
//
// The browser runs the SPA authorization-code + PKCE flow through MSAL and hands
// us the resulting ID token. We never trust that on its own: the token's
// signature, issuer, audience, tenant, expiry and nonce are all checked here,
// and the nonce/state must match the ones this server issued for this browser.
const crypto = require('crypto');
const { sign, unsign, safeEqual } = require('./security');

const TENANT_ID = process.env.ENTRA_TENANT_ID || '5db8bf0e-8592-4ed0-82b2-a6d4d77933d4';
const CLIENT_ID = process.env.ENTRA_CLIENT_ID || '824220ec-ee74-465f-8b44-0e2c5e931506';
const AUTHORITY = `https://login.microsoftonline.com/${TENANT_ID}`;
const ISSUER = `${AUTHORITY}/v2.0`;
const SCOPES = ['openid', 'profile', 'email'];

const TX_COOKIE = 'auth_tx';
const TX_TTL_SECONDS = 10 * 60;

const publicConfig = { clientId: CLIENT_ID, authority: AUTHORITY, scopes: SCOPES };

// jose is ESM-only; a dynamic import works from CommonJS on every Node we run on.
let joseP;
let jwks;
async function loadJose() {
  if (!joseP) joseP = import('jose');
  const jose = await joseP;
  // The remote key set caches and rotates keys itself.
  jwks ||= jose.createRemoteJWKSet(new URL(`${AUTHORITY}/discovery/v2.0/keys`));
  return jose;
}

// Stateless login transaction: the state/nonce pair lives in a signed cookie, so
// any Cloud Run instance can finish a login another one started.
function startTransaction() {
  const state = crypto.randomBytes(24).toString('base64url');
  const nonce = crypto.randomBytes(24).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + TX_TTL_SECONDS;
  const cookieValue = sign(Buffer.from(JSON.stringify({ state, nonce, exp })).toString('base64url'));
  return { state, nonce, cookieValue, maxAge: TX_TTL_SECONDS };
}

function readTransaction(cookieValue) {
  const payload = unsign(cookieValue);
  if (!payload) return null;
  try {
    const tx = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof tx.state !== 'string' || typeof tx.nonce !== 'string') return null;
    if (typeof tx.exp !== 'number' || tx.exp < Date.now() / 1000) return null;
    return tx;
  } catch {
    return null;
  }
}

class AuthError extends Error {}

// Throws AuthError on any mismatch; returns the identity to sign in on success.
async function verifyCallback({ idToken, state }, txCookie) {
  if (typeof idToken !== 'string' || typeof state !== 'string') throw new AuthError('Missing idToken or state');

  const tx = readTransaction(txCookie);
  if (!tx) throw new AuthError('Sign-in session expired — please try again');
  if (!safeEqual(tx.state, state)) throw new AuthError('State mismatch');

  const { jwtVerify } = await loadJose();
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, jwks, {
      issuer: ISSUER,
      audience: CLIENT_ID,
      algorithms: ['RS256'],
      clockTolerance: 60,
    }));
  } catch (err) {
    throw new AuthError(`Invalid ID token: ${err.code || err.message}`);
  }

  if (typeof payload.nonce !== 'string' || !safeEqual(payload.nonce, tx.nonce)) throw new AuthError('Nonce mismatch');
  if (payload.tid !== TENANT_ID) throw new AuthError('Token is from a different tenant');
  if (typeof payload.oid !== 'string' || !payload.oid) throw new AuthError('Token has no object id');

  const email = String(payload.email || payload.preferred_username || '').toLowerCase();
  const username = String(payload.preferred_username || payload.email || payload.oid).toLowerCase();
  return { oid: payload.oid, username, email: email || null, name: payload.name ? String(payload.name) : null };
}

module.exports = { publicConfig, TX_COOKIE, startTransaction, verifyCallback, AuthError };
