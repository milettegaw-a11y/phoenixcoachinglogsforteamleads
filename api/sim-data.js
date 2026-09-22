// Serves the Agent's Opportunity data to the app.
//
// The organisation blocks service-account key creation, so there is no admin
// credential available to read the sheets from a server. Instead an Apps Script
// deployment inside the user's own Google account publishes the raw columns,
// and this function does the normalising and hands the app a finished payload.
//
// One fetch serves every browser: the result is cached in memory, so thirty
// agents opening the tab do not become thirty requests to Apps Script.

const SCRIPT_URL   = process.env.SIM_SCRIPT_URL   || '';
const SCRIPT_TOKEN = process.env.SIM_SCRIPT_TOKEN || '';
const TTL_MS = 10 * 60 * 1000;

const RUBRIC = [10, 10, 15, 10, 14, 10, 14, 17];   // points per skill; totals 100
const SHORT  = ['Rapport','Early Objections','Discovery','Pain Points','FCF & Membership','Features as Benefits','Objection Handling','Closing'];
const LEVELS = ['Basic', 'Intermediate', 'Advanced'];

// Spellings of one person the free-text form has produced.
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

let _cache = null, _cacheAt = 0;

// Names arrive hand-typed: stray quotes, nicknames, double spaces, odd casing.
// Matching is done on a stripped key — letters and single spaces only — so
// 'Roxanne "Anna" Hila' and 'Roxanne Hila' resolve to the same person however
// either happens to be punctuated.
const simplify = (s) => String(s || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
const MERGE_KEYED = {};
for (const [from, to] of Object.entries(MERGE)) MERGE_KEYED[simplify(from)] = to;

const titleCase = (s) => String(s).replace(/[a-z]+/gi, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
function agentName(raw) {
  const key = simplify(raw);
  if (!key) return '';
  if (MERGE_KEYED[key]) return MERGE_KEYED[key];
  return titleCase(key);
}
// Phoenix under any spelling the form has seen. The vowel-less abbreviations
// have to be listed: "phnx" contains neither "pho" nor "nix", and leaving it
// out quietly dropped 20 rows before an end-to-end test caught it.
const PHOENIX_ABBR = new Set(['phx','phnx','pnx','phoenx','phonix','phoeni','pheonix','phoenix']);
function isPhoenix(lob) {
  const x = String(lob || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!x) return false;
  if (PHOENIX_ABBR.has(x)) return true;
  return x.includes('pho') && (x.includes('nix') || x.includes('nxi'));
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
const isPass = (v) => String(v || '').trim().toUpperCase() === 'PASS';

// Each skill as a percentage of the points it is worth. A few rows score above
// the maximum — the grader is not perfectly consistent — and are capped rather
// than allowed to read as better than full marks.
function pctFrom(row, firstSkillCol) {
  const out = [];
  for (let i = 0; i < 8; i++) {
    const v = num(row[firstSkillCol + i]);
    out.push(v === null ? -1 : Math.min(100, Math.round(100 * v / RUBRIC[i])));
  }
  return out;
}

function build(raw) {
  const names = [];
  const idx = new Map();
  const nameId = (n) => {
    if (!idx.has(n)) { idx.set(n, names.length); names.push(n); }
    return idx.get(n);
  };
  const col = (cols, name) => cols.indexOf(name);

  // Simulator rows: Timestamp, Agent Name, LOB, Simulator Name, Overall, Result, then 8 skills.
  const sc = raw.simCols, sFirst = 6;
  const sim = [];
  let simSkipped = 0;
  for (const r of (raw.sim || [])) {
    const n = agentName(r[col(sc, 'Agent Name')]);
    const d = isoDate(r[col(sc, 'Timestamp')]);
    const o = num(r[col(sc, 'Overall Score')]);
    if (!n || !d || o === null || !isPhoenix(r[col(sc, 'LOB')])) { simSkipped++; continue; }
    const lvl = String(r[col(sc, 'Simulator Name')] || '').trim();
    sim.push([ nameId(n), LEVELS.indexOf(lvl), Math.round(o), isPass(r[col(sc, 'Result')]) ? 1 : 0, d, pctFrom(r, sFirst) ]);
  }

  // Live rows: Call Date, Timestamp, Agent Name, LOB, Overall, Result, then 8 skills.
  const lc = raw.liveCols, lFirst = 6;
  const live = [];
  let liveSkipped = 0;
  for (const r of (raw.live || [])) {
    const n = agentName(r[col(lc, 'Agent Name')]);
    const d = isoDate(r[col(lc, 'Call Date')]) || isoDate(r[col(lc, 'Timestamp')]);
    const o = num(r[col(lc, 'Overall Score')]);
    if (!n || !d || o === null || !isPhoenix(r[col(lc, 'LOB')])) { liveSkipped++; continue; }
    live.push([ nameId(n), Math.round(o), isPass(r[col(lc, 'Result')]) ? 1 : 0, d, pctFrom(r, lFirst) ]);
  }

  sim.sort((a, b) => a[4] < b[4] ? -1 : 1);
  live.sort((a, b) => a[3] < b[3] ? -1 : 1);

  // Refuse a collapsed read rather than let it overwrite a working view.
  if (sim.length < 50) throw new Error(`only ${sim.length} simulator rows parsed`);

  return {
    cats: SHORT, levels: LEVELS, names, recs: sim, live,
    from: sim.length ? sim[0][4] : '', to: sim.length ? sim[sim.length - 1][4] : '',
    liveFrom: live.length ? live[0][3] : '', liveTo: live.length ? live[live.length - 1][3] : '',
    generatedAt: raw.generatedAt || new Date().toISOString(),
    skipped: { sim: simSkipped, live: liveSkipped }
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SCRIPT_URL || !SCRIPT_TOKEN) {
    return res.status(503).json({ error: 'not_configured', hint: 'SIM_SCRIPT_URL and SIM_SCRIPT_TOKEN are not set' });
  }
  const fresh = String(req.query?.refresh || '') === '1';
  if (!fresh && _cache && Date.now() - _cacheAt < TTL_MS) {
    return res.status(200).json({ ..._cache, cached: true });
  }
  try {
    const url = SCRIPT_URL + (SCRIPT_URL.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(SCRIPT_TOKEN);
    // Apps Script answers with a redirect to googleusercontent.com; fetch follows it.
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) throw new Error('apps script returned ' + r.status);
    const raw = await r.json();
    if (raw.error) throw new Error('apps script: ' + raw.error);

    const payload = build(raw);
    _cache = payload; _cacheAt = Date.now();
    return res.status(200).json(payload);
  } catch (e) {
    console.error('[sim-data]', e.message);
    // A stale copy beats an empty tab.
    if (_cache) return res.status(200).json({ ..._cache, cached: true, stale: true, error: e.message });
    return res.status(502).json({ error: e.message });
  }
}
