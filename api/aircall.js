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

    // Build params — note URLSearchParams encodes [] as %5B%5D which Aircall accepts
    const sharedParams = new URLSearchParams({
      'search[phone_number]': contactPhone,
      from:     String(fromSec),
      to:       String(toSec),
      per_page: '50'
    });

    // Fetch calls and SMS in parallel
    const [callRes, msgRes] = await Promise.allSettled([
      fetch(`${BASE}/calls?${sharedParams}`, { headers }),
      fetch(`${BASE}/messages?${sharedParams}`, { headers })
    ]);

    // Helper: full name from Aircall user object
    const userName = u => u ? [u.first_name, u.last_name].filter(Boolean).join(' ').trim() : '';

    // ── Parse calls ──────────────────────────────────────────────────────────
    let calls = [];
    if (callRes.status === 'fulfilled' && callRes.value.ok) {
      const d = await callRes.value.json().catch(() => ({}));
      calls = (d.calls || []).map(c => {
        // Aircall timestamps are Unix seconds
        const startMs   = (c.started_at || c.created_at || 0) * 1000;
        const isConn    = ['done', 'answered'].includes(c.status || '') && (c.duration || 0) > 0;
        return {
          type:        'call',
          timestamp:   String(startMs),
          status:      c.status || 'done',
          connected:   isConn,
          body:        c.comments || '',
          direction:   (c.direction || 'inbound').toUpperCase(),
          durationMs:  (c.duration || 0) * 1000,
          // Use Aircall user id as ownerId; front-end will remap to HS owner id
          ownerId:     String(c.user?.id || ''),
          ownerEmail:  (c.user?.email || '').toLowerCase(),
          ownerName:   userName(c.user),
          numberId:    String(c.number?.id || ''),
          numberName:  c.number?.name || '',
          title:       isConn ? 'Connected call' : 'Missed call',
          source:      'aircall',
          aircallId:   String(c.id)
        };
      });
    }

    // ── Parse SMS messages ───────────────────────────────────────────────────
    let messages = [];
    if (msgRes.status === 'fulfilled' && msgRes.value.ok) {
      const d = await msgRes.value.json().catch(() => ({}));
      messages = (d.messages || []).map(m => {
        const tsMs = (m.sent_at || m.created_at || 0) * 1000;
        return {
          type:       'sms',
          timestamp:  String(tsMs),
          status:     'delivered',
          connected:  false,
          body:       m.content || '(no content)',
          direction:  (m.direction || 'outbound').toUpperCase(),
          durationMs: 0,
          ownerId:    String(m.user?.id || ''),
          ownerEmail: (m.user?.email || '').toLowerCase(),
          ownerName:  userName(m.user),
          numberId:   String(m.number?.id || ''),
          numberName: m.number?.name || '',
          title:      'SMS',
          source:     'aircall',
          aircallId:  String(m.id)
        };
      });
    }

    return res.status(200).json({ calls, messages });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
