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

  // Paginated CRM search helper
  const searchAll = async (url, body, maxResults = 1000) => {
    const results = [];
    let after;
    do {
      const pageBody = after ? { ...body, after } : body;
      const resp = await hsFetch(url, {
        method: 'POST', headers: h, body: JSON.stringify(pageBody)
      });
      const data = await resp.json().catch(() => ({ results: [] }));
      results.push(...(data.results || []));
      after = data.paging?.next?.after;
    } while (after && results.length < maxResults);
    return results;
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

    // ── PHASE 1: Ticket associations in parallel ──────────────────────────────
    // ticket→contacts, ticket→notes, ticket→calls (direct), ticket→SMS (direct)
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
    const allTicketCallIds = new Set();
    if (callAssoc.results) {
      for (const r of callAssoc.results) {
        const ids = (r.to || []).map(x => String(x.toObjectId));
        ticketCallMap[r.from.id] = ids;
        ids.forEach(id => allTicketCallIds.add(id));
      }
    }

    const ticketSmsMap = {};
    const allTicketSmsIds = new Set();
    if (smsAssoc.results) {
      for (const r of smsAssoc.results) {
        const ids = (r.to || []).map(x => String(x.toObjectId));
        ticketSmsMap[r.from.id] = ids;
        ids.forEach(id => allTicketSmsIds.add(id));
      }
    }

    const allContactIds = [...new Set(Object.values(ticketContactMap).flat().map(String))];

    // ── PHASE 1.5: Search TODAY's calls/SMS by owner ──────────────────────────
    // Instead of fetching all historical contact→calls (which overflows any slice cap),
    // we search directly for calls/SMS made today by the ticket owners.
    // CDT = UTC-5; compute today's window in UTC ms.
    const cdtMs   = Date.now() - 5 * 3600000;
    const cdtDate  = new Date(cdtMs);
    const todayStartUTC = Date.UTC(cdtDate.getUTCFullYear(), cdtDate.getUTCMonth(), cdtDate.getUTCDate()) + 5 * 3600000;
    const todayEndUTC   = todayStartUTC + 86400000;

    const allOwnerIds = [...new Set(tickets.map(t => t.properties.hubspot_owner_id).filter(Boolean))];

    // contactId → [today's callIds / smsIds from search]
    const contactTodayCallMap = {};
    const contactTodaySmsMap  = {};
    // Pre-populated detail maps from today's search results
    const todayCallDetailMap  = {};
    const todaySmsDetailMap   = {};

    // Search by contact association — Aircall calls often have no hubspot_owner_id set,
    // so filtering by owner misses them. Filtering by contact IDs finds all today's
    // activity on those contacts regardless of how the call was logged.
    if (allContactIds.length > 0) {
      const timeGTE    = { propertyName: 'hs_timestamp', operator: 'GTE', value: String(todayStartUTC) };
      const timeLT     = { propertyName: 'hs_timestamp', operator: 'LT',  value: String(todayEndUTC)   };
      // HubSpot IN operator supports up to 300 values
      const contactSlice = allContactIds.slice(0, 300);
      const contactIn  = { propertyName: 'associations.contact', operator: 'IN', values: contactSlice };

      // Search today's calls and SMS in parallel
      const [todayCallList, todaySmsList] = await Promise.all([
        searchAll('https://api.hubapi.com/crm/v3/objects/calls/search', {
          filterGroups: [{ filters: [timeGTE, timeLT, contactIn] }],
          properties: ['hs_timestamp','hs_call_status','hs_call_direction','hs_call_duration','hubspot_owner_id'],
          limit: 200
        }),
        searchAll('https://api.hubapi.com/crm/v3/objects/communications/search', {
          filterGroups: [{ filters: [timeGTE, timeLT, contactIn,
            { propertyName: 'hs_communication_channel_type', operator: 'EQ', value: 'SMS' }
          ]}],
          properties: ['hs_timestamp','hs_communication_channel_type','hubspot_owner_id','hs_communication_logged_from'],
          limit: 200
        })
      ]);

      // Build today's detail maps directly from search results (no extra batch-read needed)
      for (const c of todayCallList) {
        const p = c.properties;
        todayCallDetailMap[String(c.id)] = {
          type: 'call',
          timestamp: p.hs_timestamp || '',
          status: p.hs_call_status || '',
          connected: (p.hs_call_status || '').toUpperCase() === 'COMPLETED',
          direction: p.hs_call_direction || '',
          durationMs: parseInt(p.hs_call_duration || '0') || 0,
          ownerId: String(p.hubspot_owner_id || '')
        };
      }
      for (const s of todaySmsList) {
        const p = s.properties;
        todaySmsDetailMap[String(s.id)] = {
          type: 'sms',
          timestamp: p.hs_timestamp || '',
          status: 'SENT',
          connected: false,
          direction: (p.hs_communication_logged_from || '').toUpperCase() === 'CONTACT' ? 'INBOUND' : 'OUTBOUND',
          durationMs: 0,
          ownerId: String(p.hubspot_owner_id || '')
        };
      }

      // Reverse-associate: find which contacts each today's call/SMS belongs to
      const todayCallIds2 = todayCallList.map(c => String(c.id));
      const todaySmsIds2  = todaySmsList.map(s => String(s.id));

      const [callContactAssoc, smsContactAssoc] = await Promise.all([
        todayCallIds2.length > 0
          ? hsFetch('https://api.hubapi.com/crm/v4/associations/calls/contacts/batch/read', {
              method: 'POST', headers: h,
              body: JSON.stringify({ inputs: todayCallIds2.map(id => ({ id })) })
            }).then(r => r.json()).catch(() => ({ results: [] }))
          : Promise.resolve({ results: [] }),
        todaySmsIds2.length > 0
          ? hsFetch('https://api.hubapi.com/crm/v4/associations/communications/contacts/batch/read', {
              method: 'POST', headers: h,
              body: JSON.stringify({ inputs: todaySmsIds2.map(id => ({ id })) })
            }).then(r => r.json()).catch(() => ({ results: [] }))
          : Promise.resolve({ results: [] })
      ]);

      // Build contactId → [today's callIds]
      for (const r of callContactAssoc.results || []) {
        const callId = String(r.from.id);
        for (const contact of r.to || []) {
          const cid = String(contact.toObjectId);
          if (!contactTodayCallMap[cid]) contactTodayCallMap[cid] = [];
          contactTodayCallMap[cid].push(callId);
        }
      }
      // Build contactId → [today's smsIds]
      for (const r of smsContactAssoc.results || []) {
        const smsId = String(r.from.id);
        for (const contact of r.to || []) {
          const cid = String(contact.toObjectId);
          if (!contactTodaySmsMap[cid]) contactTodaySmsMap[cid] = [];
          contactTodaySmsMap[cid].push(smsId);
        }
      }
    }

    // ── PHASE 2: Batch-read contacts, notes, and ticket-direct calls/SMS ─────
    // Ticket-direct call/SMS IDs are few (logged directly on the ticket, not contact),
    // so 500 is safe here. Today's contact-level calls already came from Phase 1.5 search.
    const noteIdList         = [...new Set(allNoteIds)].slice(0, 50);
    const ticketCallIdList   = [...allTicketCallIds].slice(0, 500);
    const ticketSmsIdList    = [...allTicketSmsIds].slice(0, 500);

    const [contactResults, noteResults, ticketCallResults, ticketSmsResults] = await Promise.all([
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
      ticketCallIdList.length > 0
        ? batchRead(
            'https://api.hubapi.com/crm/v3/objects/calls/batch/read',
            ticketCallIdList,
            ['hs_timestamp','hs_call_status','hs_call_direction','hs_call_duration','hubspot_owner_id']
          )
        : Promise.resolve([]),
      ticketSmsIdList.length > 0
        ? batchRead(
            'https://api.hubapi.com/crm/v3/objects/communications/batch/read',
            ticketSmsIdList,
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

    // Merge today's search details with ticket-direct details
    const callDetailMap = { ...todayCallDetailMap };
    for (const c of ticketCallResults) {
      if (callDetailMap[String(c.id)]) continue; // already populated from today's search
      const p = c.properties;
      callDetailMap[String(c.id)] = {
        type: 'call',
        timestamp: p.hs_timestamp || '',
        status: p.hs_call_status || '',
        connected: (p.hs_call_status || '').toUpperCase() === 'COMPLETED',
        direction: p.hs_call_direction || '',
        durationMs: parseInt(p.hs_call_duration || '0') || 0,
        ownerId: String(p.hubspot_owner_id || '')
      };
    }

    const smsDetailMap = { ...todaySmsDetailMap };
    for (const s of ticketSmsResults) {
      if (smsDetailMap[String(s.id)]) continue;
      const p = s.properties;
      const channel = (p.hs_communication_channel_type || '').toUpperCase();
      smsDetailMap[String(s.id)] = {
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

      // Merge ticket-direct + today's contact-level calls/SMS (from Phase 1.5 search)
      const callIds = [...new Set([
        ...(ticketCallMap[ticket.id] || []),
        ...cIds.flatMap(cid => contactTodayCallMap[cid] || [])
      ])];
      const smsIds = [...new Set([
        ...(ticketSmsMap[ticket.id] || []),
        ...cIds.flatMap(cid => contactTodaySmsMap[cid] || [])
      ])];

      const calls   = callIds.map(id => callDetailMap[String(id)]).filter(Boolean);
      const smsMsgs = smsIds.map(id => smsDetailMap[String(id)]).filter(Boolean);

      const allActivity = [...calls, ...smsMsgs];
      allActivity.sort((a, b) => tsMs(b.timestamp) - tsMs(a.timestamp));

      return {
        ...ticket,
        contactId:         cIds[0] || null,
        contactName:       contact?.name || null,
        contactPhone:      contact?.phone || null,
        contactEmail:      contact?.email || null,
        contactLifecycle:  contact?.lifecycle || null,
        contactCreatedate: contact?.createdate || null,
        latestNote: notes[0] ? { body: notes[0].body, timestamp: notes[0].timestamp } : null,
        // All activity for this ticket — owner filter applied client-side in index.html
        calls: allActivity.slice(0, 100)
      };
    });

    return res.status(200).json({ results: enriched, paging: ticketData.paging });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
