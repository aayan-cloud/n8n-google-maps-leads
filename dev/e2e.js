/**
 * End-to-end run of the REAL workflow outside n8n.
 *
 * Every step below executes the exact Code-node source from workflow/maps-lead-engine.json
 * and the exact browser scripts, against live Google Maps and live websites. The only
 * things stubbed are n8n's own plumbing ($input, $('Node'), the HTTP nodes, file writes).
 *
 * The point is to prove the pipeline end to end without clicking through the n8n UI, and
 * to be able to re-run it after any change.
 *
 *   node dev/e2e.js                       # defaults below
 *   node dev/e2e.js "dentist" "Leeds" GB  # niche, city, countryCode
 */
const path = require('path');
const fs = require('fs');

const wf = require(path.resolve(__dirname, '..', 'workflow', 'maps-lead-engine.json'));
const codeOf = (name) => wf.nodes.find((n) => n.name === name).parameters.jsCode;
const wrap = (arr) => arr.map((json) => ({ json }));
const unwrap = (arr) => arr.map((i) => i.json);

const SETTINGS = Object.assign({}, wf.nodes.find((n) => n.name === 'Settings - Edit These')
  .parameters.assignments.assignments
  .reduce((acc, a) => { acc[a.name] = a.value; return acc; }, {}), {
    niche: process.argv[2] || 'interior designer',
    city: process.argv[3] || 'Lahore',
    countryCode: process.argv[4] || 'PK',
    maxPlacesToCheck: Number(process.env.MAX_PLACES || 10),
  });

const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(4) + 's ';
const log = (...a) => console.log(stamp() + a.join(' '));

async function post(endpoint, payload, label) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(label + ' HTTP ' + res.status + ': ' + text.slice(0, 300));
  return JSON.parse(text);
}

(async () => {
  console.log('e2e: "' + SETTINGS.niche + '" in ' + SETTINGS.city +
    '  (max ' + SETTINGS.maxPlacesToCheck + ' place pages)\n');

  // --- Preflight - Browserless -------------------------------------------------------
  const pf = await fetch(String(SETTINGS.browserlessUrl).replace(/\/$/, '') +
    '/json/version?token=' + SETTINGS.browserlessToken).then((r) => r.json()).catch((e) => ({ error: e }));
  log('preflight:', pf.Browser || 'FAILED');

  // --- Build Search Job --------------------------------------------------------------
  const jobs = unwrap(new Function('ARGS', 'console', codeOf('Build Search Job')
    .replace("const s = $('Settings - Edit These').first().json;", 'const s = ARGS.settings;')
    .replace('const preflight = $input.first().json || {};', 'const preflight = ARGS.preflight;'))(
    { settings: SETTINGS, preflight: pf }, { log: () => {} }));
  log('queries:', jobs.map((j) => '"' + j.query + '"').join(', '));

  // --- Browserless - Search Maps (one call per query, as the workflow does) -----------
  const searchResponses = [];
  for (const job of jobs) {
    const r = await post(job.endpoint, job.payload, 'search');
    const b = r.data || {};
    log('  scraped "' + job.query + '":', (b.businesses || []).length, 'businesses',
      b.notes && b.notes.length ? '| ' + b.notes.join('; ') : '');
    searchResponses.push(r);
  }

  // --- Filter No-Website --------------------------------------------------------------
  const candidates = unwrap(new Function('ARGS', 'console', codeOf('Filter No-Website')
    .replace("const s = $('Settings - Edit These').first().json;", 'const s = ARGS.settings;')
    .replace("for (const job of $('Build Search Job').all())", 'for (const job of ARGS.jobs)')
    .replace('for (const item of $input.all())', 'for (const item of ARGS.responses)'))(
    { settings: SETTINGS, jobs: wrap(jobs), responses: wrap(searchResponses) },
    { log: (m) => log('  ' + m) }));
  log('candidates for stage 2:', candidates.length);

  // --- Loop Places -> Build Detail Job -> Place Details -> Parse -----------------------
  const BATCH = wf.nodes.find((n) => n.name === 'Loop Places').parameters.batchSize;
  const parsed = [];
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const job = unwrap(new Function('ARGS', codeOf('Build Detail Job')
      .replace("const s = $('Settings - Edit These').first().json;", 'const s = ARGS.settings;')
      .replace('const places = $input.all().map(', 'const places = ARGS.batch.map('))(
      { settings: SETTINGS, batch: wrap(batch) }))[0];

    log('  opening place pages ' + (i + 1) + '-' + (i + batch.length) + ' of ' + candidates.length + '...');
    const resp = await post(job.endpoint, job.payload, 'details');

    parsed.push(...unwrap(new Function('ARGS', codeOf('Parse Place Details')
      .replace('const resp = $input.first().json || {};', 'const resp = ARGS.resp;')
      .replace("for (const item of $('Filter No-Website').all())", 'for (const item of ARGS.list)'))(
      { resp: resp, list: wrap(candidates) })));
  }
  log('place pages read:', parsed.length);

  // --- Confirm + Qualify ---------------------------------------------------------------
  const qualified = unwrap(new Function('URL', 'ARGS', 'console', codeOf('Confirm + Qualify')
    .replace("const s = $('Settings - Edit These').first().json;", 'const s = ARGS.settings;')
    .replace('const rows = $input.all().filter(', 'const rows = ARGS.places.filter('))(
    undefined, { settings: SETTINGS, places: wrap(parsed) }, { log: (m) => log('  ' + m) }));

  // --- Needs Liveness Check? -> Check Site Alive -> Classify Site Health ----------------
  const needCheck = qualified.filter((j) => j.needsLivenessCheck);
  const skipCheck = qualified.filter((j) => !j.needsLivenessCheck);
  log('liveness checks needed:', needCheck.length);

  const checked = [];
  for (const lead of needCheck) {
    let shaped;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      const res = await fetch(lead.websiteRaw, { redirect: 'follow', signal: ctrl.signal });
      clearTimeout(timer);
      const body = await res.text().catch(() => '');
      shaped = Object.assign({}, lead, {
        __statusCode: res.status, __finalUrl: res.url, __body: body.slice(0, 6000), __error: '',
      });
    } catch (e) {
      shaped = Object.assign({}, lead, {
        __statusCode: 0, __finalUrl: '', __body: '', __error: String(e.message || e),
      });
    }
    const r = unwrap(new Function('URL', 'ARGS', codeOf('Classify Site Health')
      .replace('return $input.all().map(', 'return ARGS.map('))(undefined, wrap([shaped])))[0];
    log('  ' + lead.websiteRaw + ' -> ' + r.siteCheck + ' (' + r.leadReason + ')');
    checked.push(r);
  }

  // --- Merge Lead Streams -> Score + Rank ----------------------------------------------
  const scored = unwrap(new Function('ARGS', 'console', codeOf('Score + Rank')
    .replace('const rows = $input.all()', 'const rows = ARGS'))(
    wrap(checked.concat(skipCheck)), { log: () => {} }));
  log('scored leads:', scored.length);

  // --- Read Ledger -> Tag New vs Seen ---------------------------------------------------
  let ledgerRecords = [];
  try { ledgerRecords = JSON.parse(fs.readFileSync(SETTINGS.ledgerFile, 'utf8')); }
  catch (e) { log('  ledger: none yet (' + String(e.code || e.message) + ')'); }

  const tagged = unwrap(new Function('ARGS', 'console', codeOf('Tag New vs Seen')
    .replace("const s = $('Settings - Edit These').first().json;", 'const s = ARGS.settings;')
    .replace('for (const item of $input.all())', 'for (const item of ARGS.ledger)')
    .replace("const leads = $('Score + Rank').all().map(", 'const leads = ARGS.leads.map('))(
    { settings: SETTINGS, ledger: wrap(ledgerRecords), leads: wrap(scored) }, { log: (m) => log('  ' + m) }));

  // --- Sort by Score -> Build Outreach -> Shape Rows ------------------------------------
  const sorted = tagged.slice().sort((a, b) => b.score - a.score);

  const outreach = unwrap(new Function('ARGS', codeOf('Build Outreach')
    .replace("const s = $('Settings - Edit These').first().json;", 'const s = ARGS.settings;')
    .replace('return $input.all().map(', 'return ARGS.leads.map('))(
    { settings: SETTINGS, leads: wrap(sorted) }));

  const rows = unwrap(new Function('ARGS', codeOf('Shape Rows')
    .replace('return $input.all().map(', 'return ARGS.map('))(wrap(outreach)));

  // --- To CSV -> Save Leads CSV ----------------------------------------------------------
  const headers = Object.keys(rows[0] || { score: '' });
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [headers.join(',')].concat(rows.map((r) => headers.map((h) => esc(r[h])).join(','))).join('\n');

  fs.mkdirSync(SETTINGS.outputFolder, { recursive: true });
  const csvPath = path.join(SETTINGS.outputFolder,
    'maps-leads-' + (jobs[0] ? jobs[0].cityLabel : 'run') + '-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '') + '.csv');
  fs.writeFileSync(csvPath, csv, 'utf8');

  // --- Build Ledger -> Save Ledger --------------------------------------------------------
  const ledgerOut = unwrap(new Function('ARGS', 'console', codeOf('Build Ledger')
    .replace("for (const item of $('Ledger From JSON').all())", 'for (const item of ARGS.ledger)')
    .replace("for (const item of $('Score + Rank').all())", 'for (const item of ARGS.scored)'))(
    { ledger: wrap(ledgerRecords), scored: wrap(scored) }, { log: (m) => log('  ' + m) }));
  fs.writeFileSync(SETTINGS.ledgerFile, JSON.stringify(ledgerOut, null, 2), 'utf8');

  // --- report -------------------------------------------------------------------------------
  console.log('\n' + rows.length + ' leads -> ' + csvPath + '\n');
  for (const r of rows.slice(0, 15)) {
    console.log('  ' + String(r.score).padStart(3) + '  ' +
      String(r.name).slice(0, 38).padEnd(40) +
      String(r.rating || '-').padEnd(4) +
      (String(r.reviewCount) + ' rev').padEnd(10) +
      String(r.city).padEnd(11) +
      String(r.leadReason).padEnd(17) +
      (r.waLink || r.phone || 'no phone'));
  }
  console.log('\n' + stamp() + 'done');
})().catch((e) => { console.error('\nFAILED: ' + (e && e.stack ? e.stack : e)); process.exit(1); });
