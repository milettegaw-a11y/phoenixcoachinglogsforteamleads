/* /api/lead-flags — has this person asked us to stop?
 *
 * Written by the Aircall hook the moment a lead declines, and readable by
 * anything that might message them — including the automated SMS that runs
 * outside this app. That is the point: the flag has to live somewhere the
 * sender can check, not just on a card an agent might read.
 *
 * GET  /api/lead-flags?contactId=123            → one contact
 * GET  /api/lead-flags?contactId=1,2,3          → several
 * GET  /api/lead-flags?phone=+15551234567       → by number, for senders that
 *                                                  only know the phone
 * POST { contactId, clear: true, by }           → a team lead lifting a flag
 */
const FB_PROJECT = 'phoenix-coaching';
const FB_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyDtvFa8jjJh6_MeYCT6hB7dw_wTM-xjas4';
const DOC = id => 'https://firestore.googleapis.com/v1/projects/' + FB_PROJECT +
  '/databases/(default)/documents/lead_flags/' + encodeURIComponent(String(id)) + '?key=' + FB_KEY;
const plain = f => {
  const o = {};
  for (const k in (f || {})) {
    const v = f[k];
    o[k] = v.booleanValue !== undefined ? v.booleanValue
         : v.integerValue !== undefined ? Number(v.integerValue)
         : v.stringValue !== undefined ? v.stringValue : null;
  }
  return o;
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'POST') {
      const b = req.body || {};
      if (!b.contactId) return res.status(400).json({ error: 'No contactId.' });
      if (!b.clear) return res.status(400).json({ error: 'Only clearing is supported here.' });
      const r = await fetch(DOC(b.contactId), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: {
          doNotContact: { booleanValue: false },
          clearedBy: { stringValue: String(b.by || 'unknown') },
          clearedAt: { integerValue: String(Date.now()) }
        }})
      });
      return res.status(r.ok ? 200 : 502).json({ cleared: r.ok, contactId: String(b.contactId) });
    }

    let ids = String(req.query.contactId || '').split(',').map(x => x.trim()).filter(Boolean);

    // Senders that only know a phone number get the same answer.
    if (!ids.length && req.query.phone) {
      const HS = process.env.HS_TOKEN;
      if (!HS) return res.status(500).json({ error: 'HS_TOKEN not configured' });
      const last10 = String(req.query.phone).replace(/\D/g, '').slice(-10);
      var lookupError = null;
      const e164 = last10.length === 10 ? '+1' + last10 : String(req.query.phone);
      // One filter at a time, exact first. Combining them into OR groups made a
      // single bad group fail the whole search and silently answer "no contact",
      // which on this endpoint means "safe to send" — the wrong way to be wrong.
      const tries = [
        { propertyName: 'phone', operator: 'EQ', value: e164 },
        { propertyName: 'mobilephone', operator: 'EQ', value: e164 },
        { propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: '*' + last10 },
        { propertyName: 'mobilephone', operator: 'CONTAINS_TOKEN', value: '*' + last10 }
      ];
      // HubSpot enforces a per-second limit and this endpoint is meant to be
      // consulted before every outbound message, so 429s are normal rather than
      // exceptional. Back off and try again instead of reporting a miss.
      const searchContacts = async filter => {
        for (let attempt = 0; attempt < 4; attempt++) {
          const r = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + HS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ filterGroups: [{ filters: [filter] }], properties: ['firstname'], limit: 3 })
          });
          const d = await r.json().catch(() => ({}));
          if (r.ok) return { ok: true, results: d.results || [] };
          if (r.status !== 429) return { ok: false, error: d.message || ('HubSpot ' + r.status) };
          await new Promise(z => setTimeout(z, 350 * (attempt + 1)));
        }
        return { ok: false, error: 'HubSpot rate limit' };
      };
      for (const f of tries) {
        const out2 = await searchContacts(f);
        if (!out2.ok) { lookupError = out2.error; continue; }
        lookupError = null;
        ids = out2.results.map(c => String(c.id));
        if (ids.length) break;
      }
      if (!ids.length) return res.status(lookupError ? 503 : 200).json(lookupError
        ? { error: 'Could not check: ' + lookupError, safeToSend: null, note: 'lookup failed — do not treat as safe' }
        : { flags: {}, safeToSend: true, note: 'no contact on that number' });
    }
    if (!ids.length) return res.status(400).json({ error: 'Pass contactId or phone.' });

    const out = {};
    await Promise.all(ids.slice(0, 50).map(async id => {
      const r = await fetch(DOC(id));
      if (!r.ok) { out[id] = { doNotContact: false }; return; }
      const d = await r.json();
      out[id] = plain(d.fields);
    }));
    const blocked = Object.values(out).some(f => f.doNotContact === true);
    return res.status(200).json({ flags: out, safeToSend: !blocked });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
