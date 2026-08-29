/**
 * Structural checks on the generated workflow.
 *
 * The logic tests import individual Code nodes and so cannot see a mis-wired graph. These
 * assertions catch the failures that only appear on import: a dangling connection, the
 * SplitInBatches loop wired to the wrong output, or a required parameter that makes n8n
 * refuse to start the run at all.
 *
 *   node dev/test-wiring.js
 */
const path = require('path');
const wf = require(path.resolve(__dirname, '..', 'workflow', 'maps-lead-engine.json'));

const byName = {};
for (const n of wf.nodes) byName[n.name] = n;

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log(' FAIL  ' + label + (detail ? ' — ' + detail : '')); }
};

// --- every connection must point at a node that exists -----------------------------------
const dangling = [];
for (const [from, conn] of Object.entries(wf.connections)) {
  if (!byName[from]) dangling.push('source ' + from);
  for (const outputs of Object.values(conn)) {
    for (const branch of outputs) {
      for (const c of branch) if (!byName[c.node]) dangling.push(from + ' -> ' + c.node);
    }
  }
}
check('no connection points at a missing node', dangling.length === 0, dangling.join(', '));

// --- every node must be reachable from a trigger -----------------------------------------
const reachable = new Set(['Run Now', 'Run Weekly']);
let grew = true;
while (grew) {
  grew = false;
  for (const [from, conn] of Object.entries(wf.connections)) {
    if (!reachable.has(from)) continue;
    for (const outputs of Object.values(conn)) {
      for (const branch of outputs) {
        for (const c of branch) if (!reachable.has(c.node)) { reachable.add(c.node); grew = true; }
      }
    }
  }
}
const orphans = wf.nodes
  .filter((n) => n.type !== 'n8n-nodes-base.stickyNote' && !reachable.has(n.name))
  .map((n) => n.name);
check('every node is reachable from a trigger', orphans.length === 0, orphans.join(', '));

// --- the two-stage loop ------------------------------------------------------------------
// SplitInBatches output 0 is "done" and output 1 is "loop". Swapping them is the classic
// mistake: the workflow appears to run, then finishes having checked nothing.
const loop = wf.connections['Loop Places'].main;
check('Loop Places "done" (output 0) goes to Confirm + Qualify',
  loop[0][0].node === 'Confirm + Qualify', loop[0][0].node);
check('Loop Places "loop" (output 1) goes to Build Detail Job',
  loop[1][0].node === 'Build Detail Job', loop[1][0].node);
check('the detail branch feeds back into the loop',
  wf.connections['Parse Place Details'].main[0][0].node === 'Loop Places',
  wf.connections['Parse Place Details'].main[0][0].node);

// --- the liveness branch merges back -----------------------------------------------------
const iff = wf.connections['Needs Liveness Check?'].main;
check('the IF true branch runs the liveness check', iff[0][0].node === 'Check Site Alive', iff[0][0].node);
check('the IF false branch skips straight to the merge',
  iff[1][0].node === 'Merge Lead Streams' && iff[1][0].index === 1,
  JSON.stringify(iff[1][0]));
check('the checked branch merges on input 0',
  wf.connections['Classify Site Health'].main[0][0].index === 0);
check('the merge is declared with two inputs',
  byName['Merge Lead Streams'].parameters.numberInputs === 2);

// --- nodes that must tolerate failure ----------------------------------------------------
// Read Ledger fails by design on the very first run, when the file does not exist yet.
for (const name of ['Preflight - Browserless', 'Read Ledger', 'Ledger From JSON', 'Check Site Alive']) {
  check(name + ' continues on error', byName[name].onError === 'continueRegularOutput');
  check('  ...and still emits an item', byName[name].alwaysOutputData === true);
}

// --- things that must ship off -----------------------------------------------------------
// n8n validates required parameters BEFORE executing, so an unconfigured Sheets node
// aborts the whole run before a single node fires.
check('Google Sheets ships disabled', byName['Append to Google Sheet'].disabled === true);
check('the weekly schedule ships disabled', byName['Run Weekly'].disabled === true);
check('the workflow itself ships inactive', wf.active === false);
check('phone numbers are written RAW so a leading + is not read as a formula',
  byName['Append to Google Sheet'].parameters.options.cellFormat === 'RAW');

// --- the URL-global trap -----------------------------------------------------------------
// The n8n Code node sandbox has no URL global. Calling it throws, every host comes back
// empty, and placeholder matching silently stops working with no error anywhere.
const usesURL = wf.nodes
  .filter((n) => n.type === 'n8n-nodes-base.code')
  // Comments mention it on purpose, so strip them before looking for a real call.
  .filter((n) => /new\s+URL\s*\(/.test(n.parameters.jsCode.replace(/^\s*\/\/.*$/gm, '')))
  .map((n) => n.name);
check('no Code node calls new URL()', usesURL.length === 0, usesURL.join(', '));

// --- settings the user is expected to edit -----------------------------------------------
const assigns = byName['Settings - Edit These'].parameters.assignments.assignments;
const names = assigns.map((a) => a.name);
for (const required of ['niche', 'city', 'countryCode', 'minReviews', 'maxPerQuery',
  'maxPlacesToCheck', 'browserlessUrl', 'browserlessToken', 'outputFolder', 'ledgerFile',
  'onlyNewLeads']) {
  check('Settings exposes ' + required, names.indexOf(required) !== -1);
}
check('no setting is declared twice', new Set(names).size === names.length);
// Shipping a path from the author's own machine is the classic open-source leak: it
// exposes a username and fails for everyone else.
const outFolder = String(assigns.find((a) => a.name === 'outputFolder').value);
const lowerOut = outFolder.toLowerCase();
check('the output folder is not a path from one person\'s machine',
  lowerOut.indexOf('users/') === -1 && lowerOut.indexOf('users\\') === -1 &&
  lowerOut.indexOf('documents') === -1, outFolder);
check('  ...and the ledger sits alongside it',
  String(assigns.find((a) => a.name === 'ledgerFile').value).indexOf(outFolder) === 0,
  assigns.find((a) => a.name === 'ledgerFile').value);

// --- ids -----------------------------------------------------------------------------------
const ids = wf.nodes.map((n) => n.id);
check('every node id is unique', new Set(ids).size === ids.length);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
