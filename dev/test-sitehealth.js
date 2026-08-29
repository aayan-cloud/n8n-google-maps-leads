/**
 * Unit-tests "Classify Site Health".
 *
 * Only reached when a business lists a real custom domain on its place page. The bar is
 * deliberately high: a request that gets no answer is NOT proof the site is dead, because
 * plenty of live sites reject a plain server request with 403/503. Every inconclusive
 * case must fall back to "they have a site", i.e. not a lead.
 *
 *   node dev/test-sitehealth.js
 */
const path = require('path');
const wf = require(path.resolve(__dirname, '..', 'workflow', 'maps-lead-engine.json'));
const code = wf.nodes.find((n) => n.name === 'Classify Site Health').parameters.jsCode;

function classify(item) {
  const src = code.replace('return $input.all().map(', 'return ARGS.map(');
  // Sandbox parity: the n8n Code node has no URL global.
  return new Function('URL', 'ARGS', src)(undefined, [{ json: item }])[0].json;
}

const base = { name: 'X', websiteRaw: 'http://example.com/', leadReason: 'no_website' };

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log(' FAIL  ' + label + (detail ? ' — ' + detail : '')); }
};

const T = (name, patch, reason, siteCheck) => {
  const r = classify(Object.assign({}, base, patch));
  check(name, r.leadReason === reason && r.siteCheck === siteCheck,
    'got ' + r.leadReason + ' / ' + r.siteCheck);
};

// --- inconclusive must never become a lead ----------------------------------------------
T('timeout is inconclusive', { __statusCode: 0, __error: 'timeout of 25000ms exceeded' },
  'disqualified_has_site', 'inconclusive_transient');
T('temporary DNS failure is inconclusive', { __statusCode: 0, __error: 'getaddrinfo EAI_AGAIN shop.com' },
  'disqualified_has_site', 'inconclusive_transient');
T('connection reset is inconclusive', { __statusCode: 0, __error: 'read ECONNRESET' },
  'disqualified_has_site', 'inconclusive_transient');
T('connection refused is inconclusive', { __statusCode: 0, __error: 'connect ECONNREFUSED 1.2.3.4:443' },
  'disqualified_has_site', 'inconclusive_transient');
T('no status and no error is inconclusive', { __statusCode: 0, __error: '' },
  'disqualified_has_site', 'inconclusive_no_response');
T('403 bot-block is inconclusive', { __statusCode: 403 }, 'disqualified_has_site', 'inconclusive_403');
T('429 rate-limit is inconclusive', { __statusCode: 429 }, 'disqualified_has_site', 'inconclusive_429');
T('503 maintenance is inconclusive', { __statusCode: 503 }, 'disqualified_has_site', 'inconclusive_503');
T('500 is inconclusive', { __statusCode: 500 }, 'disqualified_has_site', 'inconclusive_500');

// --- genuinely dead ---------------------------------------------------------------------
T('domain does not resolve', { __statusCode: 0, __error: 'getaddrinfo ENOTFOUND gone-forever-xyz.com' },
  'dead_site', 'dns_not_found');
T('404', { __statusCode: 404 }, 'dead_site', 'http_404');
T('410', { __statusCode: 410 }, 'dead_site', 'http_410');
T('empty body on a 200', { __statusCode: 200, __body: '<html></html>' }, 'dead_site', 'empty_body');

const parked = classify(Object.assign({}, base, {
  __statusCode: 200, __body: 'x'.repeat(300) + ' This domain is for sale ' + 'y'.repeat(300),
}));
check('parked domain is dead', parked.leadReason === 'dead_site' && /^parked:/.test(parked.siteCheck),
  parked.siteCheck);

const redirected = classify(Object.assign({}, base, {
  __statusCode: 200, __finalUrl: 'https://www.facebook.com/somebiz', __body: 'x'.repeat(500),
}));
check('a "site" that redirects to Facebook is dead',
  redirected.leadReason === 'dead_site' && /^redirects_to:facebook\.com$/.test(redirected.siteCheck),
  redirected.siteCheck);

// --- a real, working site ---------------------------------------------------------------
const alive = classify(Object.assign({}, base, {
  __statusCode: 200, __body: '<html><body>' + 'Real content. '.repeat(60) + '</body></html>',
}));
check('a live site disqualifies the lead', alive.leadReason === 'disqualified_has_site', alive.leadReason);
check('  ...and records the status', alive.siteCheck === 'ok_200', alive.siteCheck);

// --- hygiene ----------------------------------------------------------------------------
check('scratch fields are stripped before the CSV',
  !('__statusCode' in alive) && !('__body' in alive) && !('__finalUrl' in alive) && !('__error' in alive),
  Object.keys(alive).filter((k) => k.indexOf('__') === 0).join(','));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
