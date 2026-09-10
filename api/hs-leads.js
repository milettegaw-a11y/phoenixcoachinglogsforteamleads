// ── Aircall call-outcome tags → HubSpot "Call outcome" (hs_call_disposition) ──
// Aircall syncs each call's tag into HubSpot as the call disposition. These GUIDs
// are this portal's own option values (from the Call outcome property).
//
// Connect detection MUST come from here, not from hs_call_status: HubSpot marks
// every finished call COMPLETED, including No answer and Busy, so a status-based
// check reports ~100% connect for everyone.
const CALL_DISPOSITIONS = {
  'f240bbac-87c9-4f6e-bf70-924b57d47db7': 'Connected',
  '73a0d17f-1163-4015-bdd5-ec830791da20': 'No answer',
  '9d9162e7-6cf3-4944-bf63-4dff82258764': 'Busy',
  '17b47fee-58de-441e-a44c-c6300d46f273': 'Wrong number',
  'b2cf5968-551e-4856-9783-52b3da59a7d0': 'Left voicemail',
  'a4c4c377-d246-4b32-a13b-75a56a4cd0ff': 'Left live message',
  '8764b9cd-1d7b-4ee3-a75d-5bf72c2165af': 'Voicemail Drop',
  '072a759f-8582-4f74-ad99-cf011f07ed0d': 'Language barrier',
  'f8fa0e80-a10b-4e34-a99e-19b28160ecd1': 'Follow-up call',
  '309aeb24-e8ed-4906-b52d-50f1722426a5': 'Duplicate',
  '71485c7b-9019-41cb-b490-f3c042fb3b10': 'Growth | Call Did Not Connect',
  '8fa12906-a926-49e3-8931-f0bd23377997': 'Growth | Already an Existing Customer',
  '3e592798-a062-419a-a627-9cf8d35f9ef2': 'Growth | Did Not Buy',
  '7adbef2f-611c-4682-a292-33dca7b6bee6': 'Growth | Explicit DNC Request',
  'bba0eafa-028c-43da-a863-c74ffccb5c92': 'Growth | Not a Sales Lead',
  '7d609608-a375-4c47-be13-d99c735cfe0a': 'Growth | Request Callback',
  '8e332e1c-9772-4891-b49f-2ce4d6dd3f2f': 'Growth | SALES',
  '683f8fd0-8dad-46ed-9d50-58bc29f1fd9d': '1|Board Sale | FCR',
  '5bd1d99e-cca0-40f5-82ef-105c01cea136': '2|Board Sale - FC (voucher 1st job)',
  'f628a839-fe69-4169-b8d6-076842c77556': '3|Board Sale - nonFC (15|15+ 1st job)',
  '3079a568-6d47-4b1f-8e93-34bb03b0d7a9': '4|Existing Customer',
  '5b970d96-2dfb-4daa-b2cc-aeed67bc31d6': '5|Declined',
  '781b9766-49e9-4f37-b7d1-bedcf6ca4fe3': '6|No Answer',
  '83652b21-e82d-47ed-9ed7-842bd7b3325b': '7|Invalid #',
  '4a153ead-db34-42b1-acc3-54a1d2b1d7b7': '8|Cleaner',
  '282a4b1f-c88c-4d1d-bef4-fdf01c4038f1': '9|Duplicate',
  '7bd1d7d0-f30b-4abc-8d78-c8581d7b1b02': '10|DNC/Wrong #',
  'f1cac9e7-c3b3-4193-926a-d3668c541b6b': '11|Language Barrier',
  'adf8b6eb-06ca-4f81-be1b-926964601f10': '12|Hangup'
};

// Tags that mean a person actually picked up. Anything not listed here — and any
// tag we do not recognise — counts as NOT connected, so a newly added tag can
// never silently inflate TCR.
const CONNECTED_DISPOSITIONS = new Set([
  'f240bbac-87c9-4f6e-bf70-924b57d47db7', // Connected            — the only one in active use
  'a4c4c377-d246-4b32-a13b-75a56a4cd0ff', // Left live message
  '072a759f-8582-4f74-ad99-cf011f07ed0d', // Language barrier
  '8fa12906-a926-49e3-8931-f0bd23377997', // Growth | Already an Existing Customer
  '3e592798-a062-419a-a627-9cf8d35f9ef2', // Growth | Did Not Buy
  '7adbef2f-611c-4682-a292-33dca7b6bee6', // Growth | Explicit DNC Request
  'bba0eafa-028c-43da-a863-c74ffccb5c92', // Growth | Not a Sales Lead
  '7d609608-a375-4c47-be13-d99c735cfe0a', // Growth | Request Callback
  '8e332e1c-9772-4891-b49f-2ce4d6dd3f2f', // Growth | SALES
  '683f8fd0-8dad-46ed-9d50-58bc29f1fd9d', // 1|Board Sale | FCR
  '5bd1d99e-cca0-40f5-82ef-105c01cea136', // 2|Board Sale - FC
  'f628a839-fe69-4169-b8d6-076842c77556', // 3|Board Sale - nonFC
  '3079a568-6d47-4b1f-8e93-34bb03b0d7a9', // 4|Existing Customer
  '5b970d96-2dfb-4daa-b2cc-aeed67bc31d6', // 5|Declined
  '4a153ead-db34-42b1-acc3-54a1d2b1d7b7', // 8|Cleaner
  'f1cac9e7-c3b3-4193-926a-d3668c541b6b', // 11|Language Barrier
  'adf8b6eb-06ca-4f81-be1b-926964601f10'  // 12|Hangup
]);

const callConnectInfo = (dispositionId) => {
  const id = dispositionId || '';
  return { disposition: CALL_DISPOSITIONS[id] || '', connected: CONNECTED_DISPOSITIONS.has(id) };
};

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

  // SMS carries NO direction property — hs_communication_logged_from reads 'CRM' on
  // every record, inbound or not, so it cannot be used. These are written by the
  // Aircall integration, which states direction in the body text alone:
  //   "SMS Sent by <agent> on <team> to <contact>"   -> outbound
  //   "SMS Received from <contact>"                  -> inbound
  // Measured over a 9-day window, all 23,686 SMS matched one of four shapes:
  // SMS Sent by 21,740 | SMS Received from 1,910 | MMS Sent by 32 | MMS Received 4.
  // Requires a positive "Sent by" match to count as agent-sent: anything we cannot
  // read is treated as inbound and left out, so a template change under-counts
  // loudly rather than silently crediting lead replies again.
  // The Aircall body is HTML and prefixes the real text with a header line:
  //   "SMS Sent by <agent> on <team> : <loc> to <contact>   Message: <actual text>"
  // Keep what follows "Message:", drop the header otherwise, flatten the markup, and
  // escape the result: the panel inserts this via innerHTML, and the inbound half is
  // text a customer wrote, so it must not be able to inject markup.
  const smsMessageText = body => {
    let t = (body || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:div|p)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    t = t.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
         .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'");
    t = t.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    const m = t.match(/Message:\s*([\s\S]*)$/i);
    t = (m ? m[1] : t.replace(/^\s*(?:SMS|MMS)\s+(?:Sent\s+by|Received\s+from)[^\n]*\n?/i, '')).trim();
    // Aircall also appends a footer: "Status: delivered  (See the full conversation)".
    // Anchored at the end so a message that merely mentions the word is left alone.
    t = t.replace(/\s*\(See the full conversation\)\s*$/i, '')
         .replace(/\n\s*Status:\s*[^\n]*$/i, '').trim();
    const clipped = t.length > 600;
    return (clipped ? t.slice(0, 600).trimEnd() + '…' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  const smsIsOutbound = body =>
    /^\s*(?:SMS|MMS)\s+Sent\s+by\b/i.test((body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

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
    // NOTE: HubSpot's association batch/read caps `inputs` at 100. Sending more
    // silently returns associations for only the first 100 tickets, leaving the
    // rest with no calls/notes at all — so chunk, exactly like batchRead does.
    const assocRead = async (url, ids) => {
      const CHUNK = 100;
      const chunks = [];
      for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
      const parts = await Promise.all(chunks.map(chunk =>
        hsFetch(url, {
          method: 'POST', headers: h, body: JSON.stringify({ inputs: chunk.map(id => ({ id })) })
        }).then(r => r.json().catch(() => ({ results: [] })))
      ));
      return { results: parts.flatMap(p => p.results || []) };
    };

    const [contactAssoc, noteAssoc, callAssoc, smsAssoc] = await Promise.all([
      assocRead('https://api.hubapi.com/crm/v4/associations/tickets/contacts/batch/read', ticketIds),
      assocRead('https://api.hubapi.com/crm/v4/associations/tickets/notes/batch/read', ticketIds),
      assocRead('https://api.hubapi.com/crm/v4/associations/tickets/calls/batch/read', ticketIds),
      assocRead('https://api.hubapi.com/crm/v4/associations/tickets/communications/batch/read', ticketIds)
    ]);

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
          properties: ['hs_timestamp','hs_call_status','hs_call_disposition','hs_call_direction','hs_call_duration','hubspot_owner_id'],
          limit: 200
        }),
        searchAll('https://api.hubapi.com/crm/v3/objects/communications/search', {
          filterGroups: [{ filters: [timeGTE, timeLT, contactIn,
            { propertyName: 'hs_communication_channel_type', operator: 'EQ', value: 'SMS' }
          ]}],
          properties: ['hs_timestamp','hs_communication_channel_type','hubspot_owner_id','hs_communication_logged_from','hs_communication_body'],
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
          disposition: callConnectInfo(p.hs_call_disposition).disposition,
          connected: callConnectInfo(p.hs_call_disposition).connected,
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
          disposition: '',
          connected: false,
          direction: smsIsOutbound(p.hs_communication_body) ? 'OUTBOUND' : 'INBOUND',
          body: smsMessageText(p.hs_communication_body),
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
            ['hs_timestamp','hs_call_status','hs_call_disposition','hs_call_direction','hs_call_duration','hubspot_owner_id']
          )
        : Promise.resolve([]),
      ticketSmsIdList.length > 0
        ? batchRead(
            'https://api.hubapi.com/crm/v3/objects/communications/batch/read',
            ticketSmsIdList,
            ['hs_timestamp','hs_communication_channel_type','hubspot_owner_id','hs_communication_logged_from','hs_communication_body']
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
        disposition: callConnectInfo(p.hs_call_disposition).disposition,
        connected: callConnectInfo(p.hs_call_disposition).connected,
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
        disposition: '',
        connected: false,
        direction: smsIsOutbound(p.hs_communication_body) ? 'OUTBOUND' : 'INBOUND',
        body: smsMessageText(p.hs_communication_body),
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
