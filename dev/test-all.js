/**
 * Runs every test suite against the CURRENT generated workflow.
 *
 *   node dev/build-workflow.js && node dev/test-all.js
 *
 * These test the pure logic inside the Code nodes, so they need neither n8n nor
 * Browserless running.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const SUITES = [
  ['workflow wiring', 'test-wiring.js'],
  ['search job / no-website filter', 'test-search.js'],
  ['place detail merge + CSV rows', 'test-shape.js'],
  ['lead qualification', 'test-qualify.js'],
  ['site health classifier', 'test-sitehealth.js'],
  ['lead scoring', 'test-scoring.js'],
  ['phone / wa.me links', 'test-phone.js'],
  ['cross-run dedupe ledger', 'test-ledger.js'],
  ['spreadsheet-safe cells', 'test-sheetsafe.js'],
  ['placeholder root vs profile', 'test-placeholder-url.js'],
];

let failed = 0;
for (const [label, file] of SUITES) {
  process.stdout.write(label.padEnd(34));
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8' });
    const m = out.match(/(\d+) passed, (\d+) failed/);
    console.log('PASS' + (m ? '  (' + m[1] + ' assertions)' : ''));
  } catch (e) {
    failed++;
    console.log('FAIL');
    console.log((e.stdout || e.message || '').split('\n').filter(Boolean).slice(-12).map((l) => '    ' + l).join('\n'));
  }
}

console.log('\n' + (failed ? failed + ' suite(s) FAILED' : 'all suites passed'));
process.exit(failed ? 1 : 0);
