/**
 * Unit-tests "Build Search Job" and "Filter No-Website".
 *
 * Build Search Job is where a first-time user's mistakes surface, so most of these
 * assertions are about the error message they see rather than the happy path.
 *
 *   node dev/test-search.js
 */
const path = require('path');
const wf = require(path.resolve(__dirname, '..', 'workflow', 'maps-lead-engine.json'));

const buildCode = wf.nodes.find((n) => n.name === 'Build Search Job').parameters.jsCode;
const filterCode = wf.nodes.find((n) => n.name === 'Filter No-Website').parameters.jsCode;

const SETTINGS = { niche: 'interior designer', city: 'Lahore', countryCode: 'PK', maxPerQuery: 60,
  maxPlacesToCheck: 40, browserlessUrl: 'http://localhost:3004',
  browserlessToken: 'changeme-local-token', waitMs: 2000, lang: 'en' };

function buildJob(settings, preflight) {
  const src = buildCode
    .replace("const s = $('Settings - Edit These').first().json;", 'const s = ARGS.settings;')
    .replace('const preflight = $input.first().json || {};', 'const preflight = ARGS.preflight;');
  return new Function('ARGS', 'console', src)(
    { settings: Object.assign({}, SETTINGS, settings), preflight: preflight || { Browser: 'Chrome/151' } },
    { log: () => {} }
  ).map((i) => i.json);
}

function filter(settings, responses, jobs) {
  const src = filterCode
    .replace("const s = $('Settings - Edit These').first().json;", 'const s = ARGS.settings;')
    .replace("for (const job of $('Build Search Job').all())", 'for (const job of ARGS.jobs)')
    .replace('for (const item of $input.all())', 'for (const item of ARGS.responses)');
  return new Function('ARGS', 'console', src)(
    {
      settings: Object.assign({}, SETTINGS, settings),
      responses: responses.map((json) => ({ json })),
      jobs: (jobs || []).map((json) => ({ json })),
    },
    { log: () => {} }
  ).map((i) => i.json);
}

const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
const biz = (over) => Object.assign({
  name: 'X', mapsUrl: 'https://www.google.com/maps/place/X', hasWebsite: false,
}, over);
const resp = (businesses, extra) => ({ data: Object.assign({ ok: true, businesses, notes: [] }, extra) });

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log(' FAIL  ' + label + (detail ? ' — ' + detail : '')); }
};

// --- preflight ---------------------------------------------------------------------------
const noBrowser = throws(() => buildJob({}, {}));
check('a dead Browserless stops the run', noBrowser !== null);
check('  ...and names the URL that was tried', /localhost:3004/.test(noBrowser || ''), noBrowser);
check('  ...and gives a command to test it by hand', /json\/version/.test(noBrowser || ''), noBrowser);
check('a live Browserless proceeds', buildJob({}, { Browser: 'Chrome/151.0' }).length === 1);

// --- required settings -------------------------------------------------------------------
check('an empty niche is caught with an example',
  /niche/.test(throws(() => buildJob({ niche: '' })) || '') &&
  /interior designer/.test(throws(() => buildJob({ niche: '' })) || ''),
  throws(() => buildJob({ niche: '' })));

const noCity = throws(() => buildJob({ city: '' }));
check('an empty city is caught', /city/.test(noCity || ''), noCity);
check('  ...and explains that the city IS the geography on Maps',
  /no country filter/i.test(noCity || ''), noCity);
check('whitespace-only settings count as empty', throws(() => buildJob({ city: '   ' })) !== null);

// --- query construction ------------------------------------------------------------------
const one = buildJob({ niche: 'interior designer', city: 'Manchester' });
check('one niche -> one query', one.length === 1, String(one.length));
check('the city is appended to the query', one[0].query === 'interior designer Manchester', one[0].query);

const many = buildJob({ niche: 'dentist, orthodontist ,  physiotherapist', city: 'Leeds' });
check('comma-separated niches become separate queries', many.length === 3, String(many.length));
check('  ...each with the city', many.map((j) => j.query).join(' | ') ===
  'dentist Leeds | orthodontist Leeds | physiotherapist Leeds', many.map((j) => j.query).join(' | '));
check('  ...and blank entries are ignored',
  buildJob({ niche: 'dentist,,  ,plumber' }).length === 2);

// One query per Browserless call, not all of them: Puppeteer aborts a single call at
// 180s, and a deep scroll on several queries in one call blew straight past it.
check('each query is its own Browserless call',
  many.every((j) => j.payload.context.queries.length === 1));

// --- the endpoint ------------------------------------------------------------------------
const ep = one[0].endpoint;
check('token is on the endpoint', /token=changeme-local-token/.test(ep), ep);
check('protocolTimeout is raised past the 180s default',
  /protocolTimeout/.test(decodeURIComponent(ep)) && /600000/.test(decodeURIComponent(ep)), ep);
check('a trailing slash on browserlessUrl does not double up',
  buildJob({ browserlessUrl: 'http://localhost:3004/' })[0].endpoint.indexOf('3004//') === -1,
  buildJob({ browserlessUrl: 'http://localhost:3004/' })[0].endpoint);
check('the scraper source is shipped inline, not read from disk',
  one[0].payload.code.indexOf('export default async function ({ page, context })') !== -1);
check('settings reach the browser context',
  one[0].payload.context.maxPerQuery === 60 && one[0].payload.context.waitMs === 2000);

// --- Filter No-Website -------------------------------------------------------------------
const mixed = filter({}, [resp([
  biz({ name: 'Chiltan Architects', hasWebsite: true, mapsUrl: 'u1' }),
  biz({ name: 'Bismillah Interior', mapsUrl: 'u2' }),
])]);
check('only businesses without a website go on to stage 2',
  mixed.length === 1 && mixed[0].name === 'Bismillah Interior', JSON.stringify(mixed.map((r) => r.name)));

const overlap = filter({}, [
  resp([biz({ name: 'Indigo Interior', mapsUrl: 'u1' })]),
  resp([biz({ name: 'Indigo Interior', mapsUrl: 'u1' }), biz({ name: 'Chiltan Architects', mapsUrl: 'u2' })]),
]);
check('the same place found by two queries is only checked once', overlap.length === 2,
  JSON.stringify(overlap.map((r) => r.name)));

const capped = filter({ maxPlacesToCheck: 3 },
  [resp(Array.from({ length: 20 }, (_, i) => biz({ name: 'Business Number ' + i, mapsUrl: 'u' + i })))]);
check('maxPlacesToCheck caps the expensive stage', capped.length === 3, String(capped.length));

// --- duplicate listings of a business that already has a site ----------------------------
// Found live: "Aenzay Interiors & Architects" (no site) is the same company as "AenZay"
// (aenzay.com), three rows above it in the same scrape.
const withDupe = filter({}, [resp([
  biz({ name: 'AenZay', hasWebsite: true, mapsUrl: 'u1' }),
  biz({ name: 'Aenzay Interiors & Architects', mapsUrl: 'u2' }),
  biz({ name: 'Chiltan Architects and Designers', mapsUrl: 'u3' }),
])]);
check('a duplicate listing of a business with a site is skipped',
  withDupe.length === 1 && withDupe[0].name === 'Chiltan Architects and Designers',
  JSON.stringify(withDupe.map((r) => r.name)));

// The trade and place words every competitor shares must never cause a match, or one
// business with a website wipes out the whole niche.
const sameTrade = filter({}, [resp([
  biz({ name: 'The Inspire Interiors', hasWebsite: true, mapsUrl: 'u1' }),
  biz({ name: 'Indigo Interior', mapsUrl: 'u2' }),
  biz({ name: 'Vip Interior Designer', mapsUrl: 'u3' }),
  biz({ name: 'Bismillah Interior', mapsUrl: 'u4' }),
])]);
check('competitors in the same trade are NOT treated as duplicates',
  sameTrade.length === 3, JSON.stringify(sameTrade.map((r) => r.name)));

const cityNames = filter({ city: 'Lahore' }, [resp([
  biz({ name: 'Interior Designer in Lahore | Architects', hasWebsite: true, mapsUrl: 'u1' }),
  biz({ name: 'Interior Designer in Lahore', mapsUrl: 'u2' }),
])]);
check('the city name is not a distinctive word - everyone has it',
  cityNames.length === 1, JSON.stringify(cityNames.map((r) => r.name)));

check('matching ignores case and punctuation',
  /duplicate listings/.test(throws(() => filter({}, [resp([
    biz({ name: 'AENZAY!', hasWebsite: true, mapsUrl: 'u1' }),
    biz({ name: 'aenzay interiors', mapsUrl: 'u2' }),
  ])])) || ''));

// Found live: "WAO Designworks" and "SR DesignWorks" are unrelated firms. The shared word
// decomposes into design+works, so it must not count as a brand.
check('a run-together trade word is not a brand match',
  filter({}, [resp([
    biz({ name: 'SR DesignWorks (SRDW)', hasWebsite: true, mapsUrl: 'u1' }),
    biz({ name: 'WAO Designworks', mapsUrl: 'u2' }),
  ])]).length === 1);
check('  ...nor is Interiorworks, Homecraft or Woodstudio',
  filter({}, [resp([
    biz({ name: 'Alpha Interiorworks', hasWebsite: true, mapsUrl: 'u1' }),
    biz({ name: 'Beta Interiorworks', mapsUrl: 'u2' }),
    biz({ name: 'Gamma Homecraft', mapsUrl: 'u3' }),
    biz({ name: 'Delta Woodstudio', mapsUrl: 'u4' }),
  ])]).length === 3);
// Only a strict subset counts. Two names that share a brand word but each carry their
// own second word might be one company or two, and dropping a real lead is worse than
// spending one place-page visit to find out - stage 2 checks it either way.
check('  ...and a partial brand overlap is left alone, not dropped',
  filter({}, [resp([
    biz({ name: 'Aenzay Designworks', hasWebsite: true, mapsUrl: 'u1' }),
    biz({ name: 'Aenzay Interiors', mapsUrl: 'u2' }),
    biz({ name: 'Chiltan Architects', mapsUrl: 'u3' }),
  ])]).length === 2);

// Real Phoenix names that the old trade-word list wrongly merged.
const phoenix = filter({ city: 'Phoenix AZ', niche: 'dentist' }, [resp([
  biz({ name: 'Downtown Smiles Phoenix Dental Care', hasWebsite: true, mapsUrl: 'u1' }),
  biz({ name: 'Downtown Phoenix Dental', mapsUrl: 'u2' }),
  biz({ name: 'Family Dental Phoenix', hasWebsite: true, mapsUrl: 'u3' }),
  biz({ name: 'AZ Family Dental - Phoenix', mapsUrl: 'u4' }),
  biz({ name: 'Phoenix Family Dentistry', hasWebsite: true, mapsUrl: 'u5' }),
  biz({ name: 'Arizona Family Dentistry', mapsUrl: 'u6' }),
])]);
check('unrelated practices sharing trade words are all kept',
  phoenix.length === 3, JSON.stringify(phoenix.map((r) => r.name)));

check('a short generic word is not distinctive enough to match',
  filter({}, [resp([
    biz({ name: 'Zen Design', hasWebsite: true, mapsUrl: 'u1' }),
    biz({ name: 'Zen Furniture Lahore', mapsUrl: 'u2' }),
  ])]).length === 1);

// --- several cities ------------------------------------------------------------------------
// Maps has no country filter, so covering a country means listing its cities.
const multi = buildJob({ niche: 'dentist', city: 'Lahore, Karachi, Islamabad' });
check('each city becomes its own search', multi.length === 3, String(multi.length));
check('  ...with the city appended to the niche',
  multi.map((j) => j.query).join(' | ') === 'dentist Lahore | dentist Karachi | dentist Islamabad',
  multi.map((j) => j.query).join(' | '));
check('  ...and each job knows which city it covers',
  multi.map((j) => j.city).join(',') === 'Lahore,Karachi,Islamabad', multi.map((j) => j.city).join(','));

const cross = buildJob({ niche: 'dentist, plumber', city: 'Leeds, York' });
check('niches multiply by cities', cross.length === 4, String(cross.length));
check('  ...covering every combination',
  cross.map((j) => j.query).sort().join(' | ') ===
  ['dentist Leeds', 'dentist York', 'plumber Leeds', 'plumber York'].join(' | '),
  cross.map((j) => j.query).sort().join(' | '));

check('the CSV label names every city', multi[0].cityLabel === 'Lahore-Karachi-Islamabad',
  multi[0].cityLabel);
check('  ...and stays short when there are many',
  buildJob({ city: 'A, B, C, D, E' })[0].cityLabel === 'A-B-C-plus2',
  buildJob({ city: 'A, B, C, D, E' })[0].cityLabel);
check('  ...and is safe to put in a filename',
  /^[A-Za-z0-9-]+$/.test(buildJob({ city: 'Stoke-on-Trent, New York' })[0].cityLabel),
  buildJob({ city: 'Stoke-on-Trent, New York' })[0].cityLabel);

// A country name silently recentres Maps on one city and still caps at ~60 results, so it
// looks like it worked. Tested live: "interior designer Pakistan" returned 67 businesses,
// every one of them in Islamabad.
for (const country of ['Pakistan', 'pakistan', 'UK', 'United States']) {
  const err = throws(() => buildJob({ city: country }));
  check('rejects "' + country + '" as a country', err !== null && /is a country/.test(err), err);
}
check('  ...and says what to do instead',
  /comma-separated/.test(throws(() => buildJob({ city: 'Pakistan' })) || ''));
check('a city that merely contains a country word is still allowed',
  buildJob({ city: 'Panama City' }).length === 1);

// --- the city travels with the business ------------------------------------------------------
const jobs = [{ query: 'dentist Lahore', city: 'Lahore' }, { query: 'dentist Karachi', city: 'Karachi' }];
const tagged = filter({ city: 'Lahore, Karachi' }, [resp([
  biz({ name: 'Alpha Dental', mapsUrl: 'u1', query: 'dentist Lahore' }),
  biz({ name: 'Beta Dental', mapsUrl: 'u2', query: 'dentist Karachi' }),
])], jobs);
check('each business is labelled with the city it was found in',
  tagged.map((r) => r.city).join(',') === 'Lahore,Karachi', tagged.map((r) => r.city).join(','));

// A chain listed in two cities is one business, not two pitches.
const chain = filter({ city: 'Lahore, Karachi' }, [
  resp([biz({ name: 'Chain Co', mapsUrl: 'same', query: 'dentist Lahore' })]),
  resp([biz({ name: 'Chain Co', mapsUrl: 'same', query: 'dentist Karachi' })]),
], jobs);
check('the same place found in two cities is only checked once', chain.length === 1, String(chain.length));

// A cap must not be spent entirely on the first city, or adding a second city to the
// settings changes nothing. Found live: a 2-city run capped at 8 returned 8 Lahore leads
// and 0 from Karachi.
const spread = filter({ city: 'Lahore, Karachi', maxPlacesToCheck: 6 }, [resp(
  Array.from({ length: 10 }, (_, i) => biz({ name: 'L' + i, mapsUrl: 'l' + i, query: 'dentist Lahore' }))
    .concat(Array.from({ length: 10 }, (_, i) => biz({ name: 'K' + i, mapsUrl: 'k' + i, query: 'dentist Karachi' })))
)], jobs);
check('the cap is spread evenly across cities',
  spread.filter((r) => r.city === 'Lahore').length === 3 &&
  spread.filter((r) => r.city === 'Karachi').length === 3,
  JSON.stringify(spread.map((r) => r.name)));

// A city with fewer candidates must not leave budget unspent.
const lopsided = filter({ city: 'Lahore, Karachi', maxPlacesToCheck: 6 }, [resp(
  Array.from({ length: 10 }, (_, i) => biz({ name: 'L' + i, mapsUrl: 'l' + i, query: 'dentist Lahore' }))
    .concat([biz({ name: 'K0', mapsUrl: 'k0', query: 'dentist Karachi' })])
)], jobs);
check('a thin city does not waste the budget', lopsided.length === 6, String(lopsided.length));
check('  ...and the thin city still gets its one lead',
  lopsided.some((r) => r.city === 'Karachi'), JSON.stringify(lopsided.map((r) => r.name)));

check('a single city is unaffected',
  filter({ city: 'Lahore', maxPlacesToCheck: 3 }, [resp(
    Array.from({ length: 10 }, (_, i) => biz({ name: 'L' + i, mapsUrl: 'l' + i, query: 'dentist Lahore' }))
  )], jobs).length === 3);

// --- countryCode must be usable ---------------------------------------------------------------
// An unknown code produced an empty waLink for every lead and said nothing about it. Found
// live: a Rawalpindi run wrote 20 leads and not one usable link.
for (const bad of ['', 'Pakistan', 'PAK', 'United Kingdom', 'xx']) {
  const err = throws(() => buildJob({ countryCode: bad }));
  check('rejects countryCode ' + JSON.stringify(bad), err !== null && /not as+dialling code|not a dialling/.test(err), err);
}
check('  ...and lists the codes it does know',
  /Known: .*GB.*/.test(throws(() => buildJob({ countryCode: 'PAK' })) || ''));
check('  ...and explains what would have gone wrong',
  /waLink would come out blank/.test(throws(() => buildJob({ countryCode: '' })) || ''));
for (const good of ['PK', 'pk', 'GB', 'US', ' IE ']) {
  check('accepts ' + JSON.stringify(good), throws(() => buildJob({ countryCode: good })) === null);
}

// --- failure paths must say what to do ---------------------------------------------------
const allFailed = throws(() => filter({}, [{ error: 'connect ECONNREFUSED' }]));
check('every search failing is an error, not an empty run', allFailed !== null);
check('  ...and surfaces the underlying reason', /ECONNREFUSED/.test(allFailed || ''), allFailed);

const nothingFound = throws(() => filter({}, [resp([])]));
check('zero businesses tells the user to check the spelling',
  /niche and city/i.test(nothingFound || ''), nothingFound);

const allHaveSites = throws(() => filter({}, [resp([biz({ hasWebsite: true, mapsUrl: 'u1' })])]));
check('everyone already having a website is explained, not a silent empty CSV',
  /already have a website/i.test(allHaveSites || ''), allHaveSites);
check('  ...and the count of duplicates is broken out separately',
  /1 more are duplicate listings/.test(throws(() => filter({}, [resp([
    biz({ name: 'AENZAY!', hasWebsite: true, mapsUrl: 'u1' }),
    biz({ name: 'aenzay interiors', mapsUrl: 'u2' }),
  ])])) || ''));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
