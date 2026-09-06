// /api/hs-emails.js
// Returns email engagements for a given HubSpot contactId
// GET /api/hs-emails?contactId=XXXX

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { contactId } = req.query;
  if (!contactId) return res.status(400).json({ error: 'contactId required' });

  const TOKEN = process.env.HS_TOKEN;
  if (!TOKEN) return res.status(500).json({ error: 'HS_TOKEN not set' });

  const h = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  try {
    // Step 1: Get email IDs associated with this contact
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v4/associations/contacts/emails/batch/read`,
      {
        method: 'POST', headers: h,
        body: JSON.stringify({ inputs: [{ id: contactId }] })
      }
    );
    const assocData = await assocRes.json();
    const emailIds = [];
    if (assocData.results) {
      for (const r of assocData.results) {
        (r.to || []).forEach(x => emailIds.push(x.toObjectId));
      }
    }

    if (emailIds.length === 0) return res.status(200).json({ emails: [] });

    // Step 2: Batch-read email details (max 100)
    const batchRes = await fetch(
      'https://api.hubapi.com/crm/v3/objects/emails/batch/read',
      {
        method: 'POST', headers: h,
        body: JSON.stringify({
          inputs: emailIds.slice(0, 100).map(id => ({ id })),
          properties: [
            'hs_email_direction',
            'hs_email_subject',
            'hs_email_text',
            'hs_email_html',
            'hs_email_status',
            'hs_timestamp',
            'hubspot_owner_id',
            'hs_email_from_email',
            'hs_email_from_firstname',
            'hs_email_to_email',
            'hs_email_headers'
          ]
        })
      }
    );
    const batchData = await batchRes.json();

    const emails = (batchData.results || []).map(e => {
      const p = e.properties || {};
      return {
        id: e.id,
        direction: (p.hs_email_direction || 'OUTBOUND').toUpperCase(),
        subject: p.hs_email_subject || '(no subject)',
        body: p.hs_email_text || (p.hs_email_html || '').replace(/<[^>]+>/g, '').trim() || '(no body)',
        status: p.hs_email_status || '',
        timestamp: p.hs_timestamp || null,
        ownerId: p.hubspot_owner_id || '',
        fromEmail: p.hs_email_from_email || '',
        fromName: p.hs_email_from_firstname || '',
        toEmail: p.hs_email_to_email || ''
      };
    });

    // Sort newest first
    emails.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return res.status(200).json({ emails });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
