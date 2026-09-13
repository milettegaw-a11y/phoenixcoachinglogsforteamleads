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
      const e164 = last10.length === 10 ? '+1' + last10 : String(req.query.phone);
      const r = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + HS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filterGroups: [
          { filters: [{ propertyName: 'phone', operator: 'EQ', value: e164 }] },
          { filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: e164 }] },
          { filters: [{ propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: '*' + last10 }] }
        ], properties: ['firstname'], limit: 3 })
      });
      const d = await r.json().catch(() => ({}));
      ids = (d.results || []).map(c => String(c.id));
      if (!ids.length) return res.status(200).json({ flags: {}, safeToSend: true, note: 'no contact on that number' });
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
