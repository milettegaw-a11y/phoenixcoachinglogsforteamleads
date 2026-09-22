/**
 * Phoenix Coaching Log — simulator feed.
 *
 * Publishes the two results sheets as JSON for the coaching log to read. It
 * runs as you, inside your own Google account, so it needs no service-account
 * key and is unaffected by the organisation policy that blocks key creation.
 *
 * It returns only the columns the app actually uses. The sheets carry long
 * feedback and transcript text that would make the response tens of megabytes
 * and is never displayed, so those columns are left behind.
 *
 * SETUP
 *  1. script.google.com → New project → paste this file over Code.gs
 *  2. Change SECRET below to a long random string of your own
 *  3. Deploy → New deployment → type "Web app"
 *       Execute as:      Me
 *       Who has access:  Anyone
 *  4. Copy the /exec URL it gives you
 *  5. In Vercel add two environment variables, then redeploy:
 *       SIM_SCRIPT_URL   = that /exec URL
 *       SIM_SCRIPT_TOKEN = the SECRET below
 *
 * The URL is unguessable and the token is checked on every request, so the
 * data is not casually readable by anyone who stumbles across it.
 */

var SECRET = 'CHANGE-ME-to-a-long-random-string';

var SIM_SHEET_ID  = '16TM-ho19_z5u7HLRU8T_LRblbwOXHJkhsvmUFcA1iV8';
var LIVE_SHEET_ID = '1eQWeddD2MrFK0IIoFMtVap5_WcNP-5EVqFWcBUSO9-g';

var SKILLS = [
  'Rapport & Conversation Control',
  'Early Objection Handling',
  'Discovery',
  'Pain Point Identification',
  'FCF & Membership Recommendation & Explanation',
  'Features as Benefits',
  'Objection Handling',
  'Closing & Commitment'
];

// Columns kept from each sheet. Skills are appended below.
var SIM_KEEP  = ['Timestamp', 'Agent Name', 'LOB', 'Simulator Name', 'Overall Score', 'Result'];
var LIVE_KEEP = ['Call Date', 'Timestamp', 'Agent Name', 'LOB', 'Overall Score', 'Result'];

function doGet(e) {
  var token = (e && e.parameter && e.parameter.token) || '';
  if (token !== SECRET) {
    return json({ error: 'forbidden' });
  }
  try {
    var simCols  = SIM_KEEP.concat(SKILLS);
    // The live sheet prefixes each skill with "Score - " and calls FCF "Voucher".
    var liveCols = LIVE_KEEP.concat(SKILLS.map(function (s) {
      return 'Score - ' + s.replace('FCF & Membership', 'Voucher & Membership');
    }));
    return json({
      ok: true,
      generatedAt: new Date().toISOString(),
      simCols: simCols,
      liveCols: liveCols,
      sim:  extract(SIM_SHEET_ID,  simCols),
      live: extract(LIVE_SHEET_ID, liveCols)
    });
  } catch (err) {
    return json({ error: String(err) });
  }
}

/** Pull just the named columns, matched by header rather than position, so
 *  inserting or reordering a column in the sheet does not break the feed. */
function extract(id, wanted) {
  var sheet = SpreadsheetApp.openById(id).getSheets()[0];
  var values = sheet.getDataRange().getValues();
  if (!values.length) return [];

  var header = values[0].map(function (h) { return String(h).trim(); });
  var index = wanted.map(function (name) { return header.indexOf(name); });

  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var keep = [];
    var blank = true;
    for (var c = 0; c < index.length; c++) {
      var v = index[c] === -1 ? '' : row[index[c]];
      // Dates arrive as Date objects; send them as plain text the app can parse.
      if (v instanceof Date) v = Utilities.formatDate(v, 'UTC', 'yyyy-MM-dd HH:mm:ss');
      v = v === null || v === undefined ? '' : String(v);
      if (v !== '') blank = false;
      keep.push(v);
    }
    if (!blank) out.push(keep);
  }
  return out;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Optional: run once from the editor to confirm both sheets are readable
 *  before you deploy. Check View → Logs for the row counts. */
function testRead() {
  var simCols  = SIM_KEEP.concat(SKILLS);
  var liveCols = LIVE_KEEP.concat(SKILLS.map(function (s) {
    return 'Score - ' + s.replace('FCF & Membership', 'Voucher & Membership');
  }));
  Logger.log('simulator rows: ' + extract(SIM_SHEET_ID, simCols).length);
  Logger.log('live call rows: ' + extract(LIVE_SHEET_ID, liveCols).length);
}
