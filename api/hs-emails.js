// /api/hs-emails.js
// Returns email engagements for a given HubSpot contactId
// GET /api/hs-emails?contactId=XXXX
//
// Checks TWO places HubSpot stores emails:
//   1) CRM email objects (v4 association contacts→emails)  ← new system
//   2) Engagements of type EMAIL (legacy engagements API)  ← where 1:1 sent emails often live

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { contactId } = req.query;
  if (!contactId) return res.status(400).json({ error: 'contactId required' });

  const TOKEN = process.env.HS_TOKEN;
  if (!TOKEN) return res.status(500).json({ error: 'HS_TOKEN not set' });

  const h = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  const tsMs = ts => { if (!ts) return 0; const n = Number(ts); return isNaN(n) ? new Date(ts).getTime() : n; };

  try {
    // ── PATH 1: CRM Email objects via v4 association ─────────────────────
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v4/associations/contacts/emails/batch/read`,
      { method: 'POST', headers: h, body: JSON.stringify({ inputs: [{ id: contactId }] }) }
    );
    const assocData = await assocRes.json().catch(() => ({ results: [] }));
    const crmEmailIds = [];
    if (assocData.results) {
      for (const r of assocData.results) {
        (r.to || []).forEach(x => crmEmailIds.push(String(x.toObjectId)));
      }
    }

    let crmEmails = [];
    if (crmEmailIds.length > 0) {
      const batchRes = await fetch(
        'https://api.hubapi.com/crm/v3/objects/emails/batch/read',
        {
          method: 'POST', headers: h,
          body: JSON.stringify({
            inputs: crmEmailIds.slice(0, 100).map(id => ({ id })),
            properties: [
              'hs_email_direction', 'hs_email_subject', 'hs_email_text', 'hs_email_html',
              'hs_email_status', 'hs_timestamp', 'hubspot_owner_id',
              'hs_email_from_email', 'hs_email_from_firstname', 'hs_email_to_email'
            ]
          })
        }
      );
      const batchData = await batchRes.json().catch(() => ({ results: [] }));
      crmEmails = (batchData.results || []).map(e => {
        const p = e.properties || {};
        return {
          id: 'crm-' + e.id,
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
    }

    // ── PATH 2: Legacy engagements API (type=EMAIL) ────────────────────────
    // This is where HubSpot stores 1:1 CRM-sent emails from the contact record
    let engagementEmails = [];
    try {
      const engRes = await fetch(
        `https://api.hubapi.com/engagements/v1/engagements/associated/CONTACT/${contactId}/paged?type=EMAIL&limit=100`,
        { method: 'GET', headers: h }
      );
      const engData = await engRes.json().catch(() => ({ results: [] }));
      for (const item of (engData.results || [])) {
        const eng = item.engagement || {};
        const meta = item.metadata || {};
        if ((eng.type || '').toUpperCase() !== 'EMAIL') continue;
        const direction = (meta.direction || eng.direction || 'OUTBOUND').toUpperCase();
        const subject = meta.subject || meta.emailBody?.substring(0, 60) || '(no subject)';
        let body = '';
        if (meta.text) body = meta.text;
        else if (meta.html) body = meta.html.replace(/<[^>]+>/g, '').trim();
        else if (meta.emailBody) body = meta.emailBody.replace(/<[^>]+>/g, '').trim();
        const ts = eng.timestamp ? String(eng.timestamp) : null;
        engagementEmails.push({
          id: 'eng-' + eng.id,
          direction,
          subject,
          body: body || '(no body)',
          status: (meta.status || eng.status || ''),
          timestamp: ts,
          ownerId: String(eng.ownerId || ''),
          fromEmail: meta.from?.email || '',
          fromName: meta.from?.firstName || '',
          toEmail: (meta.to || []).map(x => x.email).filter(Boolean).join(', ')
        });
      }
    } catch (_) { /* engagements API optional */ }

    // ── Merge, deduplicate by timestamp+direction, sort newest first ────────
    const all = [...crmEmails, ...engagementEmails];
    // Deduplicate: if two entries have the same timestamp within 2 seconds, keep one
    const seen = new Set();
    const deduped = all.filter(e => {
      const key = `${Math.round(tsMs(e.timestamp)/2000)}-${e.direction}-${(e.subject||'').slice(0,20)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    deduped.sort((a, b) => tsMs(b.timestamp) - tsMs(a.timestamp));

    return res.status(200).json({ emails: deduped });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
