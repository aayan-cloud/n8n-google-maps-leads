/**
 * Unit-tests the root-vs-profile rule inside "Confirm + Qualify".
 *
 * A directory or social host on the placeholder list means "they have no site of their
 * own" only when the URL points at a PAGE on that host. The bare root means the opposite:
 * they own the domain, so they ARE the platform.
 *
 * Found live: MyBuilder advertising https://www.mybuilder.com/ shipped as a
 * placeholder_only lead - a 98,000-follower directory company being pitched a website.
 *
 *   node dev/test-placeholder-url.js
 */
const path = require('path');
const wf = require(path.resolve(__dirname, '..', 'workflow', 'maps-lead-engine.json'));
const src = wf.nodes.find((n) => n.name === 'Confirm + Qualify').parameters.jsCode;

// Pull the helpers out of the SHIPPED node source, so this tests what actually runs.
const helpers = new Function('URL', 'return (function(){' +
  src.replace("const s = $('Settings - Edit These').first().json;", "const s = { city: \"X\", minReviews: 0 };")
     .replace("const rows = $input.all().filter(", "const rows = [].filter(")
     .split('return rows.map')[0] +
  ' return { isPlaceholderUrl: isPlaceholderUrl, isPlaceholderHost: isPlaceholderHost, hostOf: hostOf, httpsForm: httpsForm };})()'
)(undefined);

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log(' FAIL  ' + label + (detail ? ' — ' + detail : '')); }
};

// [url, isPlaceholder, why]
const CASES = [
  // The regression: the platform itself, not a profile on it.
  ['https://www.mybuilder.com/', false, 'MyBuilder itself owns mybuilder.com'],
  ['https://www.mybuilder.com', false, 'same, without the trailing slash'],
  ['https://www.mybuilder.com/?utm_source=fb', false, 'root carrying tracking params'],
  ['https://www.mybuilder.com/#top', false, 'root with a fragment'],
  ['https://www.yell.com/', false, 'Yell itself'],
  ['https://www.facebook.com/', false, 'the Facebook front door'],

  // Still placeholders: a page belonging to someone else's platform.
  ['https://www.mybuilder.com/profile/view/12345', true, 'a tradesman profile ON MyBuilder'],
  ['https://www.checkatrade.com/trades/AJPlumbing', true, 'a Checkatrade profile'],
  ['https://yell.com/biz/plumber-leeds-123', true, 'a Yell listing'],
  ['https://www.facebook.com/MyBuilder', true, 'a Facebook page'],
  ['https://instagram.com/somebiz', true, 'an Instagram profile'],
  ['https://linktr.ee/somebiz', true, 'a Linktree'],
  ['https://wa.me/447718538734', true, 'a WhatsApp link'],

  // Ordinary websites are never placeholders either way.
  ['https://muckypups.co.uk/', false, 'an ordinary real website'],
  ['https://stellarossadesign.co.uk', false, 'a real custom domain'],
  ['', false, 'no website at all'],
];

for (const [url, expected, why] of CASES) {
  const got = helpers.isPlaceholderUrl(url);
  check((expected ? 'placeholder: ' : 'real site:   ') + (url || '(empty)') + '  — ' + why,
    got === expected, 'got ' + got);
}

// The host list itself must be unchanged - a plumber whose only presence is a MyBuilder
// profile is still a real lead, so the host has to stay ON the list.
check('mybuilder.com is still a placeholder HOST', helpers.isPlaceholderHost('mybuilder.com'));
check('checkatrade.com is still a placeholder HOST', helpers.isPlaceholderHost('checkatrade.com'));
check('an ordinary domain is not', helpers.isPlaceholderHost('muckypups.co.uk') === false);

// Subdomains of a placeholder host follow the same rule.
check('a subdomain root is still theirs', helpers.isPlaceholderUrl('https://business.facebook.com/') === false);
check('a subdomain page is a placeholder', helpers.isPlaceholderUrl('https://business.facebook.com/x') === true);


// --- http:// URLs are checked over https ---------------------------------------------------
// Facebook and Maps hand back URLs typed years ago. Found live: Miller Homes listed
// http://www.millerhomes.co.uk/ which genuinely 404s, while https:// serves a 282KB site -
// a national housebuilder shipped as a dead_site lead.
const HTTPS_CASES = [
  ['http://www.millerhomes.co.uk/', 'https://www.millerhomes.co.uk/', 'the regression'],
  ['HTTP://Example.com/path', 'https://Example.com/path', 'uppercase scheme'],
  ['https://already.com/', 'https://already.com/', 'already https, untouched'],
  ['  http://spaced.com  ', 'https://spaced.com', 'surrounding whitespace'],
  ['', '', 'no website'],
  ['ftp://weird.com', 'ftp://weird.com', 'a scheme we do not rewrite'],
  ['example.com', 'example.com', 'no scheme at all'],
];
for (const [input, expected, why] of HTTPS_CASES) {
  check('httpsForm(' + JSON.stringify(input) + ') — ' + why,
    helpers.httpsForm(input) === expected, JSON.stringify(helpers.httpsForm(input)));
}
check('http inside the path is not rewritten',
  helpers.httpsForm('https://x.com/?u=http://y.com') === 'https://x.com/?u=http://y.com',
  helpers.httpsForm('https://x.com/?u=http://y.com'));

console.log();
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
