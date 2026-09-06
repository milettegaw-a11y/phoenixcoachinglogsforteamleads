export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });

  const HS_TOKEN = process.env.HS_TOKEN;
  if (!HS_TOKEN) return res.status(500).json({ error: 'HS_TOKEN not configured' });

  const { ticketId, stageId } = req.body || {};
  if (!ticketId || !stageId) return res.status(400).json({ error: 'ticketId and stageId required' });

  try {
    const resp = await fetch(`https://api.hubapi.com/crm/v3/objects/tickets/${ticketId}`, {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + HS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { hs_pipeline_stage: stageId } })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      return res.status(resp.status).json(err);
    }
    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
