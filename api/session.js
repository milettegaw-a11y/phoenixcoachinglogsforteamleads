// Server-side sign-in for the Phoenix Coaching Log.
//
// Until now the browser read a password hash straight out of Firestore and
// compared it itself. With the database open that meant anyone could read every
// hash — and, worse, overwrite one and sign in as the Operations Manager. The
// check has to happen somewhere the user cannot reach.
//
// This function verifies the password against px_users using admin credentials
// the browser never sees, and returns a Firebase custom token carrying a `px`
// claim. Security rules require that claim, so an anonymous sign-in with the
// public API key — which anyone can perform — grants nothing.
//
// It also upgrades password storage. The old scheme was a bare SHA-256 digest:
// unsalted and fast, so a stolen table is trivially reversed by a rainbow table.
// New and re-verified passwords are stored with scrypt and a per-user salt. A
// legacy hash still verifies once, and is replaced on that login.

import crypto from 'crypto';

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const IDTK_AUD  = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function signJwt(payload, privateKey) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const body = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const sig = crypto.createSign('RSA-SHA256').update(body).sign(privateKey);
  return body + '.' + b64url(sig);
}

let _tok = null, _tokExp = 0;
async function accessToken(sa) {
  if (_tok && Date.now() < _tokExp - 60000) return _tok;
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore',
    aud: TOKEN_URI, iat: now, exp: now + 3600
  }, sa.private_key);
  const r = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion
    })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('token exchange failed: ' + (d.error_description || d.error || 'unknown'));
  _tok = d.access_token; _tokExp = Date.now() + (d.expires_in || 3600) * 1000;
  return _tok;
}

const docUrl = (project, path) =>
  `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${path}`;

function unwrap(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if ('stringValue'  in v) out[k] = v.stringValue;
    else if ('integerValue' in v) out[k] = parseInt(v.integerValue, 10);
    else if ('booleanValue' in v) out[k] = v.booleanValue;
    else if ('nullValue' in v) out[k] = null;
  }
  return out;
}
function wrap(obj) {
  const f = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) f[k] = { nullValue: null };
    else if (typeof v === 'number')  f[k] = { integerValue: String(v) };
    else if (typeof v === 'boolean') f[k] = { booleanValue: v };
    else f[k] = { stringValue: String(v) };
  }
  return f;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const scryptHash = (pw, salt) =>
  crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');

// Constant-time compare so a wrong password cannot be found a byte at a time.
function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

const LOCK_AFTER = 8;
const LOCK_MS    = 15 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  // Not configured yet: say so plainly with a distinct code. The browser falls
  // back to the old path on this exact response, so deploying this file early
  // changes nothing until the credential exists.
  if (!raw) return res.status(503).json({ error: 'not_configured' });

  let sa;
  try { sa = JSON.parse(raw); }
  catch { return res.status(500).json({ error: 'FIREBASE_SERVICE_ACCOUNT is not valid JSON' }); }
  const project = sa.project_id;

  const { email, password, mode } = req.body || {};
  const em = String(email || '').trim().toLowerCase();
  if (!em || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return res.status(400).json({ error: 'bad_email' });

  try {
    const tok = await accessToken(sa);
    const h = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
    const url = docUrl(project, 'px_users/' + encodeURIComponent(em));

    const r = await fetch(url, { headers: h });
    const doc = r.ok ? await r.json() : null;
    const u = doc ? unwrap(doc.fields) : {};
    const hasPassword = !!(u.hash || u.scrypt);

    // Step 1 of the login form: does this address already have a password?
    if (mode === 'check') return res.status(200).json({ exists: hasPassword });

    if (!password || String(password).length < 6)
      return res.status(400).json({ error: 'weak_password' });

    // Lockout. Counted server-side, so it cannot be cleared from a console.
    const failed = u.failedCount || 0;
    const lockedUntil = u.lockedUntil || 0;
    if (lockedUntil && Date.now() < lockedUntil)
      return res.status(429).json({ error: 'locked', retryInMs: lockedUntil - Date.now() });

    const save = async (fields) => {
      const names = Object.keys(fields).map(k => 'updateMask.fieldPaths=' + k).join('&');
      await fetch(url + '?' + names, { method: 'PATCH', headers: h, body: JSON.stringify({ fields: wrap(fields) }) });
    };

    const mint = (claims) => {
      const now = Math.floor(Date.now() / 1000);
      return signJwt({
        iss: sa.client_email, sub: sa.client_email, aud: IDTK_AUD,
        iat: now, exp: now + 3600, uid: em, claims
      }, sa.private_key);
    };

    if (mode === 'create') {
      // Only ever for an address with no password. Without this check anyone
      // could reset a colleague's credentials by asking nicely.
      if (hasPassword) return res.status(409).json({ error: 'already_set' });
      const salt = crypto.randomBytes(16).toString('hex');
      await save({ scrypt: scryptHash(password, salt), salt, hash: null,
                   createdAt: new Date().toISOString(), failedCount: 0, lockedUntil: 0 });
      return res.status(200).json({ token: mint({ px: true, email: em }), email: em });
    }

    if (mode === 'login') {
      if (!hasPassword) return res.status(404).json({ error: 'no_password' });

      let ok = false, upgrade = false;
      if (u.scrypt && u.salt) {
        ok = sameSecret(u.scrypt, scryptHash(password, u.salt));
      } else if (u.hash) {
        ok = sameSecret(u.hash, sha256(password));   // legacy, one last time
        upgrade = ok;
      }

      if (!ok) {
        const n = failed + 1;
        await save({ failedCount: n, lockedUntil: n >= LOCK_AFTER ? Date.now() + LOCK_MS : 0 });
        return res.status(401).json({ error: 'bad_password', attemptsLeft: Math.max(0, LOCK_AFTER - n) });
      }

      if (upgrade) {
        const salt = crypto.randomBytes(16).toString('hex');
        await save({ scrypt: scryptHash(password, salt), salt, hash: null, failedCount: 0, lockedUntil: 0 });
      } else {
        await save({ failedCount: 0, lockedUntil: 0 });
      }
      return res.status(200).json({ token: mint({ px: true, email: em }), email: em });
    }

    return res.status(400).json({ error: 'bad_mode' });
  } catch (e) {
    console.error('[session]', e.message);
    return res.status(500).json({ error: 'server_error' });
  }
}
