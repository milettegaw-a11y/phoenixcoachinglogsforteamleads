export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const HS_TOKEN = process.env.HS_TOKEN;
  if (!HS_TOKEN) return res.status(500).json({ error: 'HS_TOKEN not configured in Vercel environment variables' });

  // Retry helper — waits on 429 (rate limit) up to 2 times before giving up
  const hsFetch = async (url, opts) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(url, opts);
      if (r.status !== 429) return r;
      const wait = parseInt(r.headers.get('Retry-After') || '1', 10) * 1000;
      await new Promise(resolve => setTimeout(resolve, wait || 1000));
    }
    return { ok: false, status: 429, json: async () => ({ error: 'HubSpot rate limit — please retry in a moment' }) };
  };

  const h = {
    'Authorization': 'Bearer ' + HS_TOKEN,
    'Content-Type': 'application/json'
  };

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

    // ── Step 2: Get associations (contacts, notes, calls, SMS/communications) in parallel ──
    const [contactAssocResp, noteAssocResp, callAssocResp, smsAssocResp] = await Promise.all([
      hsFetch('https://api.hubapi.com/crm/v4/associations/tickets/contacts/batch/read', {
        method: 'POST', headers: h,
        body: JSON.stringify({ inputs: ticketIds.map(id => ({ id })) })
      }),
      hsFetch('https://api.hubapi.com/crm/v4/associations/tickets/notes/batch/read', {
        method: 'POST', headers: h,
        body: JSON.stringify({ inputs: ticketIds.map(id => ({ id })) })
      }),
      hsFetch('https://api.hubapi.com/crm/v4/associations/tickets/calls/batch/read', {
        method: 'POST', headers: h,
        body: JSON.stringify({ inputs: ticketIds.map(id => ({ id })) })
      }),
      hsFetch('https://api.hubapi.com/crm/v4/associations/tickets/communications/batch/read', {
        method: 'POST', headers: h,
        body: JSON.stringify({ inputs: ticketIds.map(id => ({ id })) })
      })
    ]);

    const contactAssoc = await contactAssocResp.json();
    const noteAssoc = await noteAssocResp.json();
    const callAssoc = await callAssocResp.json();
    const smsAssoc = await smsAssocResp.json().catch(() => ({ results: [] }));

    // Build contact map
    const ticketContactMap = {};
    if (contactAssoc.results) {
      for (const r of contactAssoc.results) {
        ticketContactMap[r.from.id] = (r.to || []).map(x => x.toObjectId);
      }
    }

    // Build note map
    const ticketNoteMap = {};
    const allNoteIds = [];
    if (noteAssoc.results) {
      for (const r of noteAssoc.results) {
        const ids = (r.to || []).map(x => x.toObjectId);
        ticketNoteMap[r.from.id] = ids;
        allNoteIds.push(...ids);
      }
    }

    // Build call map
    const ticketCallMap = {};
    const allCallIds = [];
    if (callAssoc.results) {
      for (const r of callAssoc.results) {
        const ids = (r.to || []).map(x => x.toObjectId);
        ticketCallMap[r.from.id] = ids;
        allCallIds.push(...ids);
      }
    }

    // Build SMS/communications map
    const ticketSmsMap = {};
    const allSmsIds = [];
    if (smsAssoc.results) {
      for (const r of smsAssoc.results) {
        const ids = (r.to || []).map(x => x.toObjectId);
        ticketSmsMap[r.from.id] = ids;
        allSmsIds.push(...ids);
      }
    }

    // ── Step 3: Batch-read contacts ──────────────────────────────────────
    const allContactIds = [...new Set(Object.values(ticketContactMap).flat())];
    const contactMap = {};
    if (allContactIds.length > 0) {
      const cr = await hsFetch('https://api.hubapi.com/crm/v3/objects/contacts/batch/read', {
        method: 'POST', headers: h,
        body: JSON.stringify({
          properties: ['firstname', 'lastname', 'phone', 'mobilephone', 'email', 'lifecyclestage', 'createdate'],
          inputs: allContactIds.slice(0, 100).map(id => ({ id }))
        })
      });
      const cd = await cr.json();
      if (cd.results) {
        for (const c of cd.results) {
          const p = c.properties;
          contactMap[c.id] = {
            name: [p.firstname, p.lastname].filter(Boolean).join(' ') || '(no name)',
            phone: p.mobilephone || p.phone || '',
            email: p.email || '',
            lifecycle: p.lifecyclestage || null,
            createdate: p.createdate || null
          };
        }
      }
    }

    // ── Step 3b: Exhaustive call/SMS lookup ──────────────────────────────
    // Three parallel paths — HubSpot is inconsistent about where it stores associations:
    //   A) Search calls/SMS by owner+date (most reliable for finding recent activity)
    //   B) Contact→calls forward association (contacts we already have)
    //   C) Reverse-associate found IDs back to contacts AND tickets
    const contactCallMap = {};      // contactId → [callIds]
    const contactSmsMap = {};       // contactId → [smsIds]
    const ticketDirectCallMap = {}; // ticketId  → [callIds] (call linked directly to ticket)
    const ticketDirectSmsMap = {};  // ticketId  → [smsIds]
    const fifteenDaysAgo = Date.now() - (15 * 86400000);
    const ticketOwnerIds = [...new Set(tickets.map(t => t.properties.hubspot_owner_id).filter(Boolean))];

    // PATH A: Search calls + SMS by owner+date
    let newCallIds = [];
    let newSmsIds = [];
    if (ticketOwnerIds.length > 0) {
      const ownerFilter = { propertyName: 'hubspot_owner_id', operator: 'IN', values: ticketOwnerIds };
      const dateFilter  = { propertyName: 'hs_timestamp', operator: 'GTE', value: String(fifteenDaysAgo) };
      const [searchCallResp, searchSmsResp] = await Promise.all([
        hsFetch('https://api.hubapi.com/crm/v3/objects/calls/search', {
          method: 'POST', headers: h,
          body: JSON.stringify({ filterGroups: [{ filters: [ownerFilter, dateFilter] }],
            properties: ['hs_timestamp','hs_call_status','hs_call_body','hs_call_direction','hs_call_duration','hubspot_owner_id','hs_call_title'],
            limit: 100 })
        }),
        hsFetch('https://api.hubapi.com/crm/v3/objects/communications/search', {
          method: 'POST', headers: h,
          body: JSON.stringify({ filterGroups: [{ filters: [ownerFilter, dateFilter] }],
            properties: ['hs_timestamp','hs_communication_body','hs_communication_channel_type','hubspot_owner_id','hs_communication_logged_from'],
            limit: 100 })
        })
      ]);
      const searchCallData = await searchCallResp.json().catch(() => ({ results: [] }));
      const searchSmsData  = await searchSmsResp.json().catch(() => ({ results: [] }));
      for (const c of (searchCallData.results || [])) {
        const p = c.properties;
        if (!allCallIds.includes(c.id)) allCallIds.push(c.id);
        newCallIds.push(c.id);
        allCallIds._detailCache = allCallIds._detailCache || {};
        allCallIds._detailCache[c.id] = {
          type: 'call', timestamp: p.hs_timestamp || '', status: p.hs_call_status || '',
          connected: (p.hs_call_status || '').toUpperCase() === 'COMPLETED',
          body: (p.hs_call_body || '').replace(/<[^>]+>/g, '').trim(),
          direction: p.hs_call_direction || '',
          durationMs: parseInt(p.hs_call_duration || '0') || 0,
          ownerId: String(p.hubspot_owner_id || ''), title: p.hs_call_title || ''
        };
      }
      for (const s of (searchSmsData.results || [])) {
        const p = s.properties;
        if (!allSmsIds.includes(s.id)) allSmsIds.push(s.id);
        newSmsIds.push(s.id);
        allSmsIds._detailCache = allSmsIds._detailCache || {};
        const channel = (p.hs_communication_channel_type || '').toUpperCase();
        allSmsIds._detailCache[s.id] = {
          type: channel === 'SMS' ? 'sms' : (channel || 'message'), timestamp: p.hs_timestamp || '',
          status: 'SENT', connected: false,
          body: (p.hs_communication_body || '').replace(/<[^>]+>/g, '').trim(),
          direction: (p.hs_communication_logged_from || 'AGENT').toUpperCase() === 'CONTACT' ? 'INBOUND' : 'OUTBOUND',
          durationMs: 0, ownerId: String(p.hubspot_owner_id || ''), title: channel || 'SMS'
        };
      }
    }

    // PATH B: Contact→calls/SMS forward association (using contacts we already fetched)
    if (allContactIds.length > 0) {
      const [ctCallAssocResp, ctSmsAssocResp] = await Promise.all([
        hsFetch('https://api.hubapi.com/crm/v4/associations/contacts/calls/batch/read', {
          method: 'POST', headers: h,
          body: JSON.stringify({ inputs: allContactIds.slice(0, 100).map(id => ({ id: String(id) })) })
        }),
        hsFetch('https://api.hubapi.com/crm/v4/associations/contacts/communications/batch/read', {
          method: 'POST', headers: h,
          body: JSON.stringify({ inputs: allContactIds.slice(0, 100).map(id => ({ id: String(id) })) })
        })
      ]);
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

    // PATH C: Reverse-associate found IDs → contacts AND → tickets
    const dedupeCallIds = [...new Set(newCallIds)].slice(0, 100);
    const dedupeSmsIds  = [...new Set(newSmsIds)].slice(0, 100);
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

    // ── Step 4: Batch-read notes ──────────────────────────────────────────
    const noteMap = {};
    const noteIdsToFetch = [...new Set(allNoteIds)].slice(0, 150);
    if (noteIdsToFetch.length > 0) {
      const nr = await hsFetch('https://api.hubapi.com/crm/v3/objects/notes/batch/read', {
        method: 'POST', headers: h,
        body: JSON.stringify({
          properties: ['hs_note_body', 'hs_timestamp', 'createdate'],
          inputs: noteIdsToFetch.map(id => ({ id }))
        })
      });
      const nd = await nr.json();
      if (nd.results) {
        for (const n of nd.results) {
          noteMap[n.id] = {
            body: (n.properties.hs_note_body || '').replace(/<[^>]+>/g, '').trim(),
            timestamp: n.properties.hs_timestamp || n.properties.createdate
          };
        }
      }
    }

    // ── Step 5: Batch-read calls ──────────────────────────────────────────
    const callDetailMap = Object.assign({}, allCallIds._detailCache || {});
    const callIdsToFetch = [...new Set(allCallIds)].slice(0, 300);
    if (callIdsToFetch.length > 0) {
      const cr = await hsFetch('https://api.hubapi.com/crm/v3/objects/calls/batch/read', {
        method: 'POST', headers: h,
        body: JSON.stringify({
          properties: ['hs_timestamp', 'hs_call_status', 'hs_call_body', 'hs_call_direction', 'hs_call_duration', 'hubspot_owner_id', 'hs_call_title'],
          inputs: callIdsToFetch.map(id => ({ id }))
        })
      });
      const cd = await cr.json();
      if (cd.results) {
        for (const c of cd.results) {
          const p = c.properties;
          callDetailMap[c.id] = {
            type: 'call',
            timestamp: p.hs_timestamp || '',
            status: p.hs_call_status || '',
            connected: (p.hs_call_status || '').toUpperCase() === 'COMPLETED',
            body: (p.hs_call_body || '').replace(/<[^>]+>/g, '').trim(),
            direction: p.hs_call_direction || '',
            durationMs: parseInt(p.hs_call_duration || '0') || 0,
            ownerId: String(p.hubspot_owner_id || ''),
            title: p.hs_call_title || ''
          };
        }
      }
    }

    // ── Step 5b: Batch-read SMS/communications ────────────────────────────
    const smsDetailMap = Object.assign({}, allSmsIds._detailCache || {});
    const smsIdsToFetch = [...new Set(allSmsIds)].slice(0, 300);
    if (smsIdsToFetch.length > 0) {
      const sr = await hsFetch('https://api.hubapi.com/crm/v3/objects/communications/batch/read', {
        method: 'POST', headers: h,
        body: JSON.stringify({
          properties: ['hs_timestamp', 'hs_communication_body', 'hs_communication_channel_type', 'hubspot_owner_id', 'hs_communication_logged_from'],
          inputs: smsIdsToFetch.map(id => ({ id }))
        })
      });
      const sd = await sr.json().catch(() => ({ results: [] }));
      if (sd.results) {
        for (const s of sd.results) {
          const p = s.properties;
          const channel = (p.hs_communication_channel_type || '').toUpperCase();
          smsDetailMap[s.id] = {
            type: channel === 'SMS' ? 'sms' : (channel || 'message'),
            timestamp: p.hs_timestamp || '',
            status: 'SENT',
            connected: false,
            body: (p.hs_communication_body || '').replace(/<[^>]+>/g, '').trim(),
            direction: (p.hs_communication_logged_from || 'AGENT').toUpperCase() === 'CONTACT' ? 'INBOUND' : 'OUTBOUND',
            durationMs: 0,
            ownerId: String(p.hubspot_owner_id || ''),
            title: channel || 'SMS'
          };
        }
      }
    }

    // ── Step 6: Enrich & return ──────────────────────────────────────────
    const enriched = tickets.map(ticket => {
      const cIds = ticketContactMap[ticket.id] || [];
      const contact = cIds.length > 0 ? (contactMap[cIds[0]] || null) : null;

      const nIds = ticketNoteMap[ticket.id] || [];
      const notes = nIds.map(id => noteMap[id]).filter(Boolean);
      notes.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      // Merge calls/SMS from all paths (deduplicate by id)
      const ticketCallIds = new Set(ticketCallMap[ticket.id] || []);
      const ticketSmsIdSet = new Set(ticketSmsMap[ticket.id] || []);
      // Path A/C: calls directly reverse-associated to this ticket
      (ticketDirectCallMap[ticket.id] || []).forEach(id => ticketCallIds.add(id));
      (ticketDirectSmsMap[ticket.id] || []).forEach(id => ticketSmsIdSet.add(id));
      // Path B/C: calls via contact association
      for (const cId of cIds) {
        const cIdStr = String(cId);
        (contactCallMap[cIdStr] || []).forEach(id => ticketCallIds.add(id));
        (contactSmsMap[cIdStr] || []).forEach(id => ticketSmsIdSet.add(id));
      }
      const calls = [...ticketCallIds].map(id => callDetailMap[id]).filter(Boolean);
      const smsMsgs = [...ticketSmsIdSet].map(id => smsDetailMap[id]).filter(Boolean);

      const allActivity = [...calls, ...smsMsgs];
      allActivity.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      return {
        ...ticket,
        contactName: contact?.name || null,
        contactPhone: contact?.phone || null,
        contactEmail: contact?.email || null,
        contactLifecycle: contact?.lifecycle || null,
        contactCreatedate: contact?.createdate || null,
        latestNote: notes[0] ? { body: notes[0].body, timestamp: notes[0].timestamp } : null,
        calls: allActivity.slice(0, 30)
      };
    });

    return res.status(200).json({ results: enriched, paging: ticketData.paging });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
