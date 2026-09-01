# Setup

Three things, in order. The third one is the one that bites.

---

## 1. Browserless

The workflow drives a real Chrome to read Google Maps. Browserless is that Chrome.

```bash
docker run -d --name browserless -p 3004:3000 -e TOKEN=changeme-local-token ghcr.io/browserless/chromium
```

Check it answers:

```bash
curl "http://localhost:3004/json/version?token=changeme-local-token"
```

You should get a JSON blob naming a Chrome version. If you already run Browserless for the
Ad Library engine, it's the same container — nothing to do.

The workflow checks this before doing anything, and if it can't reach Browserless it stops
with the URL it tried rather than producing an empty run.

---

## 2. Import the workflow

n8n → **Workflows** → **Import from File** → `workflow/maps-lead-engine.json`.

Two nodes ship switched **off** on purpose:

- **Run Weekly** — turn it on once you're happy with the output.
- **Append to Google Sheet** — n8n validates required parameters *before* running, so an
  unconfigured Sheets node would abort the whole workflow before a single node fires.
  Enable it only after you've picked a document and sheet.

---

## 3. Let n8n write the CSV

n8n refuses to read or write outside an allow-list. If the output folder isn't on it, the
run gets all the way to the end and then fails with:

```
Access to the file is not allowed
```

The allow-list is the `N8N_RESTRICT_FILE_ACCESS_TO` environment variable — a
semicolon-separated list of folders.

**Two things matter here, and both have caused a wasted hour before:**

1. n8n reads it **once, at startup**. Changing it does nothing until you restart n8n.
2. On Windows, setting it in the registry (`[Environment]::SetEnvironmentVariable`) does
   **not** change any process that is already running, and does not reach a process
   started from a shell that was open beforehand. Checking the registry value is not the
   same as checking what n8n actually inherited.

### Windows

```powershell
$current = [Environment]::GetEnvironmentVariable('N8N_RESTRICT_FILE_ACCESS_TO','User')
$add     = 'C:\n8n-files\maps-leads'
if ($current -notlike "*$add*") {
  [Environment]::SetEnvironmentVariable('N8N_RESTRICT_FILE_ACCESS_TO', "$current;$add", 'User')
}
```

Then **fully close n8n and start it from a new terminal**, so it inherits the new value:

```powershell
$env:N8N_RESTRICT_FILE_ACCESS_TO = [Environment]::GetEnvironmentVariable('N8N_RESTRICT_FILE_ACCESS_TO','User')
n8n start
```

Setting `$env:` explicitly on that line is not redundant — it is the only part that
guarantees the running process actually has the value.

### The alternative

If you'd rather not restart n8n, point `outputFolder` and `ledgerFile` on the Settings
node at a folder already on the list (`C:\n8n_files`). Nothing else changes.

---

## Verifying without n8n

```bash
node dev/test-all.js                    # 340 assertions, needs nothing running
node dev/e2e.js "dentist" "Leeds" GB    # real run, needs Browserless
```

`dev/e2e.js` executes the same Code-node source the workflow uses, so a green run there
means the logic is sound and anything left is n8n plumbing.

---

## When something goes wrong

| Symptom | Cause |
| --- | --- |
| `Browserless did not answer at …` | container not running, or wrong token |
| `Access to the file is not allowed` | step 3 — and check you restarted n8n |
| `No businesses found` | niche or city misspelled, or the niche is too narrow |
| `"Pakistan" is a country, not a city` | Maps has no country filter — list the cities instead, comma-separated |
| All leads come from the first city | fixed: the place-page budget is now spread across cities in turn |
| `All … already have a website` | genuinely saturated niche — try another trade or city |
| `Nothing new` in the log, empty CSV | the ledger already gave you these; set `onlyNewLeads` to `false`, or change city |
| Run takes forever | `maxPlacesToCheck` — each place page is ~8 seconds |
| `#ERROR!` / `#NAME?` in a cell | fixed — phone numbers no longer carry a leading `+`, which Excel and Sheets read as a formula. Rows written before the fix keep the error: set `onlyNewLeads` to `false` and re-run, and the Sheets node overwrites them by `mapsUrl`. |
