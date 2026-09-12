/* /api/my-actions — what has happened on one agent's leads since they last looked.
 *
 * The heavy Lead Compliance path enriches every ticket with associations, notes,
 * calls and SMS and takes the better part of a minute. This answers a much
 * narrower question — "any new activity on MY open 2nd-week leads since T?" —
 * so it can run every thirty seconds without costing anything.
 *
 * It deliberately searches activity by CONTACT rather than by owner: a reply the
 * lead sends to Apex, or a call another team places, never carries this agent's
 * owner id, and those are exactly the events the agent is not otherwise told
 * about.
 *
 * POST { ownerId, sinceMs }           → { leads, events, now }
 * POST { closedBy: "<ticketId>" }     → { stage, lifecycle, actors }
 */
const SUBJECT  = 'Sales Call Required (2nd Week)';
const PIPELINE = '736937559';
const SALE     = '1072805490';
const DNC      = '1072805493';
const CLOSED   = ['1072805490','1072805491','1072805492','1072805493','1072805494','1072805495'];

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
    for (let i = 0; i < 3; i++) {
      const r = await fetch(url, opts);
      if (r.status !== 429) return r;
      await new Promise(z => setTimeout(z, (parseInt(r.headers.get('Retry-After') || '1', 10) || 1) * 1000));
    }
    return { ok: false, status: 429, json: async () => ({ error: 'HubSpot rate limit' }) };
  };
  const search = async (object, body) => {
    const r = await hs('https://api.hubapi.com/crm/v3/objects/' + object + '/search',
      { method: 'POST', headers: h, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || ('HubSpot ' + r.status));
    return d;
  };
  const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

  try {
    const body = req.body || {};

    // ── Who closed this ticket, and how ─────────────────────────────────────
    // Only called once a closure is spotted, so the property-history read never
    // runs across the whole book.
    if (body.closedBy) {
      const id = String(body.closedBy);
      const r = await hs('https://api.hubapi.com/crm/v3/objects/tickets/' + id +
        '?propertiesWithHistory=hs_pipeline_stage&properties=hs_pipeline_stage,hubspot_owner_id', { headers: h });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json(d);
      const hist = ((d.propertiesWithHistory || {}).hs_pipeline_stage || []);
      const actors = hist.slice(0, 6).map(v => ({
        value: v.value, at: v.timestamp,
        by: String(v.updatedByUserId || v.sourceId || ''), source: v.sourceType || ''
      }));
      return res.status(200).json({
        stage: (d.properties || {}).hs_pipeline_stage || null,
        owner: (d.properties || {}).hubspot_owner_id || null, actors
      });
    }

    // ── The agent's open 2nd-week leads ─────────────────────────────────────
    const ownerId = String(body.ownerId || '');
    if (!ownerId) return res.status(400).json({ error: 'No ownerId.' });
    const sinceMs = Math.max(Number(body.sinceMs) || 0, Date.now() - 7 * 86400000);

    const tickets = [];
    let after = null, page = 0;
    do {
      // Only the live book. Without this it pages through every ticket the agent
      // has ever owned - well over a thousand - and never reaches today's.
      const q = {
        filterGroups: [{ filters: [
          { propertyName: 'hs_pipeline', operator: 'EQ', value: PIPELINE },
          { propertyName: 'subject', operator: 'EQ', value: SUBJECT },
          { propertyName: 'hubspot_owner_id', operator: 'EQ', value: ownerId },
          { propertyName: 'createdate', operator: 'GTE', value: String(Date.now() - 21 * 86400000) }
        ]}],
        properties: ['createdate', 'hs_pipeline_stage', 'hubspot_owner_id', 'closed_date'],
        sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
        limit: 100
      };
      if (after) q.after = after;
      const d = await search('tickets', q);
      tickets.push(...(d.results || []));
      after = (d.paging && d.paging.next && d.paging.next.after) || null;
    } while (after && ++page < 12);

    // ticket → contact
    const ids = tickets.map(t => t.id);
    const assoc = await Promise.all(chunk(ids, 100).map(c =>
      hs('https://api.hubapi.com/crm/v4/associations/tickets/contacts/batch/read',
        { method: 'POST', headers: h, body: JSON.stringify({ inputs: c.map(id => ({ id })) }) })
        .then(r => r.json()).catch(() => ({ results: [] }))));
    const t2c = {}, c2t = {};
    for (const part of assoc) for (const a of (part.results || [])) {
      const to = (a.to || [])[0];
      if (!to) continue;
      const cid = String(to.toObjectId);
      t2c[a.from.id] = cid;
      c2t[cid] = a.from.id;
    }

    // contact names + lifecycle — lifecycle is how a lead silently leaves the book
    const contactIds = [...new Set(Object.values(t2c))];
    const contacts = {};
    await Promise.all(chunk(contactIds, 100).map(c =>
      hs('https://api.hubapi.com/crm/v3/objects/contacts/batch/read', {
        method: 'POST', headers: h,
        body: JSON.stringify({ properties: ['firstname', 'lastname', 'phone', 'lifecyclestage'], inputs: c.map(id => ({ id })) })
      }).then(r => r.json()).then(d => {
        for (const x of (d.results || [])) {
          const p = x.properties || {};
          contacts[x.id] = {
            name: [p.firstname, p.lastname].filter(Boolean).join(' ').trim() || null,
            phone: p.phone || null, lifecycle: (p.lifecyclestage || '').toLowerCase()
          };
        }
      }).catch(() => {})));

    const leads = tickets.map(t => {
      const p = t.properties || {}, cid = t2c[t.id] || null;
      const c = (cid && contacts[cid]) || {};
      const stage = String(p.hs_pipeline_stage || '');
      return {
        id: t.id, contactId: cid, name: c.name || null, phone: c.phone || null,
        lifecycle: c.lifecycle || '', stage,
        closed: CLOSED.indexOf(stage) >= 0, sold: stage === SALE, dnc: stage === DNC,
        createdate: p.createdate || null, closedDate: p.closed_date || null
      };
    });

    // ── Activity on those contacts since the agent last looked ──────────────
    // By contact, not by owner: a reply to Apex carries somebody else's id.
    const events = [];
    const live = leads.filter(l => l.contactId && !l.closed).map(l => l.contactId);
    const since = { propertyName: 'hs_timestamp', operator: 'GTE', value: String(sinceMs) };
    for (const c of chunk(live, 300)) {
      const inContacts = { propertyName: 'associations.contact', operator: 'IN', values: c };
      const [calls, sms] = await Promise.all([
        search('calls', { filterGroups: [{ filters: [since, inContacts] }], limit: 100,
          properties: ['hs_timestamp','hs_call_status','hs_call_direction','hs_call_duration','hubspot_owner_id','hs_call_body'] }),
        search('communications', { filterGroups: [{ filters: [since, inContacts,
          { propertyName: 'hs_communication_channel_type', operator: 'EQ', value: 'SMS' }] }], limit: 100,
          properties: ['hs_timestamp','hubspot_owner_id','hs_communication_body'] })
      ]);
      const rows = [...(calls.results || []).map(x => ({ x, kind: 'call' })),
                    ...(sms.results || []).map(x => ({ x, kind: 'sms' }))];
      if (!rows.length) continue;
      // which contact each engagement belongs to
      const byKind = { call: [], sms: [] };
      rows.forEach(r => byKind[r.kind].push(r.x.id));
      const maps = {};
      for (const kind of ['call', 'sms']) {
        const obj = kind === 'call' ? 'calls' : 'communications';
        const parts = await Promise.all(chunk(byKind[kind], 100).map(ch =>
          hs('https://api.hubapi.com/crm/v4/associations/' + obj + '/contacts/batch/read',
            { method: 'POST', headers: h, body: JSON.stringify({ inputs: ch.map(id => ({ id })) }) })
            .then(r => r.json()).catch(() => ({ results: [] }))));
        maps[kind] = {};
        for (const part of parts) for (const a of (part.results || [])) {
          const to = (a.to || [])[0];
          if (to) maps[kind][a.from.id] = String(to.toObjectId);
        }
      }
      for (const { x, kind } of rows) {
        const cid = maps[kind][x.id];
        const ticketId = cid && c2t[cid];
        if (!ticketId) continue;
        const p = x.properties || {};
        const raw = kind === 'call' ? (p.hs_call_body || '') : (p.hs_communication_body || '');
        const text = String(raw).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
        // Aircall writes SMS direction into the body text, not a property.
        const outbound = kind === 'sms'
          ? /^\s*(?:SMS|MMS)\s+Sent\s+by\b/i.test(text)
          : String(p.hs_call_direction || '').toUpperCase() === 'OUTBOUND';
        const msg = kind === 'sms'
          ? (text.match(/Message:\s*([\s\S]*)$/i) || [, text])[1]
              .replace(/\s*\(See the full conversation\)\s*$/i, '')
              .replace(/\s*Status:\s*[^\n]*$/i, '').trim().slice(0, 240)
          : text.slice(0, 240);
        events.push({
          id: String(x.id), kind, ticketId, contactId: cid,
          ts: p.hs_timestamp || null,
          direction: outbound ? 'OUTBOUND' : 'INBOUND',
          actorId: String(p.hubspot_owner_id || ''),
          connected: kind === 'call' ? String(p.hs_call_status || '').toUpperCase() === 'COMPLETED' : true,
          durationMs: Number(p.hs_call_duration || 0),
          body: msg
        });
      }
    }
    events.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
    return res.status(200).json({ leads, events, now: Date.now() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
