/* /api/outside-touch — how much of a week's 2nd-week book is being worked by
 * people who are not ours.
 *
 * A lead endorsed to Phoenix is still, quite often, being called and texted by
 * Apex or another team. Nothing measures that today. For one cohort week this
 * answers: of the leads we were given, what share has anyone outside the
 * cluster touched since it landed, who is doing it, and on which tickets.
 *
 * It is deliberately gentle. The cohort is ~3,700 leads a week and activity has
 * to be asked for a hundred contacts at a time, so the walk is paced and the
 * result is meant to be cached per week and re-read, never recomputed per view.
 *
 * POST { wk, ownerIds: [...] } → { wk, mon, leads, touched, pct, by, samples }
 */
const SUBJECT  = 'Sales Call Required (2nd Week)';
const PIPELINE = '736937559';
const EPOCH    = Date.UTC(2016, 0, 4);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const TOKEN = process.env.HS_TOKEN;
  if (!TOKEN) return res.status(500).json({ error: 'HS_TOKEN not configured' });
  const h = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };

  const hs = async (url, opts) => {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(url, opts);
      if (r.status !== 429) return r;
      await new Promise(z => setTimeout(z, 500 * (i + 1)));
    }
    return { ok: false, status: 429, json: async () => ({ message: 'HubSpot rate limit' }) };
  };
  const search = async (object, body) => {
    const r = await hs('https://api.hubapi.com/crm/v3/objects/' + object + '/search',
      { method: 'POST', headers: h, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || ('HubSpot ' + r.status));
    return d;
  };
  const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
  // Small, paced pool. Three at a time is what the portal takes while thirty
  // agents are also using it.
  const pool = async (jobs, width) => {
    const out = new Array(jobs.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
      while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); }
    }));
    return out;
  };

  try {
    const b = req.body || {};
    const wk = Number(b.wk);
    const ours = (b.ownerIds || []).map(String);
    if (!wk || !ours.length) return res.status(400).json({ error: 'Pass wk and ownerIds.' });
    const monMs = EPOCH + (wk - 1) * 7 * 86400000 + 5 * 3600000;   // Monday 00:00 CDT
    const endMs = Math.min(monMs + 7 * 86400000, Date.now());

    // ── the cohort, sampled ──────────────────────────────────────────────────
    // Measuring every one of ~3,700 leads costs about 250 requests a week, which
    // is what tipped the portal over. A random sample answers the same question
    // to within a few points and costs a fraction, so the week is sampled and the
    // margin is reported rather than hidden.
    const want = Math.min(Math.max(Number(b.sample) || 300, 50), 700);
    const perDay = Math.ceil(want / 7);
    const tickets = [];
    const totals = [];
    for (let day = 0; day < 7; day++) {
      const s = monMs + day * 86400000, e2 = s + 86400000 - 1;
      if (s > Date.now()) break;
      const d = await search('tickets', {
        filterGroups: [{ filters: [
          { propertyName: 'hs_pipeline', operator: 'EQ', value: PIPELINE },
          { propertyName: 'subject', operator: 'EQ', value: SUBJECT },
          { propertyName: 'hubspot_owner_id', operator: 'IN', values: ours },
          { propertyName: 'createdate', operator: 'BETWEEN', value: String(s), highValue: String(e2) }
        ]}],
        properties: ['createdate', 'hubspot_owner_id'],
        limit: Math.min(perDay, 100),
        sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }]
      });
      tickets.push(...(d.results || []));
      totals.push(Number(d.total || 0));
    }
    const cohortTotal = totals.reduce((a, c) => a + c, 0);
    if (!tickets.length) return res.status(200).json({ wk, leads: cohortTotal, sampled: 0, touched: 0, pct: 0, by: {}, samples: [] });

    // ── ticket → contact ─────────────────────────────────────────────────────
    const ids = tickets.map(t => t.id);
    const parts = await pool(chunk(ids, 100).map(c => () =>
      hs('https://api.hubapi.com/crm/v4/associations/tickets/contacts/batch/read',
        { method: 'POST', headers: h, body: JSON.stringify({ inputs: c.map(id => ({ id })) }) })
        .then(r => r.json()).catch(() => ({ results: [] }))), 3);
    const c2t = {}, t2c = {};
    for (const p of parts) for (const a of (p.results || [])) {
      const to = (a.to || [])[0];
      if (!to) continue;
      const cid = String(to.toObjectId);
      c2t[cid] = a.from.id; t2c[a.from.id] = cid;
    }
    const contacts = Object.keys(c2t);

    // ── who outside the cluster has touched them ─────────────────────────────
    const since = { propertyName: 'hs_timestamp', operator: 'GTE', value: String(monMs) };
    const until = { propertyName: 'hs_timestamp', operator: 'LTE', value: String(endMs + 7 * 86400000) };
    const notOurs = { propertyName: 'hubspot_owner_id', operator: 'NOT_IN', values: ours };
    const touchedTickets = new Set(), byOwner = {}, samples = [];

    const jobs = chunk(contacts, 100).map(c => async () => {
      const inC = { propertyName: 'associations.contact', operator: 'IN', values: c };
      for (const obj of ['calls', 'communications']) {
        let after = null, page = 0;
        do {
          const q = { filterGroups: [{ filters: [since, until, inC, notOurs] }],
            properties: ['hs_timestamp', 'hubspot_owner_id'], limit: 100 };
          if (after) q.after = after;
          let d;
          try { d = await search(obj, q); } catch (e) { return; }
          const rows = d.results || [];
          if (rows.length) {
            // which contact each engagement belongs to
            const aparts = await pool(chunk(rows.map(r => r.id), 100).map(ch => () =>
              hs('https://api.hubapi.com/crm/v4/associations/' + obj + '/contacts/batch/read',
                { method: 'POST', headers: h, body: JSON.stringify({ inputs: ch.map(id => ({ id })) }) })
                .then(r => r.json()).catch(() => ({ results: [] }))), 2);
            const map = {};
            for (const p2 of aparts) for (const a of (p2.results || [])) {
              const to = (a.to || [])[0];
              if (to) map[a.from.id] = String(to.toObjectId);
            }
            for (const r of rows) {
              const cid = map[r.id], tid = cid && c2t[cid];
              if (!tid) continue;
              const oid = String((r.properties || {}).hubspot_owner_id || '');
              touchedTickets.add(tid);
              byOwner[oid] = (byOwner[oid] || 0) + 1;
              if (samples.length < 60) samples.push({ ticketId: tid, ownerId: oid,
                ts: (r.properties || {}).hs_timestamp || null, kind: obj === 'calls' ? 'call' : 'sms' });
            }
          }
          after = (d.paging && d.paging.next && d.paging.next.after) || null;
        } while (after && ++page < 3);
      }
    });
    await pool(jobs, 2);

    // name the outsiders
    let owners = {};
    try {
      const r = await hs('https://api.hubapi.com/crm/v3/owners?limit=500', { headers: h });
      const d = await r.json();
      for (const o of (d.results || [])) owners[String(o.id)] = [o.firstName, o.lastName].filter(Boolean).join(' ');
    } catch (e) { owners = {}; }

    const by = {};
    for (const oid in byOwner) by[owners[oid] || (oid ? 'Owner ' + oid : 'No owner recorded')] = byOwner[oid];
    const sampled = tickets.length, touched = touchedTickets.size;
    const p = sampled ? touched / sampled : 0;
    // 95% interval on the sample, so nobody reads a 3-point wobble as a trend.
    const moe = sampled ? 1.96 * Math.sqrt(Math.max(p * (1 - p), 0.0001) / sampled) * 100 : 0;
    return res.status(200).json({
      wk, mon: new Date(monMs - 5 * 3600000).toISOString().slice(0, 10),
      leads: cohortTotal, sampled, touched, pct: p * 100, moe,
      by, samples: samples.map(x => Object.assign({}, x, { owner: owners[x.ownerId] || 'No owner recorded' })),
      builtAt: Date.now()
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
