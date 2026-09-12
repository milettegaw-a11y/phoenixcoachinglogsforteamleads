/* /api/lead-brief — what happened on this lead, and what to try next.
 *
 * Reads the whole conversation HubSpot holds for one contact — every call and
 * every SMS, whoever made them, including the Apex history the agent never saw —
 * and returns a short brief: what has happened, the approach most likely to work,
 * and anything not to repeat.
 *
 * The point is that it can see what the agent cannot: what was already tried,
 * which arguments drew a response, and when this person actually picks up.
 *
 * POST { contactId, name?, stage?, day? } → { summary, approach, avoid, model }
 */
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const HS = process.env.HS_TOKEN;
  const AI = process.env.ANTHROPIC_API_KEY;
  if (!HS) return res.status(500).json({ error: 'HS_TOKEN not configured' });
  if (!AI) return res.status(503).json({
    error: 'Claude is not connected yet. Add an ANTHROPIC_API_KEY environment variable in Vercel and redeploy.',
    needsSetup: true
  });

  const b = req.body || {};
  const contactId = String(b.contactId || '');
  if (!contactId) return res.status(400).json({ error: 'No contactId.' });

  const h = { Authorization: 'Bearer ' + HS, 'Content-Type': 'application/json' };
  const search = async (object, body) => {
    const r = await fetch('https://api.hubapi.com/crm/v3/objects/' + object + '/search',
      { method: 'POST', headers: h, body: JSON.stringify(body) });
    const d = await r.json();
    return d.results || [];
  };

  try {
    // ── the whole conversation, whoever held it ─────────────────────────────
    const since = { propertyName: 'hs_timestamp', operator: 'GTE', value: String(Date.now() - 60 * 86400000) };
    const isContact = { propertyName: 'associations.contact', operator: 'IN', values: [contactId] };
    const [calls, sms, owners] = await Promise.all([
      search('calls', { filterGroups: [{ filters: [since, isContact] }], limit: 60,
        properties: ['hs_timestamp','hs_call_status','hs_call_direction','hs_call_duration','hubspot_owner_id','hs_call_body'],
        sorts: [{ propertyName: 'hs_timestamp', direction: 'ASCENDING' }] }),
      search('communications', { filterGroups: [{ filters: [since, isContact,
        { propertyName: 'hs_communication_channel_type', operator: 'EQ', value: 'SMS' }] }], limit: 80,
        properties: ['hs_timestamp','hubspot_owner_id','hs_communication_body'],
        sorts: [{ propertyName: 'hs_timestamp', direction: 'ASCENDING' }] }),
      fetch('https://api.hubapi.com/crm/v3/owners?limit=500', { headers: h })
        .then(r => r.json()).catch(() => ({ results: [] }))
    ]);
    const ownerName = {};
    for (const o of (owners.results || [])) ownerName[String(o.id)] = [o.firstName, o.lastName].filter(Boolean).join(' ');

    const clean = t => String(t || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
    const when = ts => { const d = new Date(ts); return isNaN(d) ? '?' :
      d.toISOString().slice(0, 16).replace('T', ' ') + 'Z'; };

    const lines = [];
    for (const c of calls) {
      const p = c.properties || {};
      const dir = String(p.hs_call_direction || '').toUpperCase() === 'INBOUND' ? 'lead called in' : 'agent called';
      const st = String(p.hs_call_status || '').toUpperCase();
      const secs = Math.round(Number(p.hs_call_duration || 0) / 1000);
      lines.push({ t: Date.parse(p.hs_timestamp || 0), s:
        `[${when(p.hs_timestamp)}] CALL — ${dir}, ${st === 'COMPLETED' ? 'connected ' + secs + 's' : st.toLowerCase() || 'no answer'}` +
        (ownerName[String(p.hubspot_owner_id)] ? ' (' + ownerName[String(p.hubspot_owner_id)] + ')' : '') +
        (clean(p.hs_call_body) ? ' — notes: ' + clean(p.hs_call_body).slice(0, 300) : '') });
    }
    for (const m of sms) {
      const p = m.properties || {};
      const raw = clean(p.hs_communication_body);
      const out = /^\s*(?:SMS|MMS)\s+Sent\s+by\b/i.test(raw);
      const text = (raw.match(/Message:\s*([\s\S]*)$/i) || [, raw])[1]
        .replace(/\s*\(See the full conversation\)\s*$/i, '').replace(/\s*Status:\s*[^\n]*$/i, '').trim();
      lines.push({ t: Date.parse(p.hs_timestamp || 0), s:
        `[${when(p.hs_timestamp)}] SMS ${out ? '→ sent' : '← from lead'}` +
        (out && ownerName[String(p.hubspot_owner_id)] ? ' (' + ownerName[String(p.hubspot_owner_id)] + ')' : '') +
        ': ' + text.slice(0, 300) });
    }
    lines.sort((a, b2) => a.t - b2.t);
    if (!lines.length) return res.status(200).json({
      summary: 'No calls or messages recorded on this lead in the last 60 days.',
      approach: 'Nothing has been tried yet — open with a first-touch message.', avoid: '', empty: true
    });

    const transcript = lines.map(l => l.s).join('\n').slice(0, 24000);
    const client = new Anthropic({ apiKey: AI });
    const system =
`You brief a Homeaglow inside-sales agent on a cleaning-services lead before they call.
The agent has NOT seen most of this history — much of it is another team's work.

Write exactly three sections, each on its own line, with these labels and nothing else:

WHAT HAPPENED: 2-4 sentences. What was tried, what the lead actually said, where it stalled. Concrete, no filler.
BEST APPROACH: 2-3 sentences. The angle most likely to work THIS time, and the best hour to call based on when this person has actually responded. Say why.
AVOID: one sentence, or the single word NONE. Anything already declined or that would irritate them.

Ground every claim in the log. If the log does not support a claim, leave it out. Never invent prices, offers, or promises.`;

    const msg = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 1200,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system,
      messages: [{ role: 'user', content:
        `Lead: ${b.name || '(no name)'}${b.stage ? ' · stage: ' + b.stage : ''}${b.day ? ' · day ' + b.day + ' of the cadence' : ''}\n\n` +
        `Conversation log, oldest first:\n${transcript}` }]
    });

    if (msg.stop_reason === 'refusal') return res.status(200).json({
      error: 'Claude declined to summarise this conversation.', refused: true
    });

    let text = '';
    for (const block of msg.content) if (block.type === 'text') text += block.text;
    const grab = (label, next) => {
      const re = new RegExp(label + ':\\s*([\\s\\S]*?)(?=' + (next ? next + ':' : '$') + ')', 'i');
      const m2 = text.match(re);
      return m2 ? m2[1].trim() : '';
    };
    const avoid = grab('AVOID');
    return res.status(200).json({
      summary: grab('WHAT HAPPENED', 'BEST APPROACH'),
      approach: grab('BEST APPROACH', 'AVOID'),
      avoid: /^none\.?$/i.test(avoid) ? '' : avoid,
      touches: lines.length, model: msg.model,
      raw: text.length < 40 ? text : undefined
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
