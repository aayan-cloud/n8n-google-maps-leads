/**
 * Dev harness: POST a Browserless script to the local instance and print the result.
 *
 *   node dev/run.js scripts/search-scrape.js '{"country":"IN","phrase":"walk-ins welcome"}'
 *
 * Exists only for iterating on the browser scripts outside n8n. The workflow itself
 * inlines the same script text into a Code node, so this file is not needed at runtime.
 */
const fs = require('fs');
const path = require('path');

const BROWSERLESS_URL = process.env.BROWSERLESS_URL || 'http://localhost:3004';
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || 'changeme-local-token';

const scriptPath = process.argv[2];
const context = process.argv[3] ? JSON.parse(process.argv[3]) : {};

if (!scriptPath) {
  console.error('usage: node dev/run.js <script.js> [contextJson]');
  process.exit(1);
}

const code = fs.readFileSync(path.resolve(scriptPath), 'utf8');

(async () => {
  const started = Date.now();
  const res = await fetch(`${BROWSERLESS_URL}/function?token=${BROWSERLESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, context }),
  });

  const text = await res.text();
  console.error(`[${res.status}] ${((Date.now() - started) / 1000).toFixed(1)}s`);

  try {
    console.log(JSON.stringify(JSON.parse(text), null, 1));
  } catch {
    console.log(text.slice(0, 4000));
  }
})();
