// /api/hs-contact-update.js
// PATCH /api/hs-contact-update  — updates a HubSpot contact's name, phone, email
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });

  const TOKEN = process.env.HS_TOKEN;
  if (!TOKEN) return res.status(500).json({ error: 'HS_TOKEN not set' });

  const { contactId, name, phone, email } = req.body || {};
  if (!contactId) return res.status(400).json({ error: 'contactId required' });

  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  const firstname = parts[0] || '';
  const lastname  = parts.slice(1).join(' ') || '';

  const props = {};
  if (firstname) props.firstname = firstname;
  if (lastname !== undefined) props.lastname = lastname;
  if (phone)  props.phone  = phone;
  if (email)  props.email  = email;

  try {
    const r = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties: props })
      }
    );
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json(d);
    return res.status(200).json({ success: true, id: d.id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
