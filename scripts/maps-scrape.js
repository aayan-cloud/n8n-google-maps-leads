/**
 * Scrape Google Maps local results and read whether each business has a website
 * straight from the result card.
 *
 * Runs inside Browserless (/function).
 *
 * The list view answers the website question only SOMETIMES. Measured live:
 *   Leeds / Lahore  cards render an action row - "Visit X's website", "Get directions"
 *   Phoenix / Dublin cards render name + stars + accessibility and nothing else
 *
 * A card with no action row is not a business without a website; it is a card that was
 * not asked to show one. Treating the two as the same made 41 of 63 Phoenix dentists look
 * like leads when every one checked had a site. So each business reports a websiteSignal
 * of 'has' / 'none' / 'unknown', and 'unknown' is resolved on the place page.
 *
 * Everything is read from structured aria-labels rather than guessed from card text,
 * because the text is ambiguous:
 *   "4.5 stars"          -> rating
 *   "Visit X's website"  -> they HAVE a website
 *   "Sponsored"          -> paying for Google Ads, i.e. proven budget
 *
 * Review counts are deliberately NOT collected: Maps does not render them in the list
 * view, and a regex over the card text matched street numbers instead, producing
 * confident nonsense like "54 reviews" for a business with none.
 *
 * context: { queries[], maxPerQuery, waitMs, lang }
 * returns: { ok, businesses[], perQuery[], notes[] }
 */
export default async function ({ page, context }) {
  const out = { ok: false, step: 'start', businesses: [], perQuery: [], notes: [] };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const queries = (context.queries || []).map((q) => String(q).trim()).filter(Boolean);
  const maxPer = Number(context.maxPerQuery || 60);
  const pacing = Number(context.waitMs || 2500);
  const lang = String(context.lang || 'en');

  try {
    // Headless Chrome announces itself in the UA and Google reacts to that.
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1500, height: 950 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': lang + '-US,' + lang + ';q=0.9' });

    const seen = {};

    for (const query of queries) {
      out.step = 'goto:' + query;
      const url = 'https://www.google.com/maps/search/' + encodeURIComponent(query) + '?hl=' + encodeURIComponent(lang);
      const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
      const status = resp ? resp.status() : 0;
      await wait(4000);

      // Consent wall (EU/UK) hides everything behind it. Reject is both the
      // privacy-preserving choice and enough to dismiss the wall.
      const consented = await page.evaluate(() => {
        const els = Array.prototype.slice.call(document.querySelectorAll('button, [role="button"]'));
        const clickIf = (test) => {
          for (const el of els) {
            const t = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')).trim().toLowerCase();
            if (test(t) && el.offsetParent !== null) { el.click(); return true; }
          }
          return false;
        };
        return clickIf((t) => t.indexOf('reject all') !== -1) ||
               clickIf((t) => t.indexOf('accept all') !== -1 || t.indexOf('i agree') !== -1);
      });
      if (consented) { out.notes.push('dismissed consent wall'); await wait(3000); }

      const blocked = await page.evaluate(() =>
        /unusual traffic|not a robot|detected unusual/i.test(document.body.innerText || ''));
      if (blocked) {
        out.perQuery.push({ query, status, found: 0, note: 'blocked by Google' });
        out.notes.push('blocked on "' + query + '"');
        continue;
      }

      // Results live in a scrollable side panel, so scrolling the window does nothing.
      out.step = 'scroll:' + query;
      const countCards = () => page.evaluate(() =>
        new Set(Array.prototype.slice.call(document.querySelectorAll('a[href*="/maps/place/"]'))
          .map((a) => a.getAttribute('aria-label') || '')).size);

      let stagnant = 0;
      let last = 0;
      for (let i = 0; i < 40 && stagnant < 4; i++) {
        await page.evaluate(() => {
          const feed = document.querySelector('div[role="feed"]');
          if (feed) feed.scrollTop = feed.scrollHeight;
          else window.scrollTo(0, document.body.scrollHeight);
        });
        await wait(1600);
        const n = await countCards();
        if (n >= maxPer) break;
        stagnant = n === last ? stagnant + 1 : 0;
        last = n;
      }

      out.step = 'extract:' + query;
      const rows = await page.evaluate(() => {
        // A card is the smallest ancestor of a place link that still contains only that
        // one place link. Walking further up swallows neighbouring results, which made
        // every business report the first result's website.
        const cardOf = (a) => {
          let el = a;
          for (let d = 0; d < 8 && el.parentElement; d++) {
            if (el.parentElement.querySelectorAll('a[href*="/maps/place/"]').length > 1) return el;
            el = el.parentElement;
          }
          return el;
        };

        const results = [];
        const seenName = {};

        Array.prototype.slice.call(document.querySelectorAll('a[href*="/maps/place/"]')).forEach((a) => {
          const name = (a.getAttribute('aria-label') || '').trim();
          if (!name || seenName[name]) return;
          seenName[name] = 1;

          const card = cardOf(a);
          const text = card.innerText || '';
          const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);

          const labels = Array.prototype.slice.call(card.querySelectorAll('[aria-label]'))
            .map((b) => b.getAttribute('aria-label') || '');

          let rating = null;
          for (const l of labels) {
            const m = l.match(/^([0-9.]+)\s+stars?$/i);
            if (m) { rating = Number(m[1]); break; }
          }

          const hasSiteLabel = labels.some((l) => /^Visit .+ website$/i.test(l));
          const sponsored = labels.some((l) => /^Sponsored$/i.test(l));

          // Whether the card rendered its action row at all. This is the difference
          // between "this business has no website" and "this layout is not telling me".
          // US results routinely render name + stars + accessibility and nothing else,
          // for businesses that certainly do have websites.
          const hasActionRow = labels.some((l) => /^(Get directions|Visit .+ website|Call )/i.test(l));

          // Outbound anchor that is not one of Google's own domains.
          const site = Array.prototype.slice.call(card.querySelectorAll('a[href]')).find((l) => {
            const h = l.getAttribute('href') || '';
            return /^https?:\/\//.test(h) && !/(^|\.)google\.[a-z.]+\//i.test(h);
          });

          // Ad cards carry no website button and no outbound link - the domain is printed
          // at the end of the ad copy instead:
          //   "Ad · Same-Day Appointment · Visit Site · therootcanalguy.com"
          // Missing this counted every advertiser as having no website, which is exactly
          // backwards: paying for Google Ads all but guarantees they have one.
          let adDomain = '';
          if (sponsored) {
            const adLabel = labels.find((l) => /(^|\s)Ad\s+·/.test(l) || /·\s*Visit Site\s*·/i.test(l)) || '';
            const parts = adLabel.split('·').map((x) => x.trim());
            for (let k = parts.length - 1; k >= 0; k--) {
              if (/^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/i.test(parts[k])) { adDomain = parts[k]; break; }
            }
          }

          // "Interior designer ·  · 59-U New" - category first, address last.
          const metaLine = lines.find((l) =>
            l.indexOf('·') !== -1 && !/^(Open|Closed|Opens|Closes)/i.test(l)) || '';
          const parts = metaLine.split('·').map((s) => s.trim()).filter(Boolean);

          const phoneM = text.match(/(\+?\d[\d\s()-]{7,}\d)/);

          const hasWebsite = Boolean(site || hasSiteLabel || adDomain);

          // Three states, not two. "unknown" is the honest answer when the card showed no
          // action row: it is not evidence of a missing website, so it must be resolved on
          // the place page rather than guessed at here.
          const websiteSignal = hasWebsite ? 'has' : (hasActionRow ? 'none' : 'unknown');

          results.push({
            name: name.slice(0, 120),
            mapsUrl: (a.getAttribute('href') || '').split('?')[0],
            website: site ? site.getAttribute('href') : (adDomain ? 'http://' + adDomain : ''),
            hasWebsite: hasWebsite,
            websiteSignal: websiteSignal,
            rating: rating,
            sponsored: sponsored,
            category: parts.length ? parts[0] : '',
            address: parts.length > 1 ? parts[parts.length - 1] : '',
            phone: phoneM ? phoneM[1].trim() : '',
          });
        });
        return results;
      });

      let added = 0;
      for (const r of rows) {
        const key = r.mapsUrl || r.name;
        if (seen[key]) continue;
        seen[key] = 1;
        r.query = query;
        out.businesses.push(r);
        added++;
      }
      out.perQuery.push({ query, status, found: rows.length, added });
      await wait(pacing);
    }

    out.ok = true;
    out.step = 'done';
  } catch (e) {
    out.notes.push('error at ' + out.step + ': ' + String(e && e.message ? e.message : e));
  }

  return { data: out, type: 'application/json' };
}
