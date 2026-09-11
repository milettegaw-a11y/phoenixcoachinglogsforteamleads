/* Slack nudge — tells one agent, in a DM, which of their leads have gone quiet.
 *
 * Needs a Slack bot token in the SLACK_BOT_TOKEN environment variable, with the
 * chat:write scope, plus users:read.email if you want the app to find people by
 * their work email instead of storing Slack member IDs.
 *
 * POST body:
 *   agent     "Shimonni Pigaredo"      — who the nudge is about, used in the text
 *   slackId   "U01ABCDEF"              — the Slack member ID to DM (optional)
 *   email     "name@homeaglowsales.com"— looked up when slackId is missing
 *   leads     [{id,name,quiet,day,stage,left}]
 *   wk        558
 *   from      "Jhay Oglimen"           — who is sending it
 *   dry       true                     — render the message and return it, send nothing
 *
 * `dry` exists so the app can show the sender exactly what will land before it
 * does, and so this route can be tested without messaging a real person.
 */
const PORTAL = '45809585';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const b = req.body || {};
  const leads = Array.isArray(b.leads) ? b.leads.slice(0, 25) : [];
  const agent = String(b.agent || '').trim();
  const from  = String(b.from || '').trim();
  const wk    = String(b.wk || '');
  if (!agent)        return res.status(400).json({ error: 'No agent named.' });
  if (!leads.length) return res.status(400).json({ error: 'No leads to nudge about.' });

  // ── the message ───────────────────────────────────────────────────────────
  // The agent is @-mentioned by Slack user ID so the DM pings them, and every
  // ticket carries its full HubSpot URL on its own line rather than hiding the
  // link behind the lead's name.
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const quietOf = l => {
    const h = Number(l.quiet);
    if (!isFinite(h)) return 'no activity logged';
    return h < 48 ? Math.round(h) + 'h quiet' : Math.round(h / 24) + 'd quiet';
  };
  const ticketUrl = l => 'https://app.hubspot.com/contacts/' + PORTAL + '/ticket/' + encodeURIComponent(l.id);
  const block = (l, i) => {
    const bits = [quietOf(l)];
    if (l.day)   bits.push('day ' + l.day);
    if (l.stage) bits.push(esc(l.stage));
    if (l.left)  bits.push(esc(l.left));
    return '*' + (i + 1) + '. ' + esc(l.name || 'Lead ' + l.id) + '*  —  ' + bits.join(' · ') +
           '\n' + ticketUrl(l);
  };
  // `mention` is the Slack <@Uxxxx> form once the user is resolved; the dry
  // preview has no ID yet, so it shows the agent's name instead.
  const compose = mention =>
    '*Kindly work on this ticket* ' + mention + '\n\n' +
    (leads.length === 1
      ? '1 of your leads has gone quiet'
      : leads.length + ' of your leads have gone quiet') + (wk ? '  ·  WK' + wk : '') +
    ' — still open, still inside the 7-day window that counts toward CVR. Ranked by time since the last logged activity.\n\n' +
    leads.map(block).join('\n\n') +
    '\n\n_Sent by ' + (esc(from) || 'a team lead') + ' from the Phoenix Coaching Log._';
  const fallback = 'Kindly work on this ticket — ' + leads.length +
    ' lead' + (leads.length > 1 ? 's have' : ' has') + ' gone quiet' + (wk ? ' (WK' + wk + ')' : '');

  if (b.dry) return res.status(200).json({ dry: true, text: compose('@' + agent), leads: leads.length });

  const TOKEN = process.env.SLACK_BOT_TOKEN;
  if (!TOKEN) return res.status(503).json({
    error: 'Slack is not connected yet. Add a SLACK_BOT_TOKEN environment variable in Vercel (scopes: chat:write, users:read.email) and redeploy.',
    needsSetup: true
  });

  const slackJson = async (method, payload) => {
    const r = await fetch('https://slack.com/api/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(payload)
    });
    return r.json();
  };
  // users.lookupByEmail is one of the older Web API methods and rejects a JSON
  // body with invalid_arguments — it only reads form-encoded parameters.
  const slackForm = async (method, params) => {
    const r = await fetch('https://slack.com/api/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
                 Authorization: 'Bearer ' + TOKEN },
      body: new URLSearchParams(params).toString()
    });
    return r.json();
  };

  try {
    let channel = String(b.slackId || '').trim();
    if (!channel) {
      const email = String(b.email || '').trim();
      if (!email) return res.status(400).json({
        error: 'No Slack member ID or email for ' + agent + '. Add one in the nudge dialog.',
        needsSetup: true
      });
      const look = await slackForm('users.lookupByEmail', { email });
      if (!look.ok || !look.user) return res.status(404).json({
        error: 'Slack could not find anyone at ' + email + (look.error ? ' (' + look.error + ')' : ''),
        needsSetup: true
      });
      channel = look.user.id;
    }
    const post = await slackJson('chat.postMessage', {
      channel, text: fallback, unfurl_links: false, unfurl_media: false,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: compose('<@' + channel + '>') } }]
    });
    if (!post.ok) return res.status(502).json({ error: 'Slack refused the message: ' + (post.error || 'unknown') });
    return res.status(200).json({ ok: true, channel, ts: post.ts, leads: leads.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
