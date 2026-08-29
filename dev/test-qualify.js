/**
 * Unit-tests "Confirm + Qualify" — the node that decides who is actually a lead.
 *
 * This is the node that earns the extra ~7.6s per place. The list view says "no website
 * button on the card"; the place page is a second, independent read. When they disagree,
 * the place page wins, because pitching a website to someone who already has one is the
 * single worst failure mode this workflow has.
 *
 *   node dev/test-qualify.js
 */
const path = require('path');
const wf = require(path.resolve(__dirname, '..', 'workflow', 'maps-lead-engine.json'));
const code = wf.nodes.find((n) => n.name === 'Confirm + Qualify').parameters.jsCode;

function qualify(settings, places) {
  const src = code
    .replace("const s = $('Settings - Edit These').first().json;", 'const s = ARGS.settings;')
    .replace('const rows = $input.all().filter(', 'const rows = ARGS.places.filter(');
  // Sandbox parity: the n8n Code node has no URL global, so anything relying on it
  // would silently produce empty hosts here too.
  return new Function('URL', 'ARGS', 'console', src)(
    undefined,
    { settings, places: places.map((json) => ({ json })) },
    { log: () => {} }
  ).map((i) => i.json);
}

const S = (over) => Object.assign({ city: 'Lahore', minReviews: 0 }, over);
const place = (over) => Object.assign({
  name: 'X', mapsUrl: 'https://maps.google.com/x', rating: 4.5, reviewCount: 20,
  websiteRaw: '', hasWebsite: false, detailError: '',
}, over);

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log(' FAIL  ' + label + (detail ? ' — ' + detail : '')); }
};

// --- the whole point of stage 2 ---------------------------------------------------------
const dropped = qualify(S(), [place({ hasWebsite: true, websiteRaw: 'https://realsite.com' })]);
check('place page shows a website -> dropped, not pitched', dropped.length === 0,
  dropped.length + ' survived');

const kept = qualify(S(), [place()]);
check('no website on the place page -> kept as no_website',
  kept.length === 1 && kept[0].leadReason === 'no_website', JSON.stringify(kept[0] && kept[0].leadReason));
check('carries the city through for the CSV', kept[0].city === 'Lahore');
check('does not ask for a liveness check when there is no site', kept[0].needsLivenessCheck === false);

// --- placeholder "websites" -------------------------------------------------------------
// A Facebook page or a Linktree is not a website; these are still leads, tagged so the
// pitch can name what they actually have.
const PLACEHOLDERS = [
  ['facebook page', 'https://www.facebook.com/somebiz'],
  ['instagram', 'https://instagram.com/somebiz'],
  ['linktree', 'https://linktr.ee/somebiz'],
  ['wa.me link', 'https://wa.me/923001234567'],
];
for (const [label, url] of PLACEHOLDERS) {
  const r = qualify(S(), [place({ hasWebsite: false, websiteRaw: url })])[0];
  check('treats ' + label + ' as placeholder_only',
    r && r.leadReason === 'placeholder_only', r && r.leadReason);
  check('  ...and skips the liveness check for it', r && r.needsLivenessCheck === false);
}

// A real custom domain must be verified before it counts, not assumed dead.
const custom = qualify(S(), [place({ websiteRaw: 'https://stellarossadesign.co.uk' })])[0];
check('custom domain is routed to the liveness check', custom.needsLivenessCheck === true);
check('  ...and is NOT pre-labelled a lead', custom.leadReason === 'no_website');
check('host is parsed without the URL global', custom.websiteHost === 'stellarossadesign.co.uk',
  'got "' + custom.websiteHost + '"');

// --- host parsing edge cases (this is where the URL-global bug hid) ----------------------
const HOSTS = [
  ['http://WWW.Facebook.COM/x', 'facebook.com'],
  ['https://m.facebook.com/x', 'm.facebook.com'],
  ['https://user:pw@example.com:8080/p?q=1', 'example.com'],
  ['example.com/path', 'example.com'],
];
for (const [input, expected] of HOSTS) {
  const r = qualify(S(), [place({ websiteRaw: input })])[0];
  check('parses ' + input + ' -> ' + expected, r.websiteHost === expected, 'got "' + r.websiteHost + '"');
}
// Subdomain matching must work, or business.facebook.com slips through as a real site.
const sub = qualify(S(), [place({ websiteRaw: 'https://business.facebook.com/x' })])[0];
check('subdomain of a placeholder host still counts as placeholder',
  sub.leadReason === 'placeholder_only', sub.leadReason);

// --- quality floor ----------------------------------------------------------------------
const thin = qualify(S({ minReviews: 10 }), [
  place({ name: 'thin', reviewCount: 3 }),
  place({ name: 'solid', mapsUrl: 'https://maps.google.com/y', reviewCount: 40 }),
]);
check('minReviews drops the thin listing', thin.length === 1 && thin[0].name === 'solid',
  JSON.stringify(thin.map((r) => r.name)));

const zeroFloor = qualify(S({ minReviews: 0 }), [place({ reviewCount: 0 })]);
check('minReviews=0 keeps a brand-new business', zeroFloor.length === 1);

// --- unreadable place pages -------------------------------------------------------------
// The Ad Library version learned this the hard way: an advertiser whose page could not be
// read was tagged no_website and pitched. Absence of evidence is not evidence of absence.
const broken = qualify(S(), [place({ detailError: 'Navigation timeout of 60000 ms exceeded' })])[0];
check('unreadable place page is tagged unverified, not no_website',
  broken.leadReason === 'unverified', broken.leadReason);
check('  ...and says why', broken.siteCheck === 'place_page_not_readable', broken.siteCheck);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
