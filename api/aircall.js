// /api/aircall.js
// Fetches call and SMS activity from Aircall for a given contact phone number
//
// GET /api/aircall?contactPhone=+1XXXXXXXXXX&from=epochMs&to=epochMs
//   Returns { calls: [...], messages: [...] }
//
// GET /api/aircall?action=users
//   Returns { users: [{id, name, email}] } for Aircall->HubSpot owner mapping
//
// Auth: Basic Auth with AIRCALL_API_ID:AIRCALL_API_TOKEN (Base64)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const API_ID    = process.env.AIRCALL_API_ID;
  const API_TOKEN = process.env.AIRCALL_API_TOKEN;

  if (!API_ID || !API_TOKEN) {
    return res.status(500).json({ error: 'Aircall credentials not configured - set AIRCALL_API_ID and AIRCALL_API_TOKEN in Vercel env vars' });
  }

  const auth    = Buffer.from(API_ID + ':' + API_TOKEN).toString('base64');
  const headers = { Authorization: 'Basic ' + auth, Accept: 'application/json' };
  const BASE    = 'https://api.aircall.io/v1';
  const { action, contactPhone, from, to } = req.query;

  try {
    if (action === 'users') {
      let page = 1, allUsers = [];
      while (true) {
        const r = await fetch(BASE + '/users?per_page=50&page=' + page, { headers });
        if (!r.ok) break;
        const d = await r.json().catch(() => ({}));
        for (const u of (d.users || [])) {
          allUsers.push({ id: String(u.id), name: [u.first_name, u.last_name].filter(Boolean).join(' ').trim(), email: (u.email || '').toLowerCase() });
        }
        if (!d.meta || page >= (d.meta.total_pages || 1)) break;
        page++;
      }
      return res.status(200).json({ users: allUsers });
    }

    if (!contactPhone) return res.status(400).json({ error: 'contactPhone required (or action=users)' });

    const fromSec = from ? Math.floor(Number(from)/1000) : Math.floor((Date.now()-90*24*3600*1000)/1000);
    const toSec   = to   ? Math.floor(Number(to)/1000)   : Math.floor(Date.now()/1000);
    const params  = new URLSearchParams({ 'search[phone_number]': contactPhone, from: String(fromSec), to: String(toSec), per_page: '50' });

    const [callRes, msgRes] = await Promise.allSettled([
      fetch(BASE + '/calls?' + params, { headers }),
      fetch(BASE + '/messages?' + params, { headers })
    ]);

    const uName = u => u ? [u.first_name, u.last_name].filter(Boolean).join(' ').trim() : '';

    let calls = [];
    if (callRes.status === 'fulfilled' && callRes.value.ok) {
      const d = await callRes.value.json().catch(() => ({}));
      calls = (d.calls || []).map(c => {
        const startMs = (c.started_at || c.created_at || 0) * 1000;
        const isConn  = ['done','answered'].includes(c.status||'') && (c.duration||0) > 0;
        return { type:'call', timestamp:String(startMs), status:c.status||'done', connected:isConn, body:c.comments||'', direction:(c.direction||'inbound').toUpperCase(), durationMs:(c.duration||0)*1000, ownerId:String(c.user&&c.user.id||''), ownerEmail:(c.user&&c.user.email||'').toLowerCase(), ownerName:uName(c.user), title:isConn?'Connected call':'Missed call', source:'aircall', aircallId:String(c.id) };
      });
    }

    let messages = [];
    if (msgRes.status === 'fulfilled' && msgRes.value.ok) {
      const d = await msgRes.value.json().catch(() => ({}));
      messages = (d.messages || []).map(m => {
        const tsMs = (m.sent_at || m.created_at || 0) * 1000;
        return { type:'sms', timestamp:String(tsMs), status:'delivered', connected:false, body:m.content||'(no content)', direction:(m.direction||'outbound').toUpperCase(), durationMs:0, ownerId:String(m.user&&m.user.id||''), ownerEmail:(m.user&&m.user.email||'').toLowerCase(), ownerName:uName(m.user), title:'SMS', source:'aircall', aircallId:String(m.id) };
      });
    }

    return res.status(200).json({ calls, messages });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
