/**
 * Unit-tests the spreadsheet-safety pass in "Shape Rows".
 *
 * Excel and Google Sheets treat a cell whose first character is = + - or @ as a formula.
 * Google Maps returns phone numbers as "+44 161 300 1627", so every phone column arrived
 * as #ERROR! in both tools. Quoting the CSV does not help - the spreadsheet parses the
 * value after the CSV has been read.
 *
 *   node dev/test-sheetsafe.js
 */
const path = require('path');
const wf = require(path.resolve(__dirname, '..', 'workflow', 'maps-lead-engine.json'));
const code = wf.nodes.find((n) => n.name === 'Shape Rows').parameters.jsCode;

const rows = (leads) => new Function('ARGS', code.replace('return $input.all().map(', 'return ARGS.map('))(
  leads.map((json) => ({ json }))).map((i) => i.json);
const one = (over) => rows([over])[0];

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log(' FAIL  ' + label + (detail ? ' — ' + detail : '')); }
};

// --- the reported bug --------------------------------------------------------------------
const PHONES = [
  ['+44 161 300 1627', '44 161 300 1627'],
  ['+44 7718 538734', '44 7718 538734'],
  ['+1 602-717-5730', '1 602-717-5730'],
  ['+353 85 133 8383', '353 85 133 8383'],
  ['  +92 300 1237862  ', '92 300 1237862'],
];
for (const [input, expected] of PHONES) {
  const r = one({ phone: input });
  check('"' + input.trim() + '" -> "' + expected + '"', r.phone === expected, '"' + r.phone + '"');
  check('  ...no longer starts with a formula character', '=+-@'.indexOf(String(r.phone).charAt(0)) === -1);
}

// A number that never had a plus must not be altered - leading zeros especially, since
// they carry the trunk code.
check('a local number is left exactly as it was',
  one({ phone: '0161 300 1627' }).phone === '0161 300 1627', one({ phone: '0161 300 1627' }).phone);
check('no phone stays empty', one({ phone: '' }).phone === '', JSON.stringify(one({ phone: '' }).phone));
check('a missing phone field stays empty', one({}).phone === '', JSON.stringify(one({}).phone));

// --- the same trap in every other text column ---------------------------------------------
// Real businesses are named things like "+39 Cafe" and "@Home Interiors".
const NASTY = [
  ['+39 Cafe', 'name'],
  ['@Home Interiors', 'name'],
  ['=Quality Grooming', 'name'],
  ['-Studio Nine', 'name'],
];
for (const [value, field] of NASTY) {
  const r = one({ [field]: value });
  check('"' + value + '" is defused', '=+-@'.indexOf(String(r[field]).charAt(0)) === -1, '"' + r[field] + '"');
  check('  ...without losing any of the text', String(r[field]).trim() === value);
}

// Ordinary text must pass through untouched, or every cell picks up a stray space.
for (const [field, value] of [['name', 'Mucky Pups'], ['city', 'Leeds'],
  ['category', 'Pet groomer'], ['address', '12 High Street'], ['siteCheck', 'no_site_listed'],
  ['outreachStatus', 'READY_CALL'], ['mapsUrl', 'https://maps.google.com/x']]) {
  const r = one({ [field]: value });
  check(field + ' is untouched', r[field] === value, '"' + r[field] + '"');
}

// --- numbers must stay numbers ------------------------------------------------------------
// Wrapping these as text would stop the sheet sorting by score, which is the whole point
// of the column.
const numeric = one({ score: 48, reviewCount: 167, rating: 4.9 });
check('score stays a number', typeof numeric.score === 'number', typeof numeric.score);
check('reviewCount stays a number', typeof numeric.reviewCount === 'number', typeof numeric.reviewCount);
check('rating stays a number', typeof numeric.rating === 'number', typeof numeric.rating);
check('a missing rating is still an empty cell', one({ rating: null }).rating === '');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
