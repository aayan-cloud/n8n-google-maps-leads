/**
 * Generates workflow/maps-lead-engine.json.
 *
 * The two browser scripts and the host config live in their own files so they can be
 * linted, diffed and tested with dev/run.js. This generator inlines them into the n8n
 * Code nodes, so the workflow stays a single importable file with no external reads.
 *
 * Re-run after editing anything in scripts/ or config/:
 *     node dev/build-workflow.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SEARCH_SCRIPT = read('scripts/maps-scrape.js');
const DETAIL_SCRIPT = read('scripts/place-detail.js');
const HOSTS = JSON.parse(read('config/placeholder-hosts.json'));

const PLACEHOLDER_HOSTS = []
  .concat(HOSTS.social_and_messaging, HOSTS.link_in_bio, HOSTS.dead_or_hosted_stubs,
          HOSTS.directories_and_aggregators, HOSTS.form_and_booking_only, HOSTS.shorteners)
  .map((h) => h.toLowerCase());
const PARKED_MARKERS = HOSTS.parked_page_markers.map((m) => m.toLowerCase());

// Country dialling codes, so a local number becomes a usable wa.me link.
const DIAL = { GB:'44', IE:'353', US:'1', CA:'1', AU:'61', NZ:'64', DE:'49', AT:'43', CH:'41',
  FR:'33', BE:'32', NL:'31', ES:'34', IT:'39', PT:'351', PL:'48', SE:'46', NO:'47', DK:'45',
  FI:'358', GR:'30', CZ:'420', HU:'36', RO:'40', IN:'91', PK:'92', BD:'880', LK:'94', NP:'977',
  AE:'971', SA:'966', QA:'974', KW:'965', OM:'968', JO:'962', IL:'972', TR:'90', EG:'20',
  MA:'212', NG:'234', GH:'233', KE:'254', ZA:'27', SG:'65', MY:'60', TH:'66', VN:'84', ID:'62',
  PH:'63', HK:'852', TW:'886', KR:'82', JP:'81', CN:'86', BR:'55', MX:'52', AR:'54', CL:'56' };

// ---------------------------------------------------------------------------
// Shared helper source
// ---------------------------------------------------------------------------
const HOST_HELPERS = `
const PLACEHOLDER_HOSTS = ${JSON.stringify(PLACEHOLDER_HOSTS)};
const PARKED_MARKERS = ${JSON.stringify(PARKED_MARKERS)};

// Parsed by hand rather than with new URL(): the n8n Code node sandbox does not expose
// URL as a global, so the constructor throws and every host silently comes back empty.
function hostOf(url) {
  if (!url) return '';
  var s = String(url).trim();
  var m = s.match(/^[a-zA-Z][a-zA-Z0-9+.\\-]*:\\/\\/([^\\/?#]+)/);
  var host = m ? m[1] : s.split(/[\\/?#]/)[0];
  host = host.replace(/^[^@]*@/, '').replace(/:\\d+$/, '');
  return host.toLowerCase().replace(/^www\\./, '');
}

function isPlaceholderHost(host) {
  if (!host) return false;
  for (var i = 0; i < PLACEHOLDER_HOSTS.length; i++) {
    var p = PLACEHOLDER_HOSTS[i];
    if (host === p || host.endsWith('.' + p)) return true;
  }
  return false;
}

// A placeholder host only means "they have no site of their own" when the URL points at a
// PAGE on that host - a profile, a shop, a link page. The bare root means the opposite:
// they own the domain, so they ARE the platform.
//
// Found live: MyBuilder advertising https://www.mybuilder.com/ was tagged placeholder_only
// and shipped as a lead. mybuilder.com belongs on the directory list - a plumber whose only
// presence is a MyBuilder profile is a real lead - but MyBuilder itself is not.
function pathOf(url) {
  if (!url) return '';
  var s = String(url).trim();
  var afterScheme = s.indexOf('://') === -1 ? s : s.slice(s.indexOf('://') + 3);
  var cut = afterScheme.length;
  for (var i = 0; i < afterScheme.length; i++) {
    var c = afterScheme.charAt(i);
    if (c === '/' || c === '?' || c === '#') { cut = i; break; }
  }
  return afterScheme.slice(cut);
}

function isPlaceholderUrl(url) {
  if (!isPlaceholderHost(hostOf(url))) return false;
  var path = pathOf(url);
  // "", "/", "/?utm=x" and "/#top" are all the front door, not a profile.
  var firstSeg = path.charAt(0) === '/' ? path.slice(1) : path;
  var stop = firstSeg.length;
  for (var i = 0; i < firstSeg.length; i++) {
    var c = firstSeg.charAt(i);
    if (c === '/' || c === '?' || c === '#') { stop = i; break; }
  }
  return firstSeg.slice(0, stop).length > 0;
}

// Facebook and Maps both hand back URLs a business typed years ago, and those are often
// http://. Plenty of sites now 404 or refuse on http while serving perfectly on https.
//
// Found live: Miller Homes listed http://www.millerhomes.co.uk/ - a genuine 404 - while
// https://www.millerhomes.co.uk/ returns a 282KB site. A national housebuilder was being
// shipped as a dead_site lead.
//
// The check runs against the https form; the CSV keeps the URL as listed. If a site truly
// serves http only, https fails as ECONNREFUSED, which the classifier already treats as
// inconclusive - so the worst case is a missed lead, never an invented one.
function httpsForm(url) {
  var u = String(url || '').trim();
  if (u.length >= 7 && u.slice(0, 7).toLowerCase() === 'http://') return 'https://' + u.slice(7);
  return u;
}
`;

// ---------------------------------------------------------------------------
// Code node sources
// ---------------------------------------------------------------------------

const CODE_BUILD_SEARCH = `
// Builds the Browserless request, after checking what a first-time user gets wrong.
const s = $('Settings - Edit These').first().json;
const preflight = $input.first().json || {};

if (!preflight.Browser) {
  throw new Error(
    'Browserless did not answer at ' + s.browserlessUrl + '. Start it, then check ' +
    'browserlessUrl and browserlessToken on the Settings node. Test by opening: ' +
    String(s.browserlessUrl).replace(/\\/$/, '') + '/json/version?token=YOUR_TOKEN' +
    (preflight.error && preflight.error.message ? ' | ' + String(preflight.error.message).split('\\n')[0].slice(0, 120) : '')
  );
}

const niches = String(s.niche || '').split(',').map(function (n) { return n.trim(); }).filter(Boolean);
const cities = String(s.city || '').split(',').map(function (c) { return c.trim(); }).filter(Boolean);

if (!niches.length) throw new Error('Set "niche" on the Settings node, e.g. "interior designer".');
if (!cities.length) throw new Error('Set "city" on the Settings node, e.g. "Lahore". Maps has no country filter, so the city IS the geography. For a whole country, list its cities: "Lahore, Karachi, Islamabad".');

// Putting a country name here does not do what it looks like it does. Tested live:
// "interior designer Pakistan" returned 67 businesses, every one of them in Islamabad -
// Maps quietly recentred on a single city and still capped at ~60 results. Listing the
// cities is the only way to actually cover a country.
const COUNTRIES = ['pakistan','india','bangladesh','united kingdom','uk','england','scotland',
  'wales','ireland','usa','united states','america','canada','australia','new zealand',
  'germany','france','spain','italy','netherlands','belgium','portugal','poland','sweden',
  'norway','denmark','finland','uae','united arab emirates','saudi arabia','qatar','turkey',
  'egypt','nigeria','kenya','south africa','malaysia','singapore','indonesia','philippines'];
for (var ci = 0; ci < cities.length; ci++) {
  if (COUNTRIES.indexOf(cities[ci].toLowerCase()) !== -1) {
    throw new Error('"' + cities[ci] + '" is a country, not a city. Maps has no country filter: ' +
      'it would silently recentre on one city and return ~60 results from there. ' +
      'List the cities instead, comma-separated - e.g. "Lahore, Karachi, Islamabad".');
  }
}

// Every niche in every city. Each combination is its own search.
const queries = [];
for (var ni = 0; ni < niches.length; ni++) {
  for (var cj = 0; cj < cities.length; cj++) {
    queries.push({ query: niches[ni] + ' ' + cities[cj], city: cities[cj] });
  }
}

// Names the CSV. Safe for a filename, and short enough to stay readable.
const cityLabel = cities.slice(0, 3).map(function (c) { return c.replace(/[^A-Za-z0-9]+/g, ''); })
  .join('-') + (cities.length > 3 ? '-plus' + (cities.length - 3) : '');

const code = ${JSON.stringify(SEARCH_SCRIPT)};

const rawBase = String(s.browserlessUrl);
const base = rawBase.charAt(rawBase.length - 1) === '/' ? rawBase.slice(0, -1) : rawBase;
// Puppeteer aborts a single call at 180s; raise it so a deep scroll cannot hit the ceiling.
const endpoint = base + '/function?token=' + encodeURIComponent(s.browserlessToken) +
  '&launch=' + encodeURIComponent(JSON.stringify({ protocolTimeout: 600000 }));

console.log('searching Maps (' + queries.length + ' searches): ' +
  queries.map(function (q) { return q.query; }).join(' | '));
// Each search is a separate browser session of roughly 20s plus the place pages it
// generates, so the combination count is what actually decides how long a run takes.
if (queries.length > 6) {
  console.log('that is ' + niches.length + ' niche(s) x ' + cities.length +
    ' cities - expect roughly ' + Math.round(queries.length * 20 / 60) + ' min of searching alone');
}

return queries.map(function (q) {
  return {
    json: {
      city: q.city,
      cityLabel: cityLabel,
      query: q.query,
      endpoint: endpoint,
      payload: {
        code: code,
        context: {
          queries: [q.query],
          maxPerQuery: Number(s.maxPerQuery) || 60,
          waitMs: Number(s.waitMs) || 2000,
          lang: String(s.lang || 'en'),
        },
      },
    },
  };
});
`;

const CODE_FILTER = `
// Merge every query response and keep only businesses with NO website in the list view.
// That is the cheap filter: businesses that already show a website never cost a place
// page visit.
const s = $('Settings - Edit These').first().json;

// Which city each search covered. With several cities in play the business itself has to
// carry its city, or every lead in the CSV is labelled with the first one.
const cityOfQuery = {};
for (const job of $('Build Search Job').all()) cityOfQuery[job.json.query] = job.json.city;

const all = [];
const notes = [];
const seen = {};
let anyOk = false;

for (const item of $input.all()) {
  const j = item.json || {};
  if (j.error) { notes.push('browserless: ' + String(j.error).slice(0, 160)); continue; }
  const body = j.data || {};
  if (body.ok) anyOk = true;
  for (const n of (body.notes || [])) notes.push(n);
  for (const b of (body.businesses || [])) {
    const key = b.mapsUrl || b.name;
    // A chain can appear in two cities' results. Keep the first, so it is pitched once.
    if (!key || seen[key]) continue;
    seen[key] = 1;
    b.city = cityOfQuery[b.query] || '';
    all.push(b);
  }
}

if (!anyOk && !all.length) {
  throw new Error('Every Maps search failed. ' + (notes.length ? notes.join(' | ') : 'No detail returned.'));
}
if (!all.length) {
  throw new Error('No businesses found. Check the niche and city spelling, or widen the niche. ' +
    (notes.length ? 'Notes: ' + notes.join(' | ') : ''));
}

// A business often has more than one Maps listing: a claimed one carrying the website and
// an older or satellite one carrying nothing. The empty listing looks exactly like a lead.
// Found live: "Aenzay Interiors & Architects" (1 review, no site) is the same company as
// "AenZay" (aenzay.com) three rows above it.
//
// Both listings are in this same scrape, so the check is free. Names are reduced to their
// distinctive words - the trade and place words that every competitor shares are exactly
// the ones that must not cause a match.
// Which words are actually distinctive has to come from the results themselves. A
// hand-written trade-word list only ever fits the niche it was written for: tuned on
// interior design, it read "dental", "family" and "smiles" as brand names and threw away
// 14 unrelated Phoenix practices as duplicates of each other.
//
// A word that shows up across many businesses in the same search is by definition not a
// brand, whatever the trade is.
const CORPORATE = ['ltd','llc','inc','pvt','private','limited','company','group','the','and'];

// Split on "not a letter or digit", with no backslash escape anywhere. A \\s here is one
// backslash short by the time this string has been through the generator's template
// literal, leaving /s+/ - which splits names on the letter S. Not hypothetical: it turned
// "aenzay interiors architects" into ["aenzay interior", "   architect"].
function wordsOf(name) {
  return String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

const CITY_WORDS = wordsOf(s.city);
const NICHE_WORDS = wordsOf(s.niche);

// How many different businesses use each word.
const freq = {};
for (const b of all) {
  const uniq = {};
  for (const w of wordsOf(b.name)) uniq[w] = 1;
  for (const w of Object.keys(uniq)) freq[w] = (freq[w] || 0) + 1;
}
const commonAt = Math.max(3, Math.ceil(all.length * 0.08));

function keyWords(name) {
  return wordsOf(name).filter(function (w) {
    // Down to 2 characters on purpose. Requiring 4 discarded the very tokens that tell
    // two firms apart - the "WAO" in WAO Designworks, the "SR" in SR DesignWorks - and
    // left the shared trade word looking like a complete match. Frequency, not length,
    // is what identifies a word as generic.
    return w.length >= 2 &&
      CITY_WORDS.indexOf(w) === -1 &&
      NICHE_WORDS.indexOf(w) === -1 &&
      CORPORATE.indexOf(w) === -1 &&
      (freq[w] || 0) < commonAt;
  });
}

const withSite = all.filter(function (b) { return b.hasWebsite; });
const siteKeys = withSite.map(function (b) { return { name: b.name, words: keyWords(b.name) }; });

const dupes = [];
const candidates = all.filter(function (b) {
  if (b.hasWebsite) return false;

  const words = keyWords(b.name);
  // No distinctive word at all means nothing to match on; keep it rather than guess.
  if (!words.length) return true;

  for (var i = 0; i < siteKeys.length; i++) {
    const other = siteKeys[i];
    if (!other.words.length) continue;

    const thisShorter = words.length <= other.words.length;
    const shortW = thisShorter ? words : other.words;
    const longW = thisShorter ? other.words : words;
    const shortName = thisShorter ? b.name : other.name;

    // Every distinctive word of the shorter name must appear in the longer one.
    const covered = shortW.every(function (w) { return longW.indexOf(w) !== -1; });
    if (!covered) continue;

    // ...and the shorter name has to be mostly that brand, not mostly trade words with
    // one rare word in it. "AenZay" is 1/1 distinctive; "Downtown Phoenix Dental" is 1/3,
    // and matching on "downtown" alone is how unrelated practices got merged.
    const total = wordsOf(shortName).length || 1;
    if (shortW.length / total < 0.5) continue;

    dupes.push(b.name + ' ~ ' + other.name);
    return false;
  }
  return true;
});

// How much the list view actually told us. In UK and Asian results the cards carry a
// website button and this stage does most of the filtering. In US and Irish results the
// cards carry no action row at all, so almost everything arrives as 'unknown' and the
// place pages do the work instead.
const known = all.filter(function (b) { return b.websiteSignal === 'none'; }).length;
const unknown = all.filter(function (b) { return b.websiteSignal !== 'none' && b.websiteSignal !== 'has'; }).length;

console.log('found ' + all.length + ' businesses: ' + withSite.length + ' clearly have a website, ' +
  known + ' clearly do not, ' + unknown + ' the list would not say');
if (dupes.length) console.log('skipped ' + dupes.length + ' duplicate listing(s) of a business that HAS a site: ' + dupes.join('; '));

if (unknown > known * 2 && unknown > 5) {
  console.log('NOTE: these result cards carry no website button - normal for US and Irish ' +
    'searches. Nothing is lost, but the answer comes from the place pages, so raise ' +
    'maxPlacesToCheck if you want more than ' + (Number(s.maxPlacesToCheck) || 40) + ' of them checked.');
}
if (notes.length) console.log('notes: ' + notes.join(' | '));

if (!candidates.length) {
  throw new Error('None of the ' + all.length + ' businesses found is a lead: ' +
    withSite.length + ' already have a website' +
    (dupes.length ? ' and ' + dupes.length + ' more are duplicate listings of those' : '') +
    '. Try another niche or city.');
}

// Take from each city in turn rather than straight off the top of the merged list.
// Without this the first city eats the whole budget and adding a second city changes
// nothing - a 2-city run capped at 8 returned 8 Lahore leads and 0 from Karachi.
const byCity = {};
const cityOrder = [];
for (const b of candidates) {
  const c = b.city || '';
  if (!byCity[c]) { byCity[c] = []; cityOrder.push(c); }
  byCity[c].push(b);
}

const cap = Number(s.maxPlacesToCheck) || 40;
const picked = [];
for (let round = 0; picked.length < cap; round++) {
  let addedThisRound = false;
  for (const c of cityOrder) {
    if (picked.length >= cap) break;
    if (byCity[c][round]) { picked.push(byCity[c][round]); addedThisRound = true; }
  }
  if (!addedThisRound) break;
}

console.log('checking ' + picked.length + ' place pages, about ' +
  Math.max(1, Math.round(picked.length * 5 / 60)) + ' min');

if (cityOrder.length > 1) {
  console.log('checking ' + picked.length + ' places, spread across ' + cityOrder.length + ' cities: ' +
    cityOrder.map(function (c) {
      return (c || 'unknown') + ' ' + picked.filter(function (b) { return (b.city || '') === c; }).length;
    }).join(', '));
}

return picked.map(function (b) { return { json: b }; });
`;

const CODE_BUILD_DETAIL = `
// One Browserless call per batch of places, each opened in the same browser session.
const s = $('Settings - Edit These').first().json;

const places = $input.all().map(function (i) {
  return { mapsUrl: i.json.mapsUrl, name: i.json.name };
});

const code = ${JSON.stringify(DETAIL_SCRIPT)};

const rawBase = String(s.browserlessUrl);
const base = rawBase.charAt(rawBase.length - 1) === '/' ? rawBase.slice(0, -1) : rawBase;
const endpoint = base + '/function?token=' + encodeURIComponent(s.browserlessToken) +
  '&launch=' + encodeURIComponent(JSON.stringify({ protocolTimeout: 600000 }));

return [{
  json: {
    endpoint: endpoint,
    payload: { code: code, context: { places: places, waitMs: Number(s.placeWaitMs) || 1200, lang: String(s.lang || 'en') } },
  },
}];
`;

const CODE_PARSE_DETAIL = `
// Re-attach the list-view row to the detail read, keyed on the place URL.
const resp = $input.first().json || {};
const results = (resp.data || {}).results || [];

const byUrl = {};
for (const item of $('Filter No-Website').all()) byUrl[item.json.mapsUrl] = item.json;

return results.map(function (r) {
  const base = byUrl[r.mapsUrl] || {};
  return {
    json: {
      name: (r.title || r.name || base.name || '').trim(),
      mapsUrl: r.mapsUrl,
      query: base.query || '',
      city: base.city || '',
      sponsored: Boolean(base.sponsored),
      rating: r.rating === null || r.rating === undefined ? base.rating : r.rating,
      reviewCount: Number(r.reviewCount) || 0,
      category: r.category || base.category || '',
      address: r.address || base.address || '',
      phone: r.phone || base.phone || '',
      websiteRaw: r.website || '',
      hasWebsite: Boolean(r.hasWebsite),
      detailError: r.error || '',
    },
  };
});
`;

const CODE_QUALIFY = `
${HOST_HELPERS}

// The place page carries its own website button, independent of the list view. A
// business that shows one here had an incomplete listing, not a missing website - drop
// it rather than pitch someone who already has a site.
const s = $('Settings - Edit These').first().json;
const minReviews = Number(s.minReviews) || 0;

let confirmed = 0;
let hadSite = 0;
let thin = 0;

const rows = $input.all().filter(function (item) {
  const j = item.json;

  if (j.detailError) return true;            // unreadable - handled below as unverified

  if (j.hasWebsite) { hadSite++; return false; }

  // Quality floor. Reviews are the closest Maps equivalent to proven demand.
  if (minReviews > 0 && Number(j.reviewCount) < minReviews) { thin++; return false; }

  confirmed++;
  return true;
});

console.log('confirmed no website: ' + confirmed +
  ' | dropped (place page shows a website after all): ' + hadSite +
  (thin ? ' | dropped under ' + minReviews + ' reviews: ' + thin : ''));

if (!rows.length) {
  console.log('Nothing left. Lower minReviews, or try another niche/city.');
}

return rows.map(function (item) {
  const j = item.json;

  // A business can list a website that is itself a placeholder (Facebook, Linktree) or
  // simply dead. Those still count as leads, tagged so the pitch can differ.
  const host = hostOf(j.websiteRaw);
  let leadReason = 'no_website';
  let siteCheck = 'no_site_listed';
  let needsLivenessCheck = false;

  if (j.detailError) {
    leadReason = 'unverified';
    siteCheck = 'place_page_not_readable';
  } else if (j.websiteRaw && isPlaceholderUrl(j.websiteRaw)) {
    // A PROFILE on a directory or social host - facebook.com/them, checkatrade.com/them.
    // The bare root of one of those hosts means they own it, so it is their real site.
    leadReason = 'placeholder_only';
    siteCheck = 'placeholder:' + host;
  } else if (j.websiteRaw) {
    needsLivenessCheck = true;
  }

  return { json: Object.assign({}, j, {
    // With several cities searched, the settings field is a list - the business carries
    // the one it was actually found in.
    city: j.city || String(s.city || '').split(',')[0].trim(),
    websiteHost: host,
    // What the liveness check actually requests. The CSV keeps websiteRaw as listed.
    checkUrl: httpsForm(j.websiteRaw),
    leadReason: leadReason,
    siteCheck: siteCheck,
    needsLivenessCheck: needsLivenessCheck,
  }) };
});
`;

const CODE_SHAPE_SITE = [
  '// Fold the HTTP response back onto the lead so the classifier sees one object.',
  "const leads = $('Needs Liveness Check?').all();",
  'return $input.all().map(function (item, i) {',
  '  const r = item.json || {};',
  '  const base = leads[i] ? leads[i].json : {};',
  '  return { json: Object.assign({}, base, {',
  '    __statusCode: r.statusCode || 0,',
  "    __finalUrl: (r.headers && (r.headers.location || r.headers['content-location'])) || base.websiteRaw || '',",
  "    __body: typeof r.body === 'string' ? r.body.slice(0, 6000) : (typeof r.data === 'string' ? r.data.slice(0, 6000) : ''),",
  "    __error: r.error ? String(r.error.message || r.error) : '',",
  '  }) };',
  '});',
].join('\n');

const CODE_SITE_HEALTH = `
${HOST_HELPERS}

// Deliberately conservative. A request that gets no response is not evidence of a dead
// site: plenty of live sites answer a plain server request with 403/409/503 because of
// bot protection. Only unreachable hosts and definitively-gone pages count as dead.
return $input.all().map(function (item) {
  const j = item.json;
  const status = Number(j.__statusCode);
  const finalUrl = String(j.__finalUrl || '');
  const bodyText = String(j.__body || '');
  const errText = String(j.__error || '');
  const low = (finalUrl + ' ' + bodyText.slice(0, 4000)).toLowerCase();

  const DEAD_ERRORS = /ENOTFOUND|ERR_NAME_NOT_RESOLVED/i;
  const TRANSIENT = /EAI_AGAIN|ETIMEDOUT|ECONNABORTED|ECONNRESET|EPIPE|timeout of|socket hang up|network|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED/i;
  const GONE = [404, 410];
  const BLOCKED = [401, 403, 405, 406, 409, 418, 429, 500, 502, 503, 504];

  let dead = false;
  let why = '';

  if (!status) {
    if (DEAD_ERRORS.test(errText)) { dead = true; why = 'dns_not_found'; }
    else if (TRANSIENT.test(errText)) { why = 'inconclusive_transient'; }
    else { why = 'inconclusive_no_response'; }
  }
  else if (GONE.indexOf(status) !== -1) { dead = true; why = 'http_' + status; }
  else if (BLOCKED.indexOf(status) !== -1) { why = 'inconclusive_' + status; }
  else if (status >= 400) { dead = true; why = 'http_' + status; }
  else if (bodyText && bodyText.length < 200) { dead = true; why = 'empty_body'; }
  else {
    for (var i = 0; i < PARKED_MARKERS.length; i++) {
      if (low.indexOf(PARKED_MARKERS[i]) !== -1) { dead = true; why = 'parked:' + PARKED_MARKERS[i]; break; }
    }
  }
  if (!dead) {
    const fh = hostOf(finalUrl);
    if (fh && isPlaceholderHost(fh)) { dead = true; why = 'redirects_to:' + fh; }
  }

  const out = Object.assign({}, j, { siteCheck: why || ('ok_' + status) });
  delete out.__statusCode; delete out.__finalUrl; delete out.__body; delete out.__error;

  out.leadReason = dead ? 'dead_site' : 'disqualified_has_site';
  return { json: out };
});
`;

const CODE_SCORE = `
// Rank by how established the business is, since Maps has no ad-spend signal.
//
// Reviews carry the most weight: they are the closest thing Maps offers to proven
// demand, and unlike a follower count they cannot be bought cheaply in bulk. Rating
// only matters once there are enough reviews for it to mean anything.
const HIGH_TICKET = ['dental','dentist','orthodont','derma','skin','clinic','hospital','aesthetic',
  'cosmetic','surgeon','interior','architect','real estate','property','realtor','law','legal',
  'attorney','solicitor','jewel','furniture','automotive','car dealer','fitness','gym','spa','salon',
  'veterinar','wedding','bridal','photographer','construction','builder','landscap','roofing'];

const rows = $input.all()
  .map(function (i) { return i.json; })
  .filter(function (j) { return j.leadReason && j.leadReason !== 'disqualified_has_site' && j.leadReason !== 'unverified'; });

const scored = rows.map(function (j) {
  const cat = String(j.category || '').toLowerCase();
  const reviews = Number(j.reviewCount) || 0;
  const rating = Number(j.rating) || 0;

  // Established-ness, the dominant term.
  const reviewScore =
    reviews >= 200 ? 30 :
    reviews >= 100 ? 26 :
    reviews >= 50 ? 22 :
    reviews >= 20 ? 17 :
    reviews >= 5 ? 10 :
    reviews >= 1 ? 4 : 0;

  // A rating means nothing on 2 reviews, so it only counts once there are enough.
  const ratingScore = reviews >= 5 ? (rating >= 4.7 ? 8 : rating >= 4.2 ? 5 : rating >= 3.5 ? 2 : 0) : 0;

  // Paying for Google Ads is the same proven-budget signal the Meta version relies on.
  const sponsored = j.sponsored ? 12 : 0;
  const reachable = j.phone ? 8 : 0;
  const highTicket = HIGH_TICKET.some(function (k) { return cat.indexOf(k) !== -1; }) ? 8 : 0;
  const intent = j.leadReason === 'dead_site' ? 10 : j.leadReason === 'placeholder_only' ? 10 : 6;

  const score = reviewScore + ratingScore + sponsored + reachable + highTicket + intent;

  return Object.assign({}, j, {
    score: score,
    isHighTicket: highTicket > 0,
    isReachable: reachable > 0,
  });
});

return scored.map(function (j) { return { json: j }; });
`;

const CODE_TAG_SEEN = `
// Compare against the ledger of everything produced before. Extract From File nests the
// records under a "data" key, and on the very first run the file does not exist at all,
// so unwrap defensively and treat anything without a mapsUrl as absent.
const s = $('Settings - Edit These').first().json;
const onlyNew = s.onlyNewLeads === true || String(s.onlyNewLeads).toLowerCase() === 'true';

const known = {};
function absorb(rec, depth) {
  if (!rec || (depth || 0) > 3) return;
  if (Array.isArray(rec)) { rec.forEach(function (x) { absorb(x, (depth || 0) + 1); }); return; }
  if (rec.mapsUrl) { known[rec.mapsUrl] = rec; return; }
  if (rec.data) absorb(rec.data, (depth || 0) + 1);
}
for (const item of $input.all()) absorb(item.json, 0);

const today = new Date().toISOString().slice(0, 10);
const leads = $('Score + Rank').all().map(function (i) { return i.json; });

let newCount = 0;
let seenCount = 0;
const out = [];

for (const j of leads) {
  const prev = known[j.mapsUrl];
  const isNew = !prev;
  if (isNew) newCount++; else seenCount++;
  if (onlyNew && !isNew) continue;
  out.push({ json: Object.assign({}, j, {
    isNew: isNew,
    firstSeenOn: prev && prev.firstSeen ? prev.firstSeen : today,
    timesSeen: prev ? (Number(prev.timesSeen) || 1) + 1 : 1,
  }) });
}

console.log('ledger holds ' + Object.keys(known).length + ' businesses | this run: ' +
  newCount + ' new, ' + seenCount + ' already seen' + (onlyNew ? ' (filtered out)' : ' (kept)'));
if (!out.length) console.log('Nothing new. Change niche or city, or set onlyNewLeads=false.');

return out;
`;

const CODE_BUILD_LEDGER = `
// Rewrite the ledger: everything it knew, plus every business qualified in this run -
// including ones filtered out as already seen, so their lastSeen stays current.
const today = new Date().toISOString().slice(0, 10);

const ledger = {};
function absorb(rec, depth) {
  if (!rec || (depth || 0) > 3) return;
  if (Array.isArray(rec)) { rec.forEach(function (x) { absorb(x, (depth || 0) + 1); }); return; }
  if (rec.mapsUrl) { ledger[rec.mapsUrl] = rec; return; }
  if (rec.data) absorb(rec.data, (depth || 0) + 1);
}
for (const item of $('Ledger From JSON').all()) absorb(item.json, 0);

for (const item of $('Score + Rank').all()) {
  const j = item.json;
  if (!j.mapsUrl) continue;
  const prev = ledger[j.mapsUrl];
  ledger[j.mapsUrl] = {
    mapsUrl: j.mapsUrl,
    name: j.name || (prev ? prev.name : ''),
    city: j.city || (prev ? prev.city : ''),
    leadReason: j.leadReason || (prev ? prev.leadReason : ''),
    firstSeen: prev && prev.firstSeen ? prev.firstSeen : today,
    lastSeen: today,
    timesSeen: prev ? (Number(prev.timesSeen) || 1) + 1 : 1,
  };
}

const rows = Object.keys(ledger).map(function (k) { return { json: ledger[k] }; });
console.log('ledger written: ' + rows.length + ' businesses total');
return rows;
`;

const CODE_OUTREACH = `
// Maps leads are almost always phone-first: Google lists a number far more often than
// an email, and local trades answer their own phone.
const DIAL = ${JSON.stringify(DIAL)};
const NATIONAL_LEN = { GB:10, IE:9, US:10, CA:10, AU:9, NZ:9, DE:11, AT:10, CH:9, FR:9, BE:9,
  NL:9, ES:9, IT:10, PT:9, PL:9, SE:9, NO:8, DK:8, FI:9, GR:10, CZ:9, HU:9, RO:9, IN:10, PK:10,
  BD:10, LK:9, NP:10, AE:9, SA:9, QA:8, KW:8, OM:8, JO:9, IL:9, TR:10, EG:10, MA:9, NG:10, GH:9,
  KE:9, ZA:9, SG:8, MY:9, TH:9, VN:9, ID:10, PH:10, HK:8, TW:9, KR:10, JP:10, CN:11, BR:11,
  MX:10, AR:10, CL:9 };

const s = $('Settings - Edit These').first().json;
const cc = String(s.countryCode || '').trim().toUpperCase();

function digitsOnly(v) { return String(v || '').replace(/[^\\d]/g, ''); }

// wa.me needs an international number. "Starts with the country code" is not enough:
// a 10-digit Indian mobile can begin with 91 and still be national.
function toInternational(digits, country) {
  const dial = DIAL[country];
  if (!digits) return '';
  if (!dial) return '';
  const nat = NATIONAL_LEN[country] || 10;
  const d = digits.replace(/^0+/, '');
  if (d.length === nat) return dial + d;
  if (d.indexOf(dial) === 0 && d.length === dial.length + nat) return d;
  if (d.indexOf(dial) === 0 && d.length > nat) return d;
  return dial + d;
}

// WhatsApp needs a mobile. Western businesses list landlines far more often than the
// markets this was first built against, and wa.me on a landline opens a chat that will
// never be read - worse than no link, because it looks like a channel.
//
// Only countries where the national number says so outright are classified. The US and
// Canada share one numbering plan for mobile and fixed lines, so there is nothing to read.
const MOBILE_PREFIX = {
  GB: /^7/, IE: /^8[35-9]/, DE: /^1[5-7]/, FR: /^[67]/, ES: /^[67]/, IT: /^3/,
  NL: /^6/, BE: /^4[5-9]/, PT: /^9/, AT: /^6/, CH: /^7[5-9]/, SE: /^7/, NO: /^[49]/,
  DK: /^[2-5]/, FI: /^4|^50/, AU: /^4/, NZ: /^2/, PL: /^[4-8]/, GR: /^69/,
};

function phoneTypeOf(digits, country) {
  const re = MOBILE_PREFIX[country];
  if (!re) return 'unknown';
  const dial = DIAL[country];
  let nat = digits.replace(/^0+/, '');
  // Strip the country code if the number was already written internationally.
  if (dial && nat.indexOf(dial) === 0 && nat.length > (NATIONAL_LEN[country] || 10)) {
    nat = nat.slice(dial.length).replace(/^0+/, '');
  }
  return re.test(nat) ? 'mobile' : 'landline';
}

return $input.all().map(function (item) {
  const j = item.json;
  const phone = digitsOnly(j.phone);
  const waNumber = phone ? toInternational(phone, cc) : '';
  const phoneType = phone ? phoneTypeOf(phone, cc) : '';

  // No dial code means no usable link; a wa.me without one silently opens nothing.
  // A known landline is the same problem wearing a better disguise.
  const waLink = (waNumber && phoneType !== 'landline') ? 'https://wa.me/' + waNumber : '';

  const outreachStatus = phone ? 'READY_CALL' : 'NO_CHANNEL';

  return { json: Object.assign({}, j, {
    waNumber: waNumber,
    waLink: waLink,
    phoneType: phoneType,
    outreachStatus: outreachStatus,
    lastContacted: '',
  }) };
});
`;

const CODE_TO_ROWS = `
// Flatten to the sheet columns, in a stable order.

// Excel and Google Sheets treat a cell whose FIRST character is = + - or @ as a formula.
// So "+44 7718 538734" opens as #ERROR! rather than a phone number. Quoting the CSV does
// not help: this is the spreadsheet parsing the value, not the CSV being ambiguous.
//
// Phone numbers drop the leading + outright - the digits are what you dial, and waLink
// still carries the full international number. Any other text that starts with one of
// those characters gets a leading space, which stops the parse and is invisible in the
// cell.
//
// Written with no regex on purpose. These patterns pass through two template literals on
// their way into the node, and a \s or \+ arrives one backslash short - which is how
// /^[0-9]/ once became /^[d]/ and matched nothing at all.
function noLeadingPlus(v) {
  let t = String(v === null || v === undefined ? '' : v).trim();
  while (t.charAt(0) === '+') t = t.slice(1).trim();
  return t;
}

function sheetSafe(v) {
  const t = String(v === null || v === undefined ? '' : v);
  const c = t.charAt(0);
  return (c === '=' || c === '+' || c === '-' || c === '@') ? ' ' + t : t;
}

return $input.all().map(function (item) {
  const j = item.json;
  return { json: {
    score: j.score,
    name: sheetSafe(j.name),
    leadReason: sheetSafe(j.leadReason),
    category: sheetSafe(j.category),
    city: sheetSafe(j.city),
    address: sheetSafe(j.address),
    rating: j.rating === null || j.rating === undefined ? '' : j.rating,
    reviewCount: j.reviewCount || 0,
    sponsored: j.sponsored ? 'YES' : '',
    phone: noLeadingPlus(j.phone),
    phoneType: sheetSafe(j.phoneType),
    waLink: sheetSafe(j.waLink),
    websiteFound: sheetSafe(j.websiteRaw),
    siteCheck: sheetSafe(j.siteCheck),
    mapsUrl: sheetSafe(j.mapsUrl),
    query: sheetSafe(j.query),
    outreachStatus: sheetSafe(j.outreachStatus),
    lastContacted: '',
  } };
});
`;

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------
const uuidFor = (name) => {
  const h = crypto.createHash('md5').update('maps-lead-engine:' + name).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), '4' + h.slice(13, 16), '8' + h.slice(17, 20), h.slice(20, 32)].join('-');
};
const node = (name, type, typeVersion, position, parameters, extra) =>
  Object.assign({ parameters, id: uuidFor(name), name, type, typeVersion, position }, extra || {});

const nodes = [
  node('Run Now', 'n8n-nodes-base.manualTrigger', 1, [-460, 0], {}),

  node('Run Weekly', 'n8n-nodes-base.scheduleTrigger', 1.2, [-460, 180], {
    rule: { interval: [{ field: 'weeks', triggerAtDay: [1], triggerAtHour: 9 }] },
  }, { disabled: true }),

  node('Settings - Edit These', 'n8n-nodes-base.set', 3.4, [-240, 60], {
    assignments: {
      assignments: [
        // Comma-separate to sweep several trades in one run.
        { id: 'm1', name: 'niche', value: 'dog groomer, mobile car valeting', type: 'string' },
        // Maps has no country filter, so the city IS the geography. Comma-separate to
        // cover a whole country: "Lahore, Karachi, Islamabad". A country name is rejected -
        // Maps would silently recentre on one city and look like it had worked.
        { id: 'm2', name: 'city', value: 'Leeds, Manchester', type: 'string' },
        // Only used to build wa.me links from local numbers.
        { id: 'm3', name: 'countryCode', value: 'GB', type: 'string' },
        // Quality floor. Reviews are the closest Maps gets to proven demand, but the
        // numbers are far smaller than follower counts: on live Lahore runs a floor of 5
        // kept 62% of leads and a floor of 100 kept 8%.
        //
        // This does NOT save runtime. Review counts only exist on the place page, so the
        // page is already open by the time the floor applies - it only trims the CSV. The
        // score already ranks unreviewed businesses last either way.
        { id: 'm4', name: 'minReviews', value: 5, type: 'number' },
        { id: 'm5', name: 'maxPerQuery', value: 60, type: 'number' },
        // Each place page costs ~7.6s, so this is the runtime dial.
        { id: 'm6', name: 'maxPlacesToCheck', value: 40, type: 'number' },
        { id: 'm7', name: 'browserlessUrl', value: 'http://localhost:3004', type: 'string' },
        { id: 'm8', name: 'browserlessToken', value: 'changeme-local-token', type: 'string' },
        { id: 'm9', name: 'waitMs', value: 2000, type: 'number' },
        { id: 'm10', name: 'placeWaitMs', value: 1200, type: 'number' },
        { id: 'm11', name: 'lang', value: 'en', type: 'string' },
        // Must be a folder n8n is allowed to write to - see SETUP.md. This default is
        // n8n's own files directory in the official Docker image; on Windows use
        // something like C:/n8n-files/maps-leads.
        { id: 'm12', name: 'outputFolder', value: '/home/node/.n8n-files/maps-leads', type: 'string' },
        { id: 'm13', name: 'ledgerFile', value: '/home/node/.n8n-files/maps-leads/seen-places.json', type: 'string' },
        { id: 'm14', name: 'onlyNewLeads', value: true, type: 'boolean' },
      ],
    },
    options: {},
  }),

  node('Preflight - Browserless', 'n8n-nodes-base.httpRequest', 4.2, [-20, 60], {
    url: "={{ $json.browserlessUrl.replace(/\\/$/, '') }}/json/version?token={{ $json.browserlessToken }}",
    options: { response: { response: { neverError: true } }, timeout: 10000 },
  }, { onError: 'continueRegularOutput', alwaysOutputData: true }),

  node('Build Search Job', 'n8n-nodes-base.code', 2, [190, 60], { jsCode: CODE_BUILD_SEARCH.trim() }),

  node('Browserless - Search Maps', 'n8n-nodes-base.httpRequest', 4.2, [420, 60], {
    method: 'POST',
    url: '={{ $json.endpoint }}',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.payload) }}',
    options: { response: { response: { neverError: true } }, timeout: 240000 },
  }),

  node('Filter No-Website', 'n8n-nodes-base.code', 2, [640, 60], { jsCode: CODE_FILTER.trim() }),

  node('Loop Places', 'n8n-nodes-base.splitInBatches', 3, [860, 60], { batchSize: 8, options: { reset: false } }),

  node('Build Detail Job', 'n8n-nodes-base.code', 2, [1080, 200], { jsCode: CODE_BUILD_DETAIL.trim() }),

  node('Browserless - Place Details', 'n8n-nodes-base.httpRequest', 4.2, [1300, 200], {
    method: 'POST',
    url: '={{ $json.endpoint }}',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.payload) }}',
    options: { response: { response: { neverError: true } }, timeout: 240000 },
  }),

  node('Parse Place Details', 'n8n-nodes-base.code', 2, [1520, 200], { jsCode: CODE_PARSE_DETAIL.trim() }),

  node('Confirm + Qualify', 'n8n-nodes-base.code', 2, [1080, -80], { jsCode: CODE_QUALIFY.trim() }),

  node('Needs Liveness Check?', 'n8n-nodes-base.if', 2.2, [1300, -80], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: 'c1',
        leftValue: '={{ $json.needsLivenessCheck }}',
        rightValue: true,
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  }),

  node('Check Site Alive', 'n8n-nodes-base.httpRequest', 4.2, [1520, -180], {
    url: '={{ $json.checkUrl || $json.websiteRaw }}',
    options: {
      response: { response: { neverError: true, fullResponse: true } },
      timeout: 25000,
      redirect: { redirect: { followRedirects: true, maxRedirects: 5 } },
      allowUnauthorizedCerts: true,
    },
  }, { onError: 'continueRegularOutput', alwaysOutputData: true, retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 }),

  node('Shape Site Response', 'n8n-nodes-base.code', 2, [1740, -180], { jsCode: CODE_SHAPE_SITE }),
  node('Classify Site Health', 'n8n-nodes-base.code', 2, [1960, -180], { jsCode: CODE_SITE_HEALTH.trim() }),

  node('Merge Lead Streams', 'n8n-nodes-base.merge', 3.2, [2180, -80], { numberInputs: 2 }),
  node('Score + Rank', 'n8n-nodes-base.code', 2, [2400, -80], { jsCode: CODE_SCORE.trim() }),

  node('Read Ledger', 'n8n-nodes-base.readWriteFile', 1, [2400, 140], {
    fileSelector: "={{ $('Settings - Edit These').first().json.ledgerFile }}",
    options: {},
  }, { onError: 'continueRegularOutput', alwaysOutputData: true, executeOnce: true }),

  node('Ledger From JSON', 'n8n-nodes-base.extractFromFile', 1, [2400, 280], {
    operation: 'fromJson', binaryPropertyName: 'data', options: {},
  }, { onError: 'continueRegularOutput', alwaysOutputData: true, executeOnce: true }),

  node('Tag New vs Seen', 'n8n-nodes-base.code', 2, [2400, 420], { jsCode: CODE_TAG_SEEN.trim() }),

  node('Sort by Score', 'n8n-nodes-base.sort', 1, [2620, -80], {
    sortFieldsUi: { sortField: [{ fieldName: 'score', order: 'descending' }] }, options: {},
  }),

  node('Build Outreach', 'n8n-nodes-base.code', 2, [2840, -80], { jsCode: CODE_OUTREACH.trim() }),
  node('Shape Rows', 'n8n-nodes-base.code', 2, [3060, -80], { jsCode: CODE_TO_ROWS.trim() }),

  node('To CSV', 'n8n-nodes-base.convertToFile', 1.1, [3280, -80], {
    operation: 'csv', options: { fileName: 'leads.csv', headerRow: true },
  }),

  node('Save Leads CSV', 'n8n-nodes-base.readWriteFile', 1, [3500, -80], {
    operation: 'write',
    fileName: "={{ $('Settings - Edit These').first().json.outputFolder }}/maps-leads-{{ $('Build Search Job').first().json.cityLabel }}-{{ $now.format('yyyy-LL-dd-HHmm') }}.csv",
    dataPropertyName: 'data',
    options: {},
  }),

  node('Build Ledger', 'n8n-nodes-base.code', 2, [3500, 140], { jsCode: CODE_BUILD_LEDGER.trim() }),
  node('Ledger To File', 'n8n-nodes-base.convertToFile', 1.1, [3500, 280], {
    operation: 'toJson', options: { fileName: 'seen-places.json', format: true },
  }),
  node('Save Ledger', 'n8n-nodes-base.readWriteFile', 1, [3500, 420], {
    operation: 'write',
    fileName: "={{ $('Settings - Edit These').first().json.ledgerFile }}",
    dataPropertyName: 'data',
    options: {},
  }),

  // Shipped disabled: n8n validates required parameters BEFORE running a workflow, so an
  // unconfigured Document/Sheet aborts the entire run before any node executes.
  node('Append to Google Sheet', 'n8n-nodes-base.googleSheets', 4.7, [3720, 140], {
    operation: 'appendOrUpdate',
    documentId: { __rl: true, mode: 'list', value: '' },
    sheetName: { __rl: true, mode: 'list', value: '' },
    columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['mapsUrl'], schema: [] },
    options: { cellFormat: 'RAW' },
  }, { onError: 'continueRegularOutput', alwaysOutputData: true, disabled: true }),
];

// ---------------------------------------------------------------------------
// Sticky notes
// ---------------------------------------------------------------------------
const sticky = (name, pos, w, h, color, content) =>
  node(name, 'n8n-nodes-base.stickyNote', 1, pos, { width: w, height: h, color, content });

nodes.push(
  sticky('Note - Start Here', [-480, -340], 460, 300, 4,
`## Start here — 2 things

**1. Browserless must be running.**
\`docker run -p 3004:3000 -e TOKEN=my-token ghcr.io/browserless/chromium\`

**2. Set \`niche\` + \`city\`** on the Settings node.
Maps has **no country filter** — the city IS the geography.
For a whole country, **list its cities**, comma-separated:
\`Lahore, Karachi, Islamabad\`. Niches multiply by cities.
\`countryCode\` is only used to build wa.me links.

Then hit **Run Now**. Leads land in \`output/\` as CSV.
*Run Weekly* is disabled until you're happy.`),

  sticky('Note - How it works', [620, -300], 460, 250, 5,
`## Two stages, cheap one first

**Stage 1** scrapes the Maps result list. The card shows a
**Website** button — businesses without one are candidates.
68 businesses in ~18s; typically ~21% have no site.

**Stage 2** opens ONLY those candidates' place pages
(~7.6s each) for review count, full address, and a
**second, independent website check**.

That second check is the point: it catches a business whose
listing was merely incomplete, before you pitch someone who
already has a site.`),

  sticky('Note - Ranking', [2360, -340], 440, 230, 6,
`## Why reviews, not followers

Maps has no ad-spend signal, so ranking uses how
**established** the business is:

reviews (up to 30) · rating (only once 5+ reviews)
sponsored = paying for Google Ads (12) · has phone (8)
high-ticket category (8) · lead reason (6-10)

A rating means nothing on 2 reviews, so it is ignored
below 5. Review counts are read from the place page —
they are **not** in the list view at all.`),
);

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------
const main = (to, index) => ({ node: to, type: 'main', index: index || 0 });

const connections = {
  'Run Now': { main: [[main('Settings - Edit These')]] },
  'Run Weekly': { main: [[main('Settings - Edit These')]] },
  'Settings - Edit These': { main: [[main('Preflight - Browserless')]] },
  'Preflight - Browserless': { main: [[main('Build Search Job')]] },
  'Build Search Job': { main: [[main('Browserless - Search Maps')]] },
  'Browserless - Search Maps': { main: [[main('Filter No-Website')]] },
  'Filter No-Website': { main: [[main('Loop Places')]] },
  // output 0 = done, output 1 = next batch
  'Loop Places': { main: [[main('Confirm + Qualify')], [main('Build Detail Job')]] },
  'Build Detail Job': { main: [[main('Browserless - Place Details')]] },
  'Browserless - Place Details': { main: [[main('Parse Place Details')]] },
  'Parse Place Details': { main: [[main('Loop Places')]] },
  'Confirm + Qualify': { main: [[main('Needs Liveness Check?')]] },
  'Needs Liveness Check?': { main: [[main('Check Site Alive')], [main('Merge Lead Streams', 1)]] },
  'Check Site Alive': { main: [[main('Shape Site Response')]] },
  'Shape Site Response': { main: [[main('Classify Site Health')]] },
  'Classify Site Health': { main: [[main('Merge Lead Streams', 0)]] },
  'Merge Lead Streams': { main: [[main('Score + Rank')]] },
  'Score + Rank': { main: [[main('Read Ledger')]] },
  'Read Ledger': { main: [[main('Ledger From JSON')]] },
  'Ledger From JSON': { main: [[main('Tag New vs Seen')]] },
  'Tag New vs Seen': { main: [[main('Sort by Score')]] },
  'Sort by Score': { main: [[main('Build Outreach')]] },
  'Build Outreach': { main: [[main('Shape Rows')]] },
  'Shape Rows': { main: [[main('To CSV'), main('Append to Google Sheet')]] },
  'To CSV': { main: [[main('Save Leads CSV')]] },
  'Save Leads CSV': { main: [[main('Build Ledger')]] },
  'Build Ledger': { main: [[main('Ledger To File')]] },
  'Ledger To File': { main: [[main('Save Ledger')]] },
};

const workflow = {
  id: 'mapsLeadEngine',
  name: 'Google Maps → No-Website Leads',
  active: false,
  nodes,
  connections,
  settings: { executionOrder: 'v1' },
  pinData: {},
  meta: { instanceId: 'maps-lead-engine' },
  tags: [],
};

const outPath = path.join(ROOT, 'workflow', 'maps-lead-engine.json');
fs.writeFileSync(outPath, JSON.stringify(workflow, null, 2), 'utf8');
console.log('wrote ' + outPath);
console.log('  nodes: ' + nodes.length + '  connections: ' + Object.keys(connections).length);
console.log('  placeholder hosts: ' + PLACEHOLDER_HOSTS.length);
