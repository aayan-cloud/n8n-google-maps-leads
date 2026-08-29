# Google Maps → No-Website Leads

Finds local businesses that are **on Google Maps but have no website**, ranks them by how
established they are, and writes them to CSV with a WhatsApp link for each one.

Companion to the Ad Library engine, not a replacement:

|                  | Ad Library engine                  | This one                          |
| ---------------- | ---------------------------------- | --------------------------------- |
| Finds            | businesses **paying for Meta ads** | businesses **listed on Maps**     |
| Proves budget?   | yes — they are spending today      | only if the listing is Sponsored  |
| Volume           | low, high intent                   | high, broader                     |
| Ranks on         | ad spend signals                   | review count + rating             |
| Contact          | email / WhatsApp                   | phone → WhatsApp                  |

Maps gives far more leads per run; the Ad Library gives better ones. Run both.

Defaults ship pointed at the UK (`dog groomer, mobile car valeting` × Leeds + Manchester)
because that is a combination measured to actually produce leads — see
[which niches actually work](#which-niches-actually-work).

---

## What one run does

```
Maps search  ──►  68 businesses
                     │  read the website button on each card
                     ▼
                  ~15 with no website
                     │  drop duplicate listings of businesses that DO have a site
                     ▼
                  ~12 candidates
                     │  open each place page (~8s each)
                     ▼
                  review count · full address · phone
                  + a SECOND, independent website check
                     │
                     ▼
                  score → dedupe against the ledger → CSV
```

The second website check is the point of the whole design. A Maps card can omit the
website button on a listing that has one, and pitching a website to someone who already
has one is the worst thing this can do. When the card and the place page disagree, the
place page wins.

**Measured on a live run** (`dog groomer, mobile car valeting` × Leeds + Manchester):
17 confirmed leads, every one with a phone number, in ~4 minutes. Top of the list was a
groomer with 167 reviews, 4.9 stars, and no website.

---

## Setup

You need **Browserless** running. Nothing else — no API keys, no paid services.

```bash
docker run -d --name browserless -p 3004:3000 -e TOKEN=changeme-local-token ghcr.io/browserless/chromium
```

Then in n8n: **Import from File** → `workflow/maps-lead-engine.json`.

See [SETUP.md](SETUP.md) for the file-access setting n8n needs before it can write the CSV.

---

## Settings

Everything lives on the **Settings - Edit These** node. Nothing else needs touching.

| Setting | What it does |
| --- | --- |
| `niche` | What you search for. **Comma-separate to sweep several trades**: `dentist, orthodontist, physiotherapist` |
| `city` | **Maps has no country filter — the city IS the geography.** For a whole country, **list its cities**: `Lahore, Karachi, Islamabad`. A country name is rejected on purpose (see below). |
| `countryCode` | Only used to turn local phone numbers into working `wa.me` links. `PK`, `GB`, `US`… |
| `minReviews` | Quality floor, default `5`. See [Why not just set it to 100?](#why-not-just-set-minreviews-to-100) |
| `maxPerQuery` | How far to scroll the results list. 60 is about what Maps will give you. |
| `maxPlacesToCheck` | **The runtime dial.** Each place page costs ~8s, so 40 ≈ 5 minutes. Spread evenly across your cities, not spent on the first one. |
| `onlyNewLeads` | `true` hides businesses a previous run already produced. |
| `outputFolder` / `ledgerFile` | Where the CSV and the memory file go. |

`browserlessUrl` / `browserlessToken` only change if you moved Browserless.

### Why can't I just type a country?

Because Maps will let you, and then lie about it. Tested live: `interior designer Pakistan`
returned 67 businesses — **every one of them in Islamabad**. Maps quietly recentred on a
single city and still capped at ~60 results. You'd think you had covered a country and
actually covered one city, badly.

So the workflow rejects a country name and tells you to list cities instead. Niches
multiply by cities: `dentist, plumber` × `Leeds, York` = 4 searches.

The per-city budget matters here. `maxPlacesToCheck` is taken from each city **in turn**,
so a 2-city run capped at 8 checks 4 and 4 — not 8 from the first city and none from the
second. That was a real bug: the first two-city run returned 7 Lahore leads and 0 from
Karachi, and the best lead in the whole run (Al-Hammad Interiors, 110 reviews) was in the
half being thrown away.

### Which niches actually work

**This matters more than the country.** Measured live, same tool, same day:

| search | leads found |
| --- | --- |
| dentist, Phoenix | **0 out of 25 checked** — every one had a website |
| barber shop, Dublin | 1 out of 10 |
| nail salon, Birmingham | 2 out of 8 |
| barber shop, Leeds | 3 out of 8 |
| dog groomer, Phoenix | **6 out of 6** |
| mobile car valeting, Manchester | **8 out of 8** |
| dog groomer, Leeds | **8 out of 8** |

Anything with a receptionist and a marketing budget — dentists, solicitors, clinics,
estate agents — is saturated in the West. You will burn a whole run and find nothing.

What is wide open is **owner-operated trades**: dog groomers, mobile valeting, mobile
barbers, cleaners, gardeners, handymen, driving instructors, personal trainers, mobile
beauticians. One person who runs the business from a phone. They have a Google listing
because a customer made one, plenty of reviews, and no website.

The US works fine — Phoenix dog groomers were 6/6. It was the *niche* that was dead,
not the country.

### Why not just set minReviews to 100?

Because Maps reviews are not Instagram followers — the numbers are an order of magnitude
smaller. Measured on live Lahore runs:

| `minReviews` | leads kept |
| --- | --- |
| 0 | 100% |
| 5 | 62% |
| 20 | 38% |
| 100 | **8%** — one business out of thirteen |

A floor of 100 on Maps is roughly as aggressive as a floor of 10,000 followers.

Two things worth knowing before you raise it:

- **It does not save any time.** Review counts only exist on the place page, so the page is
  already open by the time the floor applies. It only trims the CSV.
- **The score already handles this.** Review count is the heaviest term in the ranking, so
  unreviewed businesses sink to the bottom on their own. The floor decides whether you see
  them at all, not whether they're ranked correctly.

---

## Output

`output/maps-leads-<cities>-<timestamp>.csv`

| Column | |
| --- | --- |
| `score` | higher = more established, more worth calling |
| `leadReason` | `no_website` · `placeholder_only` (only a Facebook/Linktree) · `dead_site` |
| `city` | which city's search found it — set per business, not per run |
| `rating` / `reviewCount` | read from the place page — the list view has no review count at all |
| `sponsored` | `YES` = paying for Google Ads, i.e. proven budget |
| `phone` / `phoneType` | `mobile` / `landline` / `unknown`. Written **without a leading `+`** (`44 7718 538734`): Excel and Sheets read a leading `+` as a formula and show `#ERROR!` instead of the number. |
| `waLink` | click to open WhatsApp with the number already dialled — **blank for a known landline**, because wa.me on a landline opens a chat nobody will ever read |
| `siteCheck` | why it counts as a lead, e.g. `no_site_listed`, `dns_not_found`, `placeholder:facebook.com` |
| `outreachStatus` | `READY_CALL`, or `NO_CHANNEL` when Maps listed no phone |
| `lastContacted` | left blank for you to fill in |

Sorted by score, best first.

Every text cell is written so a spreadsheet will not try to evaluate it. Excel and Google
Sheets treat a cell starting with `=`, `+`, `-` or `@` as a formula, which is why an
international phone number used to arrive as `#ERROR!`. Quoting the CSV does not help —
the spreadsheet parses the value after the CSV has been read — so the data itself is
written safe: phones drop the `+`, and any other text starting with those characters gets
a leading space.

### How the score works

Maps has no ad-spend number, so the ranking is a bet on **how established** a business is:

- **review count, up to 30 points** — the closest Maps gets to proven demand, and unlike
  followers it can't be bought cheaply in bulk
- **rating, up to 8** — but only counted once there are 5+ reviews. A 5.0 on two reviews
  is noise and scores nothing.
- **sponsored, 12** — they already pay Google for traffic
- **has a phone, 8** — the only channel Maps reliably gives you
- **high-ticket category, 8** — dental, legal, property, interiors, weddings…
- **lead reason, 6–10** — a dead site beats no site: they already decided they wanted one

---

## The ledger

`output/seen-places.json` remembers every business the workflow has ever produced, keyed
on its Maps place URL, so re-running the same search doesn't hand you the same names.

It is **deliberately separate** from the Ad Library ledger. The two workflows key on
different identifiers and are sold separately; sharing one file would let one product's
history corrupt the other's.

Delete it to start over.

---

## Before you use this

This scrapes a public website and produces a list of real businesses, including phone
numbers belonging to real people. A few things follow from that:

- **The `output/` folder is gitignored on purpose.** It contains names, addresses and
  personal mobile numbers. Don't commit it, don't publish it, don't pass it around.
- **Scraping Google Maps is against Google's Terms of Service.** They tolerate it at low
  volume; they will rate-limit or block you at high volume. The pacing in the browser
  scripts is deliberate — don't strip it out.
- **Cold contact is regulated.** In the UK and EU, calling a business that has registered
  with the CTPS is unlawful, and unsolicited marketing email needs a lawful basis under
  GDPR. Germany, Austria and Canada require prior opt-in for marketing email outright.
  Check your own jurisdiction before you contact anyone.
- **WhatsApp and Facebook both prohibit automated messaging.** The workflow gives you a
  `wa.me` link to click, not a sender, and that is on purpose. Automating the sending is
  a good way to lose the account.

The tool finds businesses. Contacting them well is your problem, and doing it badly is
your liability.

---

## Contributing

Two rules make changes reviewable:

1. **Never edit `workflow/maps-lead-engine.json` by hand.** It is generated. Edit
   `dev/build-workflow.js`, `scripts/` or `config/`, then run
   `node dev/build-workflow.js`.
2. **No backslash escapes in the Code-node source strings.** That source passes through
   two template literals on its way into the node, and a `\s` arrives one backslash
   short. This has caused three separate live bugs: `/^[0-9]/` became `/^[d]/` and
   matched nothing, `/\s+/` became `/s+/` and split business names on the letter S,
   and `/^\//` became a comment. Use character classes or plain string operations.

`node dev/test-all.js` must stay green. It needs nothing running.

---

## Development

```bash
node dev/build-workflow.js   # regenerate the workflow from scripts/ and config/
node dev/test-all.js         # 234 assertions, no n8n or Browserless needed
node dev/e2e.js "dentist" "Leeds, York" GB   # real end-to-end run outside n8n
```

`dev/e2e.js` runs the **actual Code-node source** from the generated workflow against live
Maps and live websites, stubbing only n8n's plumbing. Use it to verify a change without
clicking through the UI.

The browser scripts in `scripts/` are the source of truth and get inlined into the Code
nodes by the generator — edit them there, never in the exported JSON.
