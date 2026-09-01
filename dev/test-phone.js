/**
 * Unit-tests "Build Outreach".
 *
 * Maps leads are phone-first: Google lists a number far more often than an email. So the
 * wa.me link is the deliverable, and a wa.me link with the wrong country code opens
 * nothing at all — a silent failure the user only discovers by clicking.
 *
 *   node dev/test-phone.js
 */
const path = require('path');
const wf = require(path.resolve(__dirname, '..', 'workflow', 'maps-lead-engine.json'));
const code = wf.nodes.find((n) => n.name === 'Build Outreach').parameters.jsCode;

function run(countryCode, leads) {
  const src = code
    .replace("const s = $('Settings - Edit These').first().json;", 'const s = ARGS.settings;')
    .replace('return $input.all().map(', 'return ARGS.leads.map(');
  return new Function('ARGS', src)({
    settings: { countryCode },
    leads: leads.map((json) => ({ json })),
  }).map((i) => i.json);
}
const withPhone = (cc, phone) => run(cc, [{ name: 'X', phone }])[0];

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log(' FAIL  ' + label + (detail ? ' — ' + detail : '')); }
};

// --- national numbers gain their country code -------------------------------------------
const CASES = [
  ['PK', '0300 123 7862', '923001237862'],
  ['GB', '07729 824809', '447729824809'],
  ['GB', '0121 798 1628', '441217981628'],
  ['US', '(480) 233-4518', '14802334518'],
  ['AU', '0400 111 222', '61400111222'],
  ['IN', '92059 66347', '919205966347'],
  ['AE', '050 123 4567', '971501234567'],
];
for (const [cc, phone, expected] of CASES) {
  const r = withPhone(cc, phone);
  check(cc + ' ' + phone + ' -> ' + expected, r.waNumber === expected, 'got ' + r.waNumber);
}

// --- already-international numbers must not be double-prefixed --------------------------
check('a +44 number is left alone', withPhone('GB', '+44 20 7946 0000').waNumber === '442079460000',
  withPhone('GB', '+44 20 7946 0000').waNumber);
check('a +92 number is left alone', withPhone('PK', '+92 300 1237862').waNumber === '923001237862',
  withPhone('PK', '+92 300 1237862').waNumber);

// The trap from the Ad Library runs: a 10-digit Indian mobile that merely BEGINS with 91
// looks international but is not, and produced a wa.me link with no country code.
check('10-digit IN mobile starting 91 still gets its country code',
  withPhone('IN', '9124130435').waNumber === '919124130435', withPhone('IN', '9124130435').waNumber);
check('SG 8-digit international number is not double-prefixed',
  withPhone('SG', '6561234567').waNumber === '6561234567', withPhone('SG', '6561234567').waNumber);

// --- link shape --------------------------------------------------------------------------
const pk = withPhone('PK', '0300 123 7862');
check('waLink opens a chat with the international number',
  pk.waLink === 'https://wa.me/923001237862', pk.waLink);
check('a reachable lead is READY_CALL', pk.outreachStatus === 'READY_CALL', pk.outreachStatus);

// --- landlines must not get a WhatsApp link ------------------------------------------------
// Western businesses list landlines far more than the markets this was first built for, and
// wa.me on a landline opens a chat nobody reads - worse than no link, because it looks like
// a channel. Found live: Clarke's Dogs, Manchester, +44 161 300 1627.
const landline = withPhone('GB', '0161 300 1627');
check('a UK landline is identified', landline.phoneType === 'landline', landline.phoneType);
check('  ...and gets NO WhatsApp link', landline.waLink === '', JSON.stringify(landline.waLink));
check('  ...but is still worth calling', landline.outreachStatus === 'READY_CALL');
check('  ...and keeps the international number for the dialler',
  landline.waNumber === '441613001627', landline.waNumber);

const mobile = withPhone('GB', '07718 538734');
check('a UK mobile is identified', mobile.phoneType === 'mobile', mobile.phoneType);
check('  ...and does get a WhatsApp link', mobile.waLink === 'https://wa.me/447718538734', mobile.waLink);

const MOBILES = [['IE','085 133 8383'],['DE','0151 23456789'],['FR','06 12 34 56 78'],
  ['ES','612 345 678'],['IT','345 678 9012'],['NL','06 12345678'],['AU','0400 111 222']];
for (const [cc, num] of MOBILES) {
  check(cc + ' mobile ' + num + ' gets a link', withPhone(cc, num).waLink !== '',
    withPhone(cc, num).phoneType);
}
const LANDLINES = [['IE','01 234 5678'],['DE','030 12345678'],['FR','01 42 34 56 78'],['NL','020 1234567']];
for (const [cc, num] of LANDLINES) {
  check(cc + ' landline ' + num + ' gets no link', withPhone(cc, num).waLink === '',
    withPhone(cc, num).phoneType);
}

// The US and Canada share one numbering plan for mobile and fixed lines, so there is
// nothing to read. Guessing would drop real mobiles, so the link stays.
const us = withPhone('US', '(480) 233-4518');
check('US numbers are not guessed at', us.phoneType === 'unknown', us.phoneType);
check('  ...and keep their link rather than lose a real mobile', us.waLink !== '');

// An already-international number must classify the same as its national form.
check('an international GB landline still reads as a landline',
  withPhone('GB', '+44 161 300 1627').phoneType === 'landline',
  withPhone('GB', '+44 161 300 1627').phoneType);
check('an international GB mobile still reads as a mobile',
  withPhone('GB', '+44 7718 538734').phoneType === 'mobile',
  withPhone('GB', '+44 7718 538734').phoneType);

// --- countries that were reading as "unknown" ----------------------------------------------------
// Every one of these produced no phoneType at all before, so a run could not tell a mobile
// from a landline. Found live on a Rawalpindi run.
const MOBILES_2 = [
  ['PK', '92 335 5247894', 'Pakistan mobile'],
  ['PK', '0300 1237862', 'Pakistan mobile, local format'],
  ['IN', '92059 66347', 'India'],
  ['AE', '050 123 4567', 'UAE'],
  ['ZA', '082 123 4567', 'South Africa'],
  ['NG', '0803 123 4567', 'Nigeria'],
  ['SG', '9123 4567', 'Singapore'],
  ['TR', '0532 123 4567', 'Turkey'],
];
for (const [cc, num, label] of MOBILES_2) {
  const r = withPhone(cc, num);
  check(label + ' reads as mobile', r.phoneType === 'mobile', r.phoneType);
  check('  ...and gets a link', r.waLink !== '');
}

const LANDLINES_2 = [
  ['PK', '92 51 4575930', 'Islamabad landline'],
  ['PK', '042 111 2222', 'Lahore landline'],
  ['IN', '011 2345 6789', 'Delhi landline'],
  ['ZA', '021 123 4567', 'Cape Town landline'],
];
for (const [cc, num, label] of LANDLINES_2) {
  const r = withPhone(cc, num);
  check(label + ' reads as landline', r.phoneType === 'landline', r.phoneType);
  check('  ...and gets no link, since WhatsApp would never reach it', r.waLink === '');
}

// Left as "unknown" on purpose: these numbering plans do not separate mobile from fixed
// by prefix, and guessing would drop real mobiles.
for (const cc of ['US', 'CA', 'BR', 'JP']) {
  const r = withPhone(cc, '480 233 4518');
  check(cc + ' is not guessed at', r.phoneType === 'unknown', r.phoneType);
  check('  ...and keeps its link', r.waLink !== '');
}

// --- failure modes -----------------------------------------------------------------------
const none = run('PK', [{ name: 'X', phone: '' }])[0];
check('no phone -> NO_CHANNEL', none.outreachStatus === 'NO_CHANNEL', none.outreachStatus);
check('no phone -> no link rather than a broken one', none.waLink === '', JSON.stringify(none.waLink));

// An unrecognised country must not produce wa.me/03001237862, which silently opens nothing.
const unknown = withPhone('XX', '0300 123 7862');
check('unknown country emits NO waLink', unknown.waLink === '', JSON.stringify(unknown.waLink));
check('  ...but still keeps the number for calling', unknown.outreachStatus === 'READY_CALL',
  unknown.outreachStatus);

// Case and whitespace on the settings field are a user typo, not a failure.
const lower = run('pk', [{ name: 'X', phone: '0300 123 7862' }])[0];
check('lowercase countryCode still works', lower.waNumber === '923001237862', lower.waNumber);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
