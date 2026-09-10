// /api/aircall.js
// Fetches call and SMS activity from Aircall for a given contact phone number
//
// GET /api/aircall?contactPhone=+1XXXXXXXXXX&from=epochMs&to=epochMs
//   Returns { calls: [...], messages: [...] } in the same format as hs-leads.js calls array
//
// GET /api/aircall?action=users
//   Returns { users: [{id, name, email}] } for Aircall→HubSpot owner mapping
//
// Auth: Basic Auth with AIRCALL_API_ID:AIRCALL_API_TOKEN (Base64)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const API_ID    = process.env.AIRCALL_API_ID;
  const API_TOKEN = process.env.AIRCALL_API_TOKEN;

  if (!API_ID || !API_TOKEN) {
    return res.status(500).json({ error: 'Aircall credentials not configured — set AIRCALL_API_ID and AIRCALL_API_TOKEN in Vercel env vars' });
  }

  const auth    = Buffer.from(`${API_ID}:${API_TOKEN}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}`, Accept: 'application/json' };
  const BASE    = 'https://api.aircall.io/v1';

  const { action, contactPhone, from, to } = req.query;

  try {
    // ── ACTION: users list (for Aircall→HubSpot owner mapping) ──────────────
    if (action === 'users') {
      let page = 1, allUsers = [];
      while (true) {
        const r = await fetch(`${BASE}/users?per_page=50&page=${page}`, { headers });
        if (!r.ok) break;
        const d = await r.json().catch(() => ({}));
        const batch = d.users || [];
        for (const u of batch) {
          allUsers.push({
            id:    String(u.id),
            name:  [u.first_name, u.last_name].filter(Boolean).join(' ').trim(),
            email: (u.email || '').toLowerCase()
          });
        }
        if (!d.meta || page >= (d.meta.total_pages || 1)) break;
        page++;
      }
      return res.status(200).json({ users: allUsers });
    }

    // ── ACTION: numbers list (lines) ─────────────────────────────────────────
    if (action === 'numbers') {
      let page = 1, allNumbers = [];
      while (true) {
        const r = await fetch(`${BASE}/numbers?per_page=50&page=${page}`, { headers });
        if (!r.ok) break;
        const d = await r.json().catch(() => ({}));
        const batch = d.numbers || [];
        for (const n of batch) {
          allNumbers.push({ id: n.id, name: n.name || '', digits: n.digits || n.phone_number || '', state: n.state || '' });
        }
        if (!d.meta || page >= (d.meta.total_pages || 1)) break;
        page++;
      }
      return res.status(200).json({ numbers: allNumbers });
    }

    // ── ACTION: calls + messages for a contact phone ─────────────────────────
    if (!contactPhone) {
      return res.status(400).json({ error: 'contactPhone required (or action=users)' });
    }

    // Convert epoch-ms to epoch-seconds for Aircall API
    const fromSec = from
      ? Math.floor(Number(from) / 1000)
      : Math.floor((Date.now() - 90 * 24 * 3600 * 1000) / 1000); // default 90 days
    const toSec = to
      ? Math.floor(Number(to) / 1000)
      : Math.floor(Date.now() / 1000);

    // Aircall's /calls list endpoint IGNORES search[phone_number]: it returned the
    // same account-wide calls for every number, including one that does not exist,
    // so any lead could have been shown another customer's history. Filtering is
    // done through /calls/search AND re-checked here against the contact's digits,
    // so a filter that silently stops working can only under-return, never leak.
    const last10 = v => String(v || '').replace(/\D/g, '').slice(-10);
    const want   = last10(contactPhone);

    const partyDigits = o => {
      const vals = [o.raw_digits, o.from, o.to];
      if (o.contact && Array.isArray(o.contact.phone_numbers)) {
        for (const pn of o.contact.phone_numbers) vals.push(pn && pn.value);
      }
      if (o.participants && Array.isArray(o.participants)) {
        for (const p of o.participants) vals.push(p && (p.phone_number || p.raw_digits));
      }
      return vals.map(last10).filter(Boolean);
    };
    const involvesContact = o => !want || partyDigits(o).includes(want);

    // Paginate — a single page of 50 truncated every busy contact's history.
    const fetchPaged = async (path, key) => {
      const out = [];
      for (let page = 1; page <= 6; page++) {
        const p = new URLSearchParams({
          phone_number: contactPhone,
          from: String(fromSec),
          to:   String(toSec),
          order: 'desc',            // newest first; the old default gave the OLDEST 50
          per_page: '50',
          page: String(page)
        });
        let r;
        try { r = await fetch(`${BASE}${path}?${p}`, { headers }); } catch (e) { break; }
        if (!r.ok) break;
        const d = await r.json().catch(() => ({}));
        const arr = d[key] || [];
        out.push(...arr);
        if (arr.length < 50) break;
      }
      return out;
    };

    const [rawCalls, rawMsgs] = await Promise.all([
      fetchPaged('/calls/search', 'calls'),
      fetchPaged('/messages/search', 'messages')
    ]);

    // Helper: full name from Aircall user object
    const userName = u => u ? [u.first_name, u.last_name].filter(Boolean).join(' ').trim() : '';

    const calls = rawCalls.filter(involvesContact).map(c => {
      const startMs = (c.started_at || c.created_at || 0) * 1000;
      const isConn  = ['done', 'answered'].includes(c.status || '') && (c.duration || 0) > 0;
      return {
        type:       'call',
        timestamp:  String(startMs),
        status:     c.status || 'done',
        connected:  isConn,
        body:       c.comments || '',
        direction:  (c.direction || 'inbound').toUpperCase(),
        durationMs: (c.duration || 0) * 1000,
        ownerId:    String((c.user && c.user.id) || ''),
        ownerEmail: ((c.user && c.user.email) || '').toLowerCase(),
        ownerName:  userName(c.user),
        numberId:   String((c.number && c.number.id) || ''),
        numberName: (c.number && c.number.name) || '',
        title:      isConn ? 'Connected call' : 'Missed call',
        source:     'aircall',
        aircallId:  String(c.id)
      };
    });

    const messages = rawMsgs.filter(involvesContact).map(m => {
      const tsMs = (m.sent_at || m.created_at || 0) * 1000;
      return {
        type:       'sms',
        timestamp:  String(tsMs),
        status:     'delivered',
        connected:  false,
        body:       m.content || '',
        direction:  (m.direction || 'outbound').toUpperCase(),
        durationMs: 0,
        ownerId:    String((m.user && m.user.id) || ''),
        ownerEmail: ((m.user && m.user.email) || '').toLowerCase(),
        ownerName:  userName(m.user),
        numberId:   String((m.number && m.number.id) || ''),
        numberName: (m.number && m.number.name) || '',
        title:      'SMS',
        source:     'aircall',
        aircallId:  String(m.id)
      };
    });

    // Surfaced so a filter regression is visible instead of silent.
    const dropped = (rawCalls.length - calls.length) + (rawMsgs.length - messages.length);

    return res.status(200).json({ calls, messages, fetched: rawCalls.length + rawMsgs.length, dropped });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
