// Reads the two simulator result sheets and writes a normalised snapshot to
// Firestore, so the Agent's Opportunity tab updates itself instead of waiting
// for someone to re-export and redeploy.
//
// One scheduled reader, many browsers: the app subscribes to a single Firestore
// document. Thirty agents opening the tab cost Google nothing, which is the
// lesson from the HubSpot incident applied before it can repeat.
//
// Needs FIREBASE_SERVICE_ACCOUNT (the same credential /api/session uses) and
// both spreadsheets shared read-only with that service account's email.

import crypto from 'crypto';

const SIM_SHEET  = process.env.SIM_SHEET_ID  || '16TM-ho19_z5u7HLRU8T_LRblbwOXHJkhsvmUFcA1iV8';
const LIVE_SHEET = process.env.LIVE_SHEET_ID || '1eQWeddD2MrFK0IIoFMtVap5_WcNP-5EVqFWcBUSO9-g';

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/datastore';

// The eight skills, and the points each is worth. Both sheets score the same
// rubric and it totals exactly 100, which is what makes sim and live directly
// comparable as percentages.
const RUBRIC = [10, 10, 15, 10, 14, 10, 14, 17];
const SHORT  = ['Rapport','Early Objections','Discovery','Pain Points','FCF & Membership','Features as Benefits','Objection Handling','Closing'];
const SIM_COLS = ['Rapport & Conversation Control','Early Objection Handling','Discovery','Pain Point Identification',
                  'FCF & Membership Recommendation & Explanation','Features as Benefits','Objection Handling','Closing & Commitment'];
// The live sheet prefixes every skill with "Score - " and calls FCF "Voucher".
const LIVE_COLS = SIM_COLS.map(c => 'Score - ' + c.replace('FCF & Membership', 'Voucher & Membership'));
const LEVELS = ['Basic', 'Intermediate', 'Advanced'];

// Spellings of one person that the free-text form has produced. A name absent
// from this map and absent from the roster is dropped, which is why the form
// really wants a dropdown.
const MERGE = {
  'Chester Allan Banluta': 'Chester Banluta',
  'Cj Garces': 'CJ Garces',
  'Ericka Jane Condecion': 'Ericka Condecion',
  'Jersey De Guzman': 'Jersey Deguzman',
  'Jessafrayna': 'Jessa Frayna',
  'Jessa Macalinga Frayna': 'Jessa Frayna',
  'Mariefe Claire Villanueva': 'Mariefe Villanueva',
  'Roxanne "Anna" Hila': 'Roxanne Hila',
  'Neal Mirasol': 'Neal Jason Mirasol',
  'Jhayren Villanueva': 'Jhayren Rose Villanueva'
};

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function signJwt(payload, key) {
  const body = b64url(JSON.stringify({ alg:'RS256', typ:'JWT' })) + '.' + b64url(JSON.stringify(payload));
  return body + '.' + b64url(crypto.createSign('RSA-SHA256').update(body).sign(key));
}
async function accessToken(sa) {
  const now = Math.floor(Date.now()/1000);
  const assertion = signJwt({ iss: sa.client_email, scope: SCOPES, aud: TOKEN_URI, iat: now, exp: now+3600 }, sa.private_key);
  const r = await fetch(TOKEN_URI, {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body: new URLSearchParams({ grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('token exchange failed: ' + (d.error_description || d.error || '?'));
  return d.access_token;
}

// Sheets returns ragged rows — trailing empty cells are simply absent — so every
// row is padded before being zipped against the header.
async function readSheet(id, tok) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/A1:BZ200000`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + tok } });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`sheet ${id} unreadable (${r.status}). Share it with the service account. ${t.slice(0,200)}`);
  }
  const d = await r.json();
  const rows = d.values || [];
  if (!rows.length) return [];
  const head = rows[0].map(h => String(h || '').trim());
  return rows.slice(1).map(row => {
    const o = {};
    head.forEach((h, i) => { o[h] = row[i] === undefined ? '' : String(row[i]); });
    return o;
  });
}

const titleCase = (s) => s.replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
function agentName(raw) {
  const n = titleCase(String(raw || '').replace(/\s+/g, ' ').trim());
  return MERGE[n] || n;
}
// Phoenix under any spelling the form has seen: PHX, Phnx, Pheonix, pHOENIX.
function isPhoenix(lob) {
  const x = String(lob || '').toLowerCase().replace(/[^a-z]/g, '');
  return x === 'phx' || (x.includes('pho') && (x.includes('nix') || x.includes('nxi')));
}
function isoDate(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
  return '';
}
const num = (v) => { const n = parseFloat(String(v).trim()); return isFinite(n) ? n : null; };
// Each skill as a percentage of the points it is worth. A handful of rows score
// above the maximum — the grader is not perfectly consistent — and are capped
// rather than allowed to read as more than full marks.
function pct(row, cols) {
  return cols.map((c, i) => {
    const v = num(row[c]);
    if (v === null) return -1;
    return Math.min(100, Math.round(100 * v / RUBRIC[i]));
  });
}
const isPass = (v) => String(v || '').trim().toUpperCase() === 'PASS';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return res.status(503).json({ error: 'not_configured', hint: 'FIREBASE_SERVICE_ACCOUNT is not set' });
  let sa;
  try { sa = JSON.parse(raw); }
  catch { return res.status(500).json({ error: 'FIREBASE_SERVICE_ACCOUNT is not valid JSON' }); }

  try {
    const tok = await accessToken(sa);
    const [simRows, liveRows] = await Promise.all([ readSheet(SIM_SHEET, tok), readSheet(LIVE_SHEET, tok) ]);

    // Names are the join key between the two sheets and the app's roster, so
    // they are collected once and everything else indexes into them.
    const names = [];
    const idx = new Map();
    const nameId = (n) => {
      if (!idx.has(n)) { idx.set(n, names.length); names.push(n); }
      return idx.get(n);
    };

    const sim = [];
    let simSkipped = 0;
    for (const r of simRows) {
      const n = agentName(r['Agent Name']);
      const d = isoDate(r['Timestamp']);
      const o = num(r['Overall Score']);
      if (!n || !d || o === null) { simSkipped++; continue; }
      if (!isPhoenix(r['LOB'])) { simSkipped++; continue; }
      const lvl = String(r['Simulator Name'] || '').trim();
      sim.push([ nameId(n), LEVELS.indexOf(lvl), Math.round(o), isPass(r['Result']) ? 1 : 0, d, pct(r, SIM_COLS) ]);
    }

    const live = [];
    let liveSkipped = 0;
    for (const r of liveRows) {
      const n = agentName(r['Agent Name']);
      const d = isoDate(r['Call Date'] || r['Timestamp']);
      const o = num(r['Overall Score']);
      if (!n || !d || o === null) { liveSkipped++; continue; }
      if (!isPhoenix(r['LOB'])) { liveSkipped++; continue; }
      live.push([ nameId(n), Math.round(o), isPass(r['Result']) ? 1 : 0, d, pct(r, LIVE_COLS) ]);
    }

    sim.sort((a, b) => a[4] < b[4] ? -1 : 1);
    live.sort((a, b) => a[3] < b[3] ? -1 : 1);

    // Refuse to publish an empty or collapsed read. A transient Sheets failure
    // returning a handful of rows would otherwise wipe a working tab.
    if (sim.length < 50) throw new Error(`only ${sim.length} simulator rows parsed — refusing to overwrite`);

    const payload = {
      cats: SHORT, levels: LEVELS, names,
      recs: sim, live,
      from: sim.length ? sim[0][4] : '', to: sim.length ? sim[sim.length-1][4] : '',
      liveFrom: live.length ? live[0][3] : '', liveTo: live.length ? live[live.length-1][3] : ''
    };

    // Firestore arrays cannot contain arrays, so the snapshot travels as a JSON
    // string in one document — well inside the 1 MiB field limit.
    const body = {
      fields: {
        payload:   { stringValue: JSON.stringify(payload) },
        updatedAt: { stringValue: new Date().toISOString() },
        simRows:   { integerValue: String(sim.length) },
        liveRows:  { integerValue: String(live.length) }
      }
    };
    const put = await fetch(
      `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/sim_data/current`,
      { method: 'PATCH', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (!put.ok) throw new Error('firestore write failed: ' + (await put.text()).slice(0, 200));

    return res.status(200).json({
      ok: true, simRows: sim.length, liveRows: live.length, agents: names.length,
      skipped: { sim: simSkipped, live: liveSkipped },
      range: { sim: [payload.from, payload.to], live: [payload.liveFrom, payload.liveTo] }
    });
  } catch (e) {
    console.error('[sim-sync]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
