/**
 * Unit-tests the cross-run dedupe: "Tag New vs Seen" and "Build Ledger".
 *
 * This ledger is deliberately SEPARATE from the Ad Library one. The two workflows key on
 * different identifiers (a Maps place URL vs a Facebook page URL) and are sold
 * separately, so a shared file would let one product's history corrupt the other's.
 *
 *   node dev/test-ledger.js
 */
const path = require('path');
const wf = require(path.resolve(__dirname, '..', 'workflow', 'maps-lead-engine.json'));

const tagCode = wf.nodes.find((n) => n.name === 'Tag New vs Seen').parameters.jsCode;
const buildCode = wf.nodes.find((n) => n.name === 'Build Ledger').parameters.jsCode;

const wrap = (arr) => arr.map((json) => ({ json }));

function tag({ settings, ledgerRecords, leads }) {
  const src = tagCode
    .replace("const s = $('Settings - Edit These').first().json;", 'const s = ARGS.settings;')
    .replace('for (const item of $input.all())', 'for (const item of ARGS.ledger)')
    .replace("const leads = $('Score + Rank').all().map(", 'const leads = ARGS.leads.map(');
  return new Function('ARGS', 'console', src)(
    { settings, ledger: ledgerRecords, leads: wrap(leads) }, { log: () => {} }
  ).map((i) => i.json);
}

function build({ ledgerRecords, scored }) {
  const src = buildCode
    .replace("for (const item of $('Ledger From JSON').all())", 'for (const item of ARGS.ledger)')
    .replace("for (const item of $('Score + Rank').all())", 'for (const item of ARGS.scored)');
  return new Function('ARGS', 'console', src)(
    { ledger: ledgerRecords, scored: wrap(scored) }, { log: () => {} }
  ).map((i) => i.json);
}

const today = new Date().toISOString().slice(0, 10);
const A = { mapsUrl: 'https://www.google.com/maps/place/A', name: 'A', city: 'Lahore', leadReason: 'no_website' };
const B = { mapsUrl: 'https://www.google.com/maps/place/B', name: 'B', city: 'Lahore', leadReason: 'dead_site' };

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log(' FAIL  ' + label + (detail ? ' — ' + detail : '')); }
};

// --- first ever run: the ledger file does not exist -------------------------------------
// Read Ledger is set to continue on error, so this node receives an empty/garbage item
// rather than nothing. Treating that as "no history" is what makes run #1 work.
for (const [label, input] of [
  ['no items at all', []],
  ['an empty item', wrap([{}])],
  ['an error item from the missing file', wrap([{ error: 'ENOENT: no such file' }])],
]) {
  const out = tag({ settings: { onlyNewLeads: true }, ledgerRecords: input, leads: [A, B] });
  check('first run with ' + label + ' -> everything is new', out.length === 2 && out.every((r) => r.isNew),
    JSON.stringify(out.map((r) => r.isNew)));
}

// --- Extract From File nests the array under .data --------------------------------------
const nested = tag({
  settings: { onlyNewLeads: true },
  ledgerRecords: wrap([{ data: [{ mapsUrl: A.mapsUrl, firstSeen: '2026-01-01', timesSeen: 3 }] }]),
  leads: [A, B],
});
check('unwraps the nested "data" shape', nested.length === 1 && nested[0].mapsUrl === B.mapsUrl,
  JSON.stringify(nested.map((r) => r.name)));

// --- the actual dedupe -------------------------------------------------------------------
const history = wrap([{ mapsUrl: A.mapsUrl, name: 'A', firstSeen: '2026-01-01', lastSeen: '2026-01-01', timesSeen: 3 }]);

const filtered = tag({ settings: { onlyNewLeads: true }, ledgerRecords: history, leads: [A, B] });
check('onlyNewLeads=true hides the business already seen',
  filtered.length === 1 && filtered[0].name === 'B', JSON.stringify(filtered.map((r) => r.name)));

const keptAll = tag({ settings: { onlyNewLeads: false }, ledgerRecords: history, leads: [A, B] });
check('onlyNewLeads=false keeps both', keptAll.length === 2);
check('  ...and marks which is which',
  keptAll[0].isNew === false && keptAll[1].isNew === true,
  JSON.stringify(keptAll.map((r) => r.isNew)));
check('preserves the original firstSeen date', keptAll[0].firstSeenOn === '2026-01-01', keptAll[0].firstSeenOn);
check('increments timesSeen', keptAll[0].timesSeen === 4, String(keptAll[0].timesSeen));
check('a brand-new lead gets today as firstSeen', keptAll[1].firstSeenOn === today, keptAll[1].firstSeenOn);
check('a brand-new lead starts at timesSeen 1', keptAll[1].timesSeen === 1, String(keptAll[1].timesSeen));

// The string "true" is what a Set node boolean becomes if the user retypes it as text.
const strTrue = tag({ settings: { onlyNewLeads: 'true' }, ledgerRecords: history, leads: [A, B] });
check('onlyNewLeads as the string "true" still filters', strTrue.length === 1, String(strTrue.length));

// --- rewriting the ledger ----------------------------------------------------------------
const written = build({ ledgerRecords: history, scored: [A, B] });
check('ledger keeps history and adds the new business', written.length === 2, String(written.length));

const recA = written.find((r) => r.mapsUrl === A.mapsUrl);
const recB = written.find((r) => r.mapsUrl === B.mapsUrl);
check('an existing record keeps its firstSeen', recA.firstSeen === '2026-01-01', recA.firstSeen);
check('  ...and gets a fresh lastSeen', recA.lastSeen === today, recA.lastSeen);
check('  ...and its counter goes up', recA.timesSeen === 4, String(recA.timesSeen));
check('a new record is written with today for both dates',
  recB.firstSeen === today && recB.lastSeen === today);
check('the ledger stores the city so a second city is distinguishable', recB.city === 'Lahore', recB.city);

// Everything qualified this run must be recorded, INCLUDING the ones filtered out of the
// CSV as already-seen — otherwise their lastSeen freezes and they resurface forever.
const filteredRun = build({ ledgerRecords: history, scored: [A] });
check('a business filtered out of the CSV still gets its lastSeen refreshed',
  filteredRun.find((r) => r.mapsUrl === A.mapsUrl).lastSeen === today);

// --- the ledger must stay keyed on the Maps place URL ------------------------------------
// A Facebook page URL from the other workflow has no mapsUrl, so it is ignored rather
// than silently treated as a Maps business.
const foreign = tag({
  settings: { onlyNewLeads: true },
  ledgerRecords: wrap([{ advertiserPageUrl: 'https://facebook.com/a', pageName: 'A' }]),
  leads: [A],
});
check('an Ad Library record does not mask a Maps business', foreign.length === 1 && foreign[0].isNew);

// --- the two workflows must not share a file ---------------------------------------------
const ledgerFile = wf.nodes.find((n) => n.name === 'Settings - Edit These')
  .parameters.assignments.assignments.find((a) => a.name === 'ledgerFile').value;
// The two engines key on different identifiers and are used independently, so sharing
// one ledger file would let one product's history corrupt the other's.
check('the ledger file is named for this engine, not the Ad Library one',
  /seen-places/i.test(ledgerFile) && !/Ad library|seen-leads/i.test(ledgerFile), ledgerFile);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
