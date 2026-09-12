/* /api/aircall-hook — Aircall tells us the instant something happens on a lead.
 *
 * The poll in My Actions is thirty seconds behind at worst. This closes that gap:
 * Aircall fires, we resolve the phone number to the HubSpot contact, find their
 * 2nd-week ticket, and write an alert straight into the OWNER's queue — whoever
 * happened to be on the line. The agent's browser is already listening, so the
 * card appears without anyone refreshing anything.
 *
 * Register it in Aircall against: message.received, message.sent, call.ended.
 * Guard it by setting AIRCALL_HOOK_SECRET and registering ?secret=<value>.
 */
const SUBJECT  = 'Sales Call Required (2nd Week)';
const PIPELINE = '736937559';
const CLOSED   = ['1072805490','1072805491','1072805492','1072805493','1072805494','1072805495'];
const FB_PROJECT = 'phoenix-coaching';
// Same key the browser already ships in page source — this grants nothing extra.
const FB_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyDtvFa8jjJh6_MeYCT6hB7dw_wTM-xjas4';

const digits = v => String(v || '').replace(/\D/g, '');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  // Always 200 to Aircall, whatever we decide — a 4xx makes it retry, then disable
  // the subscription. Anything we cannot use is simply ignored.
  const ok = (why, extra) => res.status(200).json(Object.assign({ received: true, why }, extra || {}));
  if (req.method !== 'POST') return ok('not a POST');

  const secret = process.env.AIRCALL_HOOK_SECRET;
  if (secret && String(req.query.secret || '') !== secret) return ok('bad secret');

  const TOKEN = process.env.HS_TOKEN;
  if (!TOKEN) return ok('HS_TOKEN not configured');
  const h = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };

  try {
    const body = req.body || {};
    const event = String(body.event || '');
    const d = body.data || {};
    if (!/^(message\.|call\.)/.test(event)) return ok('event not watched: ' + event);

    // ── who was on the other end ─────────────────────────────────────────────
    // Aircall puts the counterparty in different places depending on the event
    // and the direction, so try them all rather than trusting one shape.
    const inbound = String(d.direction || '').toLowerCase() === 'inbound';
    const candidates = [d.raw_digits, d.from, d.to,
      d.contact && d.contact.phone_numbers && d.contact.phone_numbers[0] && d.contact.phone_numbers[0].value,
      d.participants && d.participants[0] && d.participants[0].phone_number];
    const phone = candidates.map(digits).find(p => p.length >= 10);
    if (!phone) return ok('no usable phone on the payload');
    const last10 = phone.slice(-10);

    const hs = async (url, opts) => {
      for (let i = 0; i < 3; i++) {
        const r = await fetch(url, opts);
        if (r.status !== 429) return r;
        await new Promise(z => setTimeout(z, 1000));
      }
      return { ok: false, status: 429, json: async () => ({}) };
    };

    // ── phone → contact ──────────────────────────────────────────────────────
    // HubSpot stores numbers as +1XXXXXXXXXX, and CONTAINS_TOKEN on bare digits
    // does not match that, so try the shapes in order of how exact they are and
    // stop at the first hit. The wildcard form is what actually catches the
    // formatting HubSpot uses; the rest are cheap insurance.
    const e164 = last10.length === 10 ? '+1' + last10 : '+' + phone;
    const tries = [
      { propertyName: 'phone',        operator: 'EQ',             value: e164 },
      { propertyName: 'mobilephone',  operator: 'EQ',             value: e164 },
      { propertyName: 'phone',        operator: 'CONTAINS_TOKEN', value: '*' + last10 },
      { propertyName: 'mobilephone',  operator: 'CONTAINS_TOKEN', value: '*' + last10 },
      { propertyName: 'hs_searchable_calculated_phone_number', operator: 'CONTAINS_TOKEN', value: '*' + last10 }
    ];
    let contact = null, matchedBy = null;
    for (const f of tries) {
      const r = await hs('https://api.hubapi.com/crm/v3/objects/contacts/search', {
        method: 'POST', headers: h,
        body: JSON.stringify({ filterGroups: [{ filters: [f] }],
          properties: ['firstname', 'lastname', 'phone'], limit: 3 })
      });
      const jd = await r.json().catch(() => ({}));
      contact = (jd.results || [])[0];
      if (contact) { matchedBy = f.propertyName + ' ' + f.operator; break; }
    }
    if (!contact) return ok('no HubSpot contact on ' + last10);

    // ── contact → their open 2nd-week ticket ─────────────────────────────────
    const ts = await hs('https://api.hubapi.com/crm/v3/objects/tickets/search', {
      method: 'POST', headers: h,
      body: JSON.stringify({
        filterGroups: [{ filters: [
          { propertyName: 'associations.contact', operator: 'IN', values: [String(contact.id)] },
          { propertyName: 'hs_pipeline', operator: 'EQ', value: PIPELINE },
          { propertyName: 'subject', operator: 'EQ', value: SUBJECT },
          { propertyName: 'hs_pipeline_stage', operator: 'NOT_IN', values: CLOSED }
        ]}],
        properties: ['hubspot_owner_id', 'hs_pipeline_stage', 'createdate'],
        sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }], limit: 1
      })
    });
    const td = await ts.json();
    const ticket = (td.results || [])[0];
    if (!ticket) return ok('no open 2nd-week ticket for that contact');
    const p = ticket.properties || {};
    const ownerId = String(p.hubspot_owner_id || '');
    if (!ownerId) return ok('ticket has no owner');

    // ── what kind of card ────────────────────────────────────────────────────
    const isMsg = event.startsWith('message.');
    let type = null;
    if (isMsg && inbound) type = 'replied';
    else if (!isMsg && inbound && String(d.status || '').toLowerCase() !== 'answered') type = 'missed';
    else type = 'worked';                      // outbound by whoever was on the line
    const actorId = String((d.user && (d.user.hubspot_owner_id || d.user.id)) || '');

    const created = p.createdate ? Date.parse(p.createdate) : 0;
    const day = created ? Math.max(1, Math.floor((Date.now() - created) / 86400000) + 1) : null;
    const name = [contact.properties && contact.properties.firstname,
                  contact.properties && contact.properties.lastname].filter(Boolean).join(' ').trim();
    const docId = ticket.id + '_' + type + '_' + (d.id || Date.now());

    // ── straight into the owner's queue ──────────────────────────────────────
    const F = {
      type: { stringValue: type }, state: { stringValue: 'open' },
      ticketId: { stringValue: String(ticket.id) }, contactId: { stringValue: String(contact.id) },
      name: { stringValue: name || '(no name)' },
      stage: { stringValue: String(p.hs_pipeline_stage || '') },
      kind: { stringValue: isMsg ? 'sms' : 'call' },
      body: { stringValue: String(d.body || d.content || '').slice(0, 240) },
      actorId: { stringValue: actorId },
      ts: { integerValue: String(Date.now()) },
      createdAt: { integerValue: String(Date.now()) },
      via: { stringValue: 'aircall' }
    };
    if (day !== null) F.day = { integerValue: String(day) };
    const url = 'https://firestore.googleapis.com/v1/projects/' + FB_PROJECT +
      '/databases/(default)/documents/my_alerts/' + encodeURIComponent(ownerId) +
      '/items/' + encodeURIComponent(docId) + '?key=' + FB_KEY;
    const w = await fetch(url, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: F })
    });
    if (!w.ok) return ok('firestore write failed: ' + w.status);
    return ok('card written', { type, ticketId: ticket.id, ownerId, docId, matchedBy });
  } catch (e) {
    return ok('error: ' + e.message);
  }
}
