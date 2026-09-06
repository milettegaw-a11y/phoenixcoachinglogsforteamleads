export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const HS_TOKEN = process.env.HS_TOKEN;
  if (!HS_TOKEN) return res.status(500).json({ error: 'HS_TOKEN not configured in Vercel environment variables' });

  const h = {
    'Authorization': 'Bearer ' + HS_TOKEN,
    'Content-Type': 'application/json'
  };

  try {
    // ── Step 1: Search tickets ──────────────────────────────────────────
    const ticketResp = await fetch('https://api.hubapi.com/crm/v3/objects/tickets/search', {
      method: 'POST', headers: h, body: JSON.stringify(req.body)
    });
    const ticketData = await ticketResp.json();
    if (!ticketResp.ok) return res.status(ticketResp.status).json(ticketData);

    const tickets = ticketData.results || [];
    if (tickets.length === 0) return res.status(200).json({ results: [], paging: ticketData.paging });

    const ticketIds = tickets.map(t => t.id);

    // ── Step 2: Get associations (contacts, notes, calls) in parallel ──
    const [contactAssocResp, noteAssocResp, callAssocResp] = await Promise.all([
      fetch('https://api.hubapi.com/crm/v4/associations/tickets/contacts/batch/read', {
        method: 'POST', headers: h,
        body: JSON.stringify({ inputs: ticketIds.map(id => ({ id })) })
      }),
      fetch('https://api.hubapi.com/crm/v4/associations/tickets/notes/batch/read', {
        method: 'POST', headers: h,
        body: JSON.stringify({ inputs: ticketIds.map(id => ({ id })) })
      }),
      fetch('https://api.hubapi.com/crm/v4/associations/tickets/calls/batch/read', {
        method: 'POST', headers: h,
        body: JSON.stringify({ inputs: ticketIds.map(id => ({ id })) })
      })
    ]);

    const contactAssoc = await contactAssocResp.json();
    const noteAssoc = await noteAssocResp.json();
    const callAssoc = await callAssocResp.json();

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

    // ── Step 3: Batch-read contacts ──────────────────────────────────────
    const allContactIds = [...new Set(Object.values(ticketContactMap).flat())];
    const contactMap = {};
    if (allContactIds.length > 0) {
      const cr = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/batch/read', {
        method: 'POST', headers: h,
        body: JSON.stringify({
          properties: ['firstname', 'lastname', 'phone', 'mobilephone', 'email'],
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
            email: p.email || ''
          };
        }
      }
    }

    // ── Step 4: Batch-read notes ──────────────────────────────────────────
    const noteMap = {};
    const noteIdsToFetch = [...new Set(allNoteIds)].slice(0, 150);
    if (noteIdsToFetch.length > 0) {
      const nr = await fetch('https://api.hubapi.com/crm/v3/objects/notes/batch/read', {
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
    const callDetailMap = {};
    const callIdsToFetch = [...new Set(allCallIds)].slice(0, 300);
    if (callIdsToFetch.length > 0) {
      const cr = await fetch('https://api.hubapi.com/crm/v3/objects/calls/batch/read', {
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
            connected: p.hs_call_status === 'COMPLETED',
            body: (p.hs_call_body || '').replace(/<[^>]+>/g, '').trim(),
            direction: p.hs_call_direction || '',
            durationMs: parseInt(p.hs_call_duration || '0') || 0,
            ownerId: p.hubspot_owner_id || '',
            title: p.hs_call_title || ''
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

      const callIds = ticketCallMap[ticket.id] || [];
      const calls = callIds.map(id => callDetailMap[id]).filter(Boolean);
      calls.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      return {
        ...ticket,
        contactName: contact?.name || null,
        contactPhone: contact?.phone || null,
        contactEmail: contact?.email || null,
        latestNote: notes[0] ? { body: notes[0].body, timestamp: notes[0].timestamp } : null,
        calls: calls.slice(0, 25)
      };
    });

    return res.status(200).json({ results: enriched, paging: ticketData.paging });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
