export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const HS_TOKEN = process.env.HS_TOKEN;
  if (!HS_TOKEN) return res.status(500).json({ error: 'HS_TOKEN not configured in Vercel environment variables' });

  // Retry helper — waits on 429 up to 2 times before giving up
  const hsFetch = async (url, opts) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(url, opts);
      if (r.status !== 429) return r;
      const wait = parseInt(r.headers.get('Retry-After') || '1', 10) * 1000;
      await new Promise(resolve => setTimeout(resolve, wait || 1000));
    }
    return { ok: false, status: 429, json: async () => ({ error: 'HubSpot rate limit — please retry in a moment' }) };
  };

  // Batch-read helper: HubSpot max 100 IDs per request — chunk and run in parallel
  const batchRead = async (url, ids, properties) => {
    if (!ids || ids.length === 0) return [];
    const CHUNK = 100;
    const chunks = [];
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
    const allResults = await Promise.all(chunks.map(chunk =>
      hsFetch(url, {
        method: 'POST', headers: h,
        body: JSON.stringify({ properties, inputs: chunk.map(id => ({ id })) })
      }).then(r => r.json()).then(d => d.results || []).catch(() => [])
    ));
    return allResults.flat();
  };

  const h = {
    'Authorization': 'Bearer ' + HS_TOKEN,
    'Content-Type': 'application/json'
  };

  const tsMs = ts => { if (!ts) return 0; const n = Number(ts); return isNaN(n) ? new Date(ts).getTime() : n; };

  try {
    // ── Step 1: Search tickets ──────────────────────────────────────────
    const ticketResp = await hsFetch('https://api.hubapi.com/crm/v3/objects/tickets/search', {
      method: 'POST', headers: h, body: JSON.stringify(req.body)
    });
    const ticketData = await ticketResp.json();
    if (!ticketResp.ok) return res.status(ticketResp.status).json(ticketData);

    const tickets = ticketData.results || [];
    if (tickets.length === 0) return res.status(200).json({ results: [], paging: ticketData.paging });

    const ticketIds = tickets.map(t => t.id);

    // Extract owner IDs now (needed for PATH A which runs alongside Step 2)
    const ticketOwnerIds = [...new Set(tickets.map(t => t.properties.hubspot_owner_id).filter(Boolean))];
    const thirtyDaysAgo = Date.now() - (30 * 86400000); // PATH A: 30-day window (enough for last-call display)

    // ── PHASE 1: Step 2 (4 association reads) + PATH A (owner search) — all parallel ──
    const ownerFilter = { propertyName: 'hubspot_owner_id', operator: 'IN', values: ticketOwnerIds };
    const dateFilter  = { propertyName: 'hs_timestamp', operator: 'GTE', value: String(thirtyDaysAgo) };

    const [
      contactAssocResp, noteAssocResp, callAssocResp, smsAssocResp,
      searchCallResp, searchSmsResp
    ] = await Promise.all([
      // Step 2: ticket associations
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
      }),
      // PATH A: owner-based call search (30 days, 200 results)
      ticketOwnerIds.length > 0 ? hsFetch('https://api.hubapi.com/crm/v3/objects/calls/search', {
        method: 'POST', headers: h,
        body: JSON.stringify({
          filterGroups: [{ filters: [ownerFilter, dateFilter] }],
          properties: ['hs_timestamp','hs_call_status','hs_call_body','hs_call_direction','hs_call_duration','hubspot_owner_id','hs_call_title'],
          sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
          limit: 200
        })
      }) : Promise.resolve({ json: async () => ({ results: [] }) }),
      // PATH A: owner-based SMS search
      ticketOwnerIds.length > 0 ? hsFetch('https://api.hubapi.com/crm/v3/objects/communications/search', {
        method: 'POST', headers: h,
        body: JSON.stringify({
          filterGroups: [{ filters: [ownerFilter, dateFilter] }],
          properties: ['hs_timestamp','hs_communication_body','hs_communication_channel_type','hubspot_owner_id','hs_communication_logged_from'],
          sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
          limit: 200
        })
      }) : Promise.resolve({ json: async () => ({ results: [] }) })
    ]);

    // Parse Step 2 results
    const contactAssoc = await contactAssocResp.json();
    const noteAssoc    = await noteAssocResp.json();
    const callAssoc    = await callAssocResp.json();
    const smsAssoc     = await smsAssocResp.json().catch(() => ({ results: [] }));

    const ticketContactMap = {};
    if (contactAssoc.results) {
      for (const r of contactAssoc.results) ticketContactMap[r.from.id] = (r.to || []).map(x => x.toObjectId);
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
    const allCallIds = [];
    if (callAssoc.results) {
      for (const r of callAssoc.results) {
        const ids = (r.to || []).map(x => x.toObjectId);
        ticketCallMap[r.from.id] = ids;
        allCallIds.push(...ids);
      }
    }
    const ticketSmsMap = {};
    const allSmsIds = [];
    if (smsAssoc.results) {
      for (const r of smsAssoc.results) {
        const ids = (r.to || []).map(x => x.toObjectId);
        ticketSmsMap[r.from.id] = ids;
        allSmsIds.push(...ids);
      }
    }

    // Parse PATH A results — cache details directly
    const callDetailCache = {};
    const smsDetailCache  = {};
    const newCallIds = [];
    const newSmsIds  = [];

    const searchCallData = await searchCallResp.json().catch(() => ({ results: [] }));
    const searchSmsData  = await searchSmsResp.json().catch(() => ({ results: [] }));

    for (const c of (searchCallData.results || [])) {
      const p = c.properties;
      if (!allCallIds.includes(c.id)) { allCallIds.push(c.id); newCallIds.push(c.id); }
      callDetailCache[c.id] = {
        type: 'call', timestamp: p.hs_timestamp || '', status: p.hs_call_status || '',
        connected: (p.hs_call_status || '').toUpperCase() === 'COMPLETED',
        body: (p.hs_call_body || '').replace(/<[^>]+>/g, '').trim(),
        direction: p.hs_call_direction || '', durationMs: parseInt(p.hs_call_duration || '0') || 0,
        ownerId: String(p.hubspot_owner_id || ''), title: p.hs_call_title || ''
      };
    }
    for (const s of (searchSmsData.results || [])) {
      const p = s.properties;
      if (!allSmsIds.includes(s.id)) { allSmsIds.push(s.id); newSmsIds.push(s.id); }
      const channel = (p.hs_communication_channel_type || '').toUpperCase();
      smsDetailCache[s.id] = {
        type: channel === 'SMS' ? 'sms' : (channel || 'message'), timestamp: p.hs_timestamp || '',
        status: 'SENT', connected: false,
        body: (p.hs_communication_body || '').replace(/<[^>]+>/g, '').trim(),
        direction: (p.hs_communication_logged_from || 'AGENT').toUpperCase() === 'CONTACT' ? 'INBOUND' : 'OUTBOUND',
        durationMs: 0, ownerId: String(p.hubspot_owner_id || ''), title: channel || 'SMS'
      };
    }

    // ── PHASE 2: Contact read + PATH B (contact→call assoc) — all parallel ──
    const allContactIds = [...new Set(Object.values(ticketContactMap).flat())];
    const contactCallMap = {};
    const contactSmsMap  = {};
    const contactMap     = {};

    if (allContactIds.length > 0) {
      const [contactResults, ctCallAssocResp, ctSmsAssocResp] = await Promise.all([
        batchRead(
          'https://api.hubapi.com/crm/v3/objects/contacts/batch/read',
          allContactIds.slice(0, 100),
          ['firstname','lastname','phone','mobilephone','email','lifecyclestage','createdate']
        ),
        hsFetch('https://api.hubapi.com/crm/v4/associations/contacts/calls/batch/read', {
          method: 'POST', headers: h,
          body: JSON.stringify({ inputs: allContactIds.slice(0, 500).map(id => ({ id: String(id) })) })
        }),
        hsFetch('https://api.hubapi.com/crm/v4/associations/contacts/communications/batch/read', {
          method: 'POST', headers: h,
          body: JSON.stringify({ inputs: allContactIds.slice(0, 500).map(id => ({ id: String(id) })) })
        })
      ]);

      for (const c of contactResults) {
        const p = c.properties;
        contactMap[c.id] = {
          name: [p.firstname, p.lastname].filter(Boolean).join(' ') || '(no name)',
          phone: p.mobilephone || p.phone || '', email: p.email || '',
          lifecycle: p.lifecyclestage || null, createdate: p.createdate || null
        };
      }

      const ctCallData = await ctCallAssocResp.json().catch(() => ({ results: [] }));
      const ctSmsData  = await ctSmsAssocResp.json().catch(() => ({ results: [] }));

      for (const r of (ctCallData.results || [])) {
        const cId = String(r.from.id);
        for (const to of (r.to || [])) {
          const callId = String(to.toObjectId);
          if (!contactCallMap[cId]) contactCallMap[cId] = [];
          if (!contactCallMap[cId].includes(callId)) contactCallMap[cId].push(callId);
          if (!allCallIds.includes(callId)) { allCallIds.push(callId); newCallIds.push(callId); }
        }
      }
      for (const r of (ctSmsData.results || [])) {
        const cId = String(r.from.id);
        for (const to of (r.to || [])) {
          const smsId = String(to.toObjectId);
          if (!contactSmsMap[cId]) contactSmsMap[cId] = [];
          if (!contactSmsMap[cId].includes(smsId)) contactSmsMap[cId].push(smsId);
          if (!allSmsIds.includes(smsId)) { allSmsIds.push(smsId); newSmsIds.push(smsId); }
        }
      }
    }

    // ── PATH C: Reverse-associate found IDs → contacts AND → tickets ──────
    const ticketDirectCallMap = {};
    const ticketDirectSmsMap  = {};
    const dedupeCallIds = [...new Set(newCallIds)].slice(0, 1000);
    const dedupeSmsIds  = [...new Set(newSmsIds)].slice(0, 1000);

    const [callContactResp, callTicketResp, smsContactResp, smsTicketResp] = await Promise.all([
      dedupeCallIds.length > 0 ? hsFetch('https://api.hubapi.com/crm/v4/associations/calls/contacts/batch/read', {
        method: 'POST', headers: h, body: JSON.stringify({ inputs: dedupeCallIds.map(id => ({ id })) })
      }) : Promise.resolve(null),
      dedupeCallIds.length > 0 ? hsFetch('https://api.hubapi.com/crm/v4/associations/calls/tickets/batch/read', {
        method: 'POST', headers: h, body: JSON.stringify({ inputs: dedupeCallIds.map(id => ({ id })) })
      }) : Promise.resolve(null),
      dedupeSmsIds.length > 0 ? hsFetch('https://api.hubapi.com/crm/v4/associations/communications/contacts/batch/read', {
        method: 'POST', headers: h, body: JSON.stringify({ inputs: dedupeSmsIds.map(id => ({ id })) })
      }) : Promise.resolve(null),
      dedupeSmsIds.length > 0 ? hsFetch('https://api.hubapi.com/crm/v4/associations/communications/tickets/batch/read', {
        method: 'POST', headers: h, body: JSON.stringify({ inputs: dedupeSmsIds.map(id => ({ id })) })
      }) : Promise.resolve(null)
    ]);

    const callContactData = callContactResp ? await callContactResp.json().catch(() => ({ results: [] })) : { results: [] };
    const callTicketData  = callTicketResp  ? await callTicketResp.json().catch(() => ({ results: [] }))  : { results: [] };
    const smsContactData  = smsContactResp  ? await smsContactResp.json().catch(() => ({ results: [] }))  : { results: [] };
    const smsTicketData   = smsTicketResp   ? await smsTicketResp.json().catch(() => ({ results: [] }))   : { results: [] };

    for (const r of (callContactData.results || [])) {
      for (const to of (r.to || [])) {
        const cId = String(to.toObjectId);
        if (!contactCallMap[cId]) contactCallMap[cId] = [];
        if (!contactCallMap[cId].includes(r.from.id)) contactCallMap[cId].push(r.from.id);
      }
    }
    for (const r of (callTicketData.results || [])) {
      for (const to of (r.to || [])) {
        const tId = String(to.toObjectId);
        if (!ticketDirectCallMap[tId]) ticketDirectCallMap[tId] = [];
        if (!ticketDirectCallMap[tId].includes(r.from.id)) ticketDirectCallMap[tId].push(r.from.id);
      }
    }
    for (const r of (smsContactData.results || [])) {
      for (const to of (r.to || [])) {
        const cId = String(to.toObjectId);
        if (!contactSmsMap[cId]) contactSmsMap[cId] = [];
        if (!contactSmsMap[cId].includes(r.from.id)) contactSmsMap[cId].push(r.from.id);
      }
    }
    for (const r of (smsTicketData.results || [])) {
      for (const to of (r.to || [])) {
        const tId = String(to.toObjectId);
        if (!ticketDirectSmsMap[tId]) ticketDirectSmsMap[tId] = [];
        if (!ticketDirectSmsMap[tId].includes(r.from.id)) ticketDirectSmsMap[tId].push(r.from.id);
      }
    }

    // ── PHASE 3: Batch-read notes + call details + SMS details — all parallel ──
    const noteIdsToFetch = [...new Set(allNoteIds)].slice(0, 150);
    const callIdsToFetch = [...new Set(allCallIds)].slice(0, 500);
    const smsIdsToFetch  = [...new Set(allSmsIds)].slice(0, 500);

    const [noteResults, callResults, smsResults] = await Promise.all([
      batchRead(
        'https://api.hubapi.com/crm/v3/objects/notes/batch/read',
        noteIdsToFetch,
        ['hs_note_body','hs_timestamp','createdate']
      ),
      batchRead(
        'https://api.hubapi.com/crm/v3/objects/calls/batch/read',
        callIdsToFetch,
        ['hs_timestamp','hs_call_status','hs_call_body','hs_call_direction','hs_call_duration','hubspot_owner_id','hs_call_title']
      ),
      batchRead(
        'https://api.hubapi.com/crm/v3/objects/communications/batch/read',
        smsIdsToFetch,
        ['hs_timestamp','hs_communication_body','hs_communication_channel_type','hubspot_owner_id','hs_communication_logged_from']
      )
    ]);

    const noteMap = {};
    for (const n of noteResults) {
      noteMap[n.id] = {
        body: (n.properties.hs_note_body || '').replace(/<[^>]+>/g, '').trim(),
        timestamp: n.properties.hs_timestamp || n.properties.createdate
      };
    }

    // Build callDetailMap: start from PATH A cache, fill in anything else from batch read
    const callDetailMap = Object.assign({}, callDetailCache);
    for (const c of callResults) {
      if (callDetailMap[c.id]) continue; // already cached from PATH A
      const p = c.properties;
      callDetailMap[c.id] = {
        type: 'call', timestamp: p.hs_timestamp || '', status: p.hs_call_status || '',
        connected: (p.hs_call_status || '').toUpperCase() === 'COMPLETED',
        body: (p.hs_call_body || '').replace(/<[^>]+>/g, '').trim(),
        direction: p.hs_call_direction || '', durationMs: parseInt(p.hs_call_duration || '0') || 0,
        ownerId: String(p.hubspot_owner_id || ''), title: p.hs_call_title || ''
      };
    }

    const smsDetailMap = Object.assign({}, smsDetailCache);
    for (const s of smsResults) {
      if (smsDetailMap[s.id]) continue;
      const p = s.properties;
      const channel = (p.hs_communication_channel_type || '').toUpperCase();
      smsDetailMap[s.id] = {
        type: channel === 'SMS' ? 'sms' : (channel || 'message'), timestamp: p.hs_timestamp || '',
        status: 'SENT', connected: false,
        body: (p.hs_communication_body || '').replace(/<[^>]+>/g, '').trim(),
        direction: (p.hs_communication_logged_from || 'AGENT').toUpperCase() === 'CONTACT' ? 'INBOUND' : 'OUTBOUND',
        durationMs: 0, ownerId: String(p.hubspot_owner_id || ''), title: channel || 'SMS'
      };
    }

    // ── Step 6: Enrich & return ──────────────────────────────────────────
    const enriched = tickets.map(ticket => {
      const cIds = ticketContactMap[ticket.id] || [];
      const contact = cIds.length > 0 ? (contactMap[cIds[0]] || null) : null;

      const nIds = ticketNoteMap[ticket.id] || [];
      const notes = nIds.map(id => noteMap[id]).filter(Boolean);
      notes.sort((a, b) => tsMs(b.timestamp) - tsMs(a.timestamp));

      // Merge calls/SMS from all paths (deduplicate by id)
      const ticketCallIds = new Set(ticketCallMap[ticket.id] || []);
      const ticketSmsIdSet = new Set(ticketSmsMap[ticket.id] || []);
      (ticketDirectCallMap[ticket.id] || []).forEach(id => ticketCallIds.add(id));
      (ticketDirectSmsMap[ticket.id] || []).forEach(id => ticketSmsIdSet.add(id));
      for (const cId of cIds) {
        const cIdStr = String(cId);
        (contactCallMap[cIdStr] || []).forEach(id => ticketCallIds.add(id));
        (contactSmsMap[cIdStr] || []).forEach(id => ticketSmsIdSet.add(id));
      }

      const calls   = [...ticketCallIds].map(id => callDetailMap[id]).filter(Boolean);
      const smsMsgs = [...ticketSmsIdSet].map(id => smsDetailMap[id]).filter(Boolean);
      const allActivity = [...calls, ...smsMsgs];
      allActivity.sort((a, b) => tsMs(b.timestamp) - tsMs(a.timestamp));

      return {
        ...ticket,
        contactId: cIds[0] ? String(cIds[0]) : null,
        contactName: contact?.name || null,
        contactPhone: contact?.phone || null,
        contactEmail: contact?.email || null,
        contactLifecycle: contact?.lifecycle || null,
        contactCreatedate: contact?.createdate || null,
        latestNote: notes[0] ? { body: notes[0].body, timestamp: notes[0].timestamp } : null,
        calls: allActivity.slice(0, 300)
      };
    });

    return res.status(200).json({ results: enriched, paging: ticketData.paging });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
