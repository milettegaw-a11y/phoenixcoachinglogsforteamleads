export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const HS_TOKEN = process.env.HS_TOKEN;
  if (!HS_TOKEN) return res.status(500).json({ error: 'HS_TOKEN not configured' });

  // Retry helper — waits on 429 up to 2 times
  const hsFetch = async (url, opts) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(url, opts);
      if (r.status !== 429) return r;
      const wait = parseInt(r.headers.get('Retry-After') || '1', 10) * 1000;
      await new Promise(resolve => setTimeout(resolve, wait || 1000));
    }
    return { ok: false, status: 429, json: async () => ({ error: 'HubSpot rate limit — please retry' }) };
  };

  // Batch-read helper: chunk into 100-ID requests, run in parallel
  const batchRead = async (url, ids, properties) => {
    if (!ids || ids.length === 0) return [];
    const CHUNK = 100;
    const chunks = [];
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
    const results = await Promise.all(chunks.map(chunk =>
      hsFetch(url, {
        method: 'POST', headers: h,
        body: JSON.stringify({ properties, inputs: chunk.map(id => ({ id: String(id) })) })
      }).then(r => r.json()).then(d => d.results || []).catch(() => [])
    ));
    return results.flat();
  };

  const h = {
    'Authorization': 'Bearer ' + HS_TOKEN,
    'Content-Type': 'application/json'
  };

  const tsMs = ts => { if (!ts) return 0; const n = Number(ts); return isNaN(n) ? new Date(ts).getTime() : n; };

  try {
    // ── Step 1: Search tickets ────────────────────────────────────────────────
    const ticketResp = await hsFetch('https://api.hubapi.com/crm/v3/objects/tickets/search', {
      method: 'POST', headers: h, body: JSON.stringify(req.body)
    });
    const ticketData = await ticketResp.json();
    if (!ticketResp.ok) return res.status(ticketResp.status).json(ticketData);

    const tickets = ticketData.results || [];
    if (tickets.length === 0) return res.status(200).json({ results: [], paging: ticketData.paging });

    const ticketIds = tickets.map(t => t.id);

    // ── PHASE 1: All ticket associations in parallel ──────────────────────────
    // ticket→contacts, ticket→notes, ticket→calls, ticket→SMS
    const [contactAssocResp, noteAssocResp, callAssocResp, smsAssocResp] = await Promise.all([
      hsFetch('https://api.hubapi.com/crm/v4/associations/tickets/contacts/batch/read', {
        method: 'POST', headers: h, body: JSON.stringify({ inputs: ticketIds.map(id => ({ id })) })
      }),
      hsFetch('https://api.hubapi.com/crm/v4/associations/tickets/notes/batch/read', {
        method: 'POST', headers: h, body: JSON.stringify({ inputs: ticketIds.map(id => ({ id })) })
      }),
      hsFetch('https://api.hubapi.com/crm/v4/associations/tickets/calls/batch/read', {
        method: 'POST', headers: h, body: JSON.stringify({ inputs: ticketIds.map(id => ({ id })) })
      }),
      hsFetch('https://api.hubapi.com/crm/v4/associations/tickets/communications/batch/read', {
        method: 'POST', headers: h, body: JSON.stringify({ inputs: ticketIds.map(id => ({ id })) })
      })
    ]);

    const contactAssoc = await contactAssocResp.json();
    const noteAssoc    = await noteAssocResp.json();
    const callAssoc    = await callAssocResp.json();
    const smsAssoc     = await smsAssocResp.json().catch(() => ({ results: [] }));

    // Build association maps
    const ticketContactMap = {};
    if (contactAssoc.results) {
      for (const r of contactAssoc.results)
        ticketContactMap[r.from.id] = (r.to || []).map(x => x.toObjectId);
    }

    const ticketNoteMap = {};
    const allNoteIds = [];
    if (noteAssoc.results) {
      for (const r of noteAssoc.results) {
        const ids = (r.to || []).map(x => x.toObjectId);
        ticketNoteMap[r.from.id] = ids;
        allNoteIds.push(...ids);
      }
    }

    const ticketCallMap = {};
    const allCallIds = new Set();
    if (callAssoc.results) {
      for (const r of callAssoc.results) {
        const ids = (r.to || []).map(x => String(x.toObjectId));
        ticketCallMap[r.from.id] = ids;
        ids.forEach(id => allCallIds.add(id));
      }
    }

    const ticketSmsMap = {};
    const allSmsIds = new Set();
    if (smsAssoc.results) {
      for (const r of smsAssoc.results) {
        const ids = (r.to || []).map(x => String(x.toObjectId));
        ticketSmsMap[r.from.id] = ids;
        ids.forEach(id => allSmsIds.add(id));
      }
    }

    const allContactIds = [...new Set(Object.values(ticketContactMap).flat().map(String))];

    // ── PHASE 2: Batch-read all objects in parallel ───────────────────────────
    const callIdList  = [...allCallIds].slice(0, 300);
    const smsIdList   = [...allSmsIds].slice(0, 300);
    const noteIdList  = [...new Set(allNoteIds)].slice(0, 50);

    const [contactResults, noteResults, callResults, smsResults] = await Promise.all([
      allContactIds.length > 0
        ? batchRead(
            'https://api.hubapi.com/crm/v3/objects/contacts/batch/read',
            allContactIds,
            ['firstname','lastname','phone','mobilephone','email','lifecyclestage','createdate']
          )
        : Promise.resolve([]),
      noteIdList.length > 0
        ? batchRead(
            'https://api.hubapi.com/crm/v3/objects/notes/batch/read',
            noteIdList,
            ['hs_note_body','hs_timestamp','createdate']
          )
        : Promise.resolve([]),
      callIdList.length > 0
        ? batchRead(
            'https://api.hubapi.com/crm/v3/objects/calls/batch/read',
            callIdList,
            // Omit hs_call_body — large text field not needed for cadence
            ['hs_timestamp','hs_call_status','hs_call_direction','hs_call_duration','hubspot_owner_id']
          )
        : Promise.resolve([]),
      smsIdList.length > 0
        ? batchRead(
            'https://api.hubapi.com/crm/v3/objects/communications/batch/read',
            smsIdList,
            // Omit hs_communication_body — large text field not needed for cadence
            ['hs_timestamp','hs_communication_channel_type','hubspot_owner_id','hs_communication_logged_from']
          )
        : Promise.resolve([])
    ]);

    // Build lookup maps
    const contactMap = {};
    for (const c of contactResults) {
      const p = c.properties;
      contactMap[c.id] = {
        name: [p.firstname, p.lastname].filter(Boolean).join(' ') || '(no name)',
        phone: p.mobilephone || p.phone || '',
        email: p.email || '',
        lifecycle: p.lifecyclestage || null,
        createdate: p.createdate || null
      };
    }

    const noteMap = {};
    for (const n of noteResults) {
      noteMap[n.id] = {
        body: (n.properties.hs_note_body || '').replace(/<[^>]+>/g, '').slice(0, 300).trim(),
        timestamp: n.properties.hs_timestamp || n.properties.createdate
      };
    }

    const callDetailMap = {};
    for (const c of callResults) {
      const p = c.properties;
      callDetailMap[c.id] = {
        type: 'call',
        timestamp: p.hs_timestamp || '',
        status: p.hs_call_status || '',
        connected: (p.hs_call_status || '').toUpperCase() === 'COMPLETED',
        direction: p.hs_call_direction || '',
        durationMs: parseInt(p.hs_call_duration || '0') || 0,
        ownerId: String(p.hubspot_owner_id || '')
      };
    }

    const smsDetailMap = {};
    for (const s of smsResults) {
      const p = s.properties;
      const channel = (p.hs_communication_channel_type || '').toUpperCase();
      smsDetailMap[s.id] = {
        type: channel === 'SMS' ? 'sms' : (channel || 'message'),
        timestamp: p.hs_timestamp || '',
        status: 'SENT',
        connected: false,
        direction: (p.hs_communication_logged_from || 'AGENT').toUpperCase() === 'CONTACT' ? 'INBOUND' : 'OUTBOUND',
        durationMs: 0,
        ownerId: String(p.hubspot_owner_id || '')
      };
    }

    // ── Step 3: Enrich & return ───────────────────────────────────────────────
    const enriched = tickets.map(ticket => {
      const cIds   = (ticketContactMap[ticket.id] || []).map(String);
      const contact = cIds.length > 0 ? (contactMap[cIds[0]] || null) : null;

      const nIds  = ticketNoteMap[ticket.id] || [];
      const notes = nIds.map(id => noteMap[id]).filter(Boolean);
      notes.sort((a, b) => tsMs(b.timestamp) - tsMs(a.timestamp));

      const callIds  = ticketCallMap[ticket.id] || [];
      const smsIds   = ticketSmsMap[ticket.id] || [];
      const calls    = callIds.map(id => callDetailMap[id]).filter(Boolean);
      const smsMsgs  = smsIds.map(id => smsDetailMap[id]).filter(Boolean);

      const allActivity = [...calls, ...smsMsgs];
      allActivity.sort((a, b) => tsMs(b.timestamp) - tsMs(a.timestamp));

      return {
        ...ticket,
        contactId:        cIds[0] || null,
        contactName:      contact?.name || null,
        contactPhone:     contact?.phone || null,
        contactEmail:     contact?.email || null,
        contactLifecycle: contact?.lifecycle || null,
        contactCreatedate:contact?.createdate || null,
        latestNote: notes[0] ? { body: notes[0].body, timestamp: notes[0].timestamp } : null,
        // Return all ticket-associated activities (no owner filter — Aircall logs under different owner ID)
        calls: allActivity.slice(0, 100)
      };
    });

    return res.status(200).json({ results: enriched, paging: ticketData.paging });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
