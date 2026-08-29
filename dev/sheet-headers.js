/**
 * Prints the header row for the Google Sheet, straight from the generated workflow.
 *
 * The Sheets node maps by header NAME, so a sheet whose headers drift from the workflow
 * silently writes blank columns. Re-run this after changing "Shape Rows" rather than
 * editing the header list by hand:
 *
 *     node dev/sheet-headers.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WF = path.join(ROOT, 'workflow', 'maps-lead-engine.json');
const wf = require(WF);

const code = wf.nodes.find((n) => n.name === 'Shape Rows').parameters.jsCode;
// Running the node with one empty lead gives the real key order, which IS the column order.
const columns = Object.keys(
  new Function('ARGS', code.replace('return $input.all().map(', 'return ARGS.map('))([{ json: {} }])[0].json
);

const out = [
  'Header row for: Google Maps -> No-Website Leads',
  'Generated from workflow/maps-lead-engine.json - regenerate with: node dev/sheet-headers.js',
  '',
  'Paste the TAB-SEPARATED line below into cell A1 of an empty sheet.',
  'It spreads across the columns on its own. (Comma-separated would land in one cell.)',
  'Spelling and order must match exactly - the Google Sheets node maps by header name.',
  '',
  columns.join('\t'),
  '',
].join('\n');

fs.writeFileSync(path.join(ROOT, 'dev', 'sheet-headers.txt'), out, 'utf8');
console.log(columns.length + ' columns\n');
console.log(columns.join('\t'));
