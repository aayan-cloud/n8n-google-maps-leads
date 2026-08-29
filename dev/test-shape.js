/**
 * Unit-tests "Parse Place Details" and "Shape Rows" — the two nodes that decide what
 * actually lands in the CSV.
 *
 * Parse Place Details re-joins the place page read to the list row it came from. The
 * place page is authoritative for anything it returns, but it does not always return
 * everything, so the list row has to fill the gaps without overwriting real answers.
 *
 *   node dev/test-shape.js
 */
const path = require('path');
const wf = require(path.resolve(__dirname, '..', 'workflow', 'maps-lead-engine.json'));

const parseCode = wf.nodes.find((n) => n.name === 'Parse Place Details').parameters.jsCode;
const rowsCode = wf.nodes.find((n) => n.name === 'Shape Rows').parameters.jsCode;

function parse(results, listRows) {
  const src = parseCode
    .replace('const resp = $input.first().json || {};', 'const resp = ARGS.resp;')
    .replace("for (const item of $('Filter No-Website').all())", 'for (const item of ARGS.list)');
  return new Function('ARGS', src)({
    resp: { data: { results } },
    list: listRows.map((json) => ({ json })),
  }).map((i) => i.json);
}

function rows(leads) {
  const src = rowsCode.replace('return $input.all().map(', 'return ARGS.map(');
  return new Function('ARGS', src)(leads.map((json) => ({ json }))).map((i) => i.json);
}

const URL_A = 'https://www.google.com/maps/place/A';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log(' FAIL  ' + label + (detail ? ' — ' + detail : '')); }
};

// --- the place page wins where it has an answer -------------------------------------------
const listRow = {
  mapsUrl: URL_A, name: 'Chiltan', query: 'interior designer Lahore', sponsored: true,
  rating: 4.5, category: 'Interior designer', address: '59-U New', phone: '',
};
const merged = parse([{
  mapsUrl: URL_A, title: 'Chiltan Architects and Designers', rating: 4.8, reviewCount: 106,
  website: '', hasWebsite: false, phone: '042 111 2222',
  address: '59-U New Muslim Town, Lahore', category: 'Interior designer', error: '',
}], [listRow])[0];

check('the place page title replaces the truncated card name',
  merged.name === 'Chiltan Architects and Designers', merged.name);
check('the full address replaces the card fragment',
  merged.address === '59-U New Muslim Town, Lahore', merged.address);
check('the place-page rating wins', merged.rating === 4.8, String(merged.rating));
check('the review count comes from the place page (the list has none)',
  merged.reviewCount === 106, String(merged.reviewCount));
check('a phone missing from the card is recovered', merged.phone === '042 111 2222', merged.phone);

// Sponsored is a list-view-only signal — the place page has no concept of it, so it must
// survive the join or every Google-Ads spender loses that score.
check('the sponsored flag survives from the list row', merged.sponsored === true);
check('the query that found the business is kept', merged.query === 'interior designer Lahore');

// --- the list row fills gaps, but never overwrites a real answer ---------------------------
const gappy = parse([{
  mapsUrl: URL_A, title: '', rating: null, reviewCount: 0, website: '', hasWebsite: false,
  phone: '', address: '', category: '', error: '',
}], [listRow])[0];
check('an empty place-page title falls back to the card name', gappy.name === 'Chiltan', gappy.name);
check('an empty category falls back to the card', gappy.category === 'Interior designer', gappy.category);
check('a null place-page rating falls back to the card', gappy.rating === 4.5, String(gappy.rating));

// A genuine 0 rating is data, not a gap. Falling back here would invent a rating.
const zeroRating = parse([{ mapsUrl: URL_A, rating: 0, reviewCount: 0, hasWebsite: false }], [listRow])[0];
check('a real 0 rating is not overwritten by the card', zeroRating.rating === 0, String(zeroRating.rating));

// --- unmatched and broken results ---------------------------------------------------------
const unmatched = parse([{ mapsUrl: 'https://www.google.com/maps/place/Z', title: 'Z', hasWebsite: false }], [listRow])[0];
check('a result with no matching list row still comes through', unmatched.name === 'Z', unmatched.name);
check('  ...without inventing a sponsored flag', unmatched.sponsored === false);

const broken = parse([{ mapsUrl: URL_A, error: 'Navigation timeout' }], [listRow])[0];
check('the place-page error is carried forward for the qualifier',
  broken.detailError === 'Navigation timeout', broken.detailError);

// --- Shape Rows ---------------------------------------------------------------------------
const row = rows([{
  score: 61, name: 'Chiltan', leadReason: 'no_website', category: 'Interior designer',
  city: 'Lahore', address: '59-U New Muslim Town', rating: 4.8, reviewCount: 106,
  sponsored: true, phone: '042 111 2222', waLink: 'https://wa.me/924211122222',
  websiteRaw: '', siteCheck: 'no_site_listed', mapsUrl: URL_A,
  query: 'interior designer Lahore', outreachStatus: 'READY_CALL',
}])[0];

const EXPECTED = ['score', 'name', 'leadReason', 'category', 'city', 'address', 'rating',
  'reviewCount', 'sponsored', 'phone', 'phoneType', 'waLink', 'websiteFound', 'siteCheck', 'mapsUrl',
  'query', 'outreachStatus', 'lastContacted'];
check('the CSV columns are exactly the agreed set, in order',
  Object.keys(row).join(',') === EXPECTED.join(','), Object.keys(row).join(','));
check('sponsored renders as YES rather than true', row.sponsored === 'YES', String(row.sponsored));
check('not-sponsored renders blank, not "false"',
  rows([{ sponsored: false }])[0].sponsored === '', JSON.stringify(rows([{ sponsored: false }])[0].sponsored));
check('lastContacted ships empty for the user to fill in', row.lastContacted === '');

// An unrated business must produce an empty cell, not the string "null" or a 0 that reads
// as a one-star review.
const unrated = rows([{ rating: null, reviewCount: 0 }])[0];
check('a missing rating is an empty cell, not "null"', unrated.rating === '', JSON.stringify(unrated.rating));
check('a missing review count is 0', unrated.reviewCount === 0, JSON.stringify(unrated.reviewCount));

// Every column must exist on every row, or the CSV writer drops headers on sparse rows.
const sparse = rows([{ name: 'X' }])[0];
check('a sparse lead still fills every column',
  EXPECTED.every((k) => k in sparse), EXPECTED.filter((k) => !(k in sparse)).join(','));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
