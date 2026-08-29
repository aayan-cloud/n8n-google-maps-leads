/**
 * Unit-tests "Score + Rank".
 *
 * Maps has no ad-spend number, so the ranking is a claim about which signals actually
 * predict a business worth calling. These tests pin that claim down:
 *   - review count outranks everything else
 *   - a rating on 2 reviews is noise and must not move the score
 *   - a business that already has a working site never appears at any score
 *
 *   node dev/test-scoring.js
 */
const path = require('path');
const wf = require(path.resolve(__dirname, '..', 'workflow', 'maps-lead-engine.json'));
const code = wf.nodes.find((n) => n.name === 'Score + Rank').parameters.jsCode;

function score(leads) {
  const src = code.replace('const rows = $input.all()', 'const rows = ARGS');
  return new Function('ARGS', 'console', src)(
    leads.map((json) => ({ json })), { log: () => {} }
  ).map((i) => i.json);
}
const one = (over) => score([lead(over)])[0];

const lead = (over) => Object.assign({
  name: 'X', mapsUrl: 'https://maps.google.com/x', leadReason: 'no_website',
  rating: 0, reviewCount: 0, sponsored: false, phone: '', category: '',
}, over);

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log(' FAIL  ' + label + (detail ? ' — ' + detail : '')); }
};

// --- who is excluded entirely -----------------------------------------------------------
check('a business with a working site never scores',
  score([lead({ leadReason: 'disqualified_has_site' })]).length === 0);
check('an unverified place page never scores',
  score([lead({ leadReason: 'unverified' })]).length === 0);
check('a dead site does score', score([lead({ leadReason: 'dead_site' })]).length === 1);
check('a placeholder-only business does score',
  score([lead({ leadReason: 'placeholder_only' })]).length === 1);

// --- reviews dominate -------------------------------------------------------------------
const byReviews = [0, 1, 5, 20, 50, 100, 200].map((n) => one({ reviewCount: n }).score);
check('score rises monotonically with review count',
  byReviews.every((v, i) => i === 0 || v >= byReviews[i - 1]), byReviews.join(' < '));
check('200 reviews beats 0 reviews by a wide margin',
  byReviews[6] - byReviews[0] >= 30, 'gap ' + (byReviews[6] - byReviews[0]));

// Reviews must outweigh every other single signal, or a sponsored 1-review shell
// outranks an established 100-review business.
const established = one({ reviewCount: 100, rating: 4.8 });
const shell = one({ reviewCount: 1, sponsored: true, phone: '0300', category: 'dental clinic' });
check('100-review business outranks a sponsored 1-review shell',
  established.score > shell.score, established.score + ' vs ' + shell.score);

// --- rating is ignored on thin evidence -------------------------------------------------
const fiveStarThin = one({ reviewCount: 2, rating: 5 });
const noRatingThin = one({ reviewCount: 2, rating: 0 });
check('a 5.0 rating on 2 reviews adds nothing',
  fiveStarThin.score === noRatingThin.score, fiveStarThin.score + ' vs ' + noRatingThin.score);

const fiveStarReal = one({ reviewCount: 50, rating: 4.8 });
const lowStarReal = one({ reviewCount: 50, rating: 3.0 });
check('once there are 50 reviews the rating does count',
  fiveStarReal.score > lowStarReal.score, fiveStarReal.score + ' vs ' + lowStarReal.score);

// --- proven budget ----------------------------------------------------------------------
check('paying for Google Ads adds score',
  one({ sponsored: true }).score > one({ sponsored: false }).score);
check('a phone number adds score (it is the only channel Maps reliably gives)',
  one({ phone: '042 111 2222' }).score > one({ phone: '' }).score);
check('flags reachability for the CSV', one({ phone: '042 111 2222' }).isReachable === true);

// --- category ---------------------------------------------------------------------------
check('high-ticket category adds score',
  one({ category: 'Dental clinic' }).score > one({ category: 'Grocery store' }).score);
check('  ...and is flagged', one({ category: 'Interior designer' }).isHighTicket === true);
check('matching is case-insensitive', one({ category: 'INTERIOR ARCHITECT' }).isHighTicket === true);
check('an ordinary category is not flagged', one({ category: 'Grocery store' }).isHighTicket === false);

// --- reasons ----------------------------------------------------------------------------
check('a dead site scores above an unlisted one at equal evidence',
  one({ leadReason: 'dead_site' }).score > one({ leadReason: 'no_website' }).score);

// --- missing data must never crash ------------------------------------------------------
const sparse = score([{ leadReason: 'no_website', mapsUrl: 'u' }])[0];
check('a lead with null rating and no fields still scores',
  typeof sparse.score === 'number' && !isNaN(sparse.score), JSON.stringify(sparse.score));
const nullRating = one({ rating: null, reviewCount: 30 });
check('null rating does not poison the score',
  typeof nullRating.score === 'number' && !isNaN(nullRating.score), String(nullRating.score));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
