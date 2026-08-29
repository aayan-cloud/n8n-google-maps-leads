/**
 * Stage 2 - open each candidate's Google Maps place page and read the real detail.
 *
 * Only businesses that showed NO website in the list are sent here, so the cost is paid
 * on leads rather than on all results: ~7.6s per place, roughly 2 minutes for a typical
 * 14-lead run instead of ~9 minutes for all 68 businesses.
 *
 * Three things this adds that the list view cannot give:
 *   - review count      list cards do not render it at all
 *   - full address      cards truncate to a fragment ("59-U New")
 *   - a SECOND website check, independent of the list, which is what catches a business
 *     whose listing is simply incomplete
 *
 * context: { places: [{ mapsUrl, name }], waitMs, lang }
 * returns: { ok, results[], notes[] }
 */
export default async function ({ page, context }) {
  const out = { ok: false, step: 'start', results: [], notes: [] };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const pacing = Number(context.waitMs || 1200);
  const lang = String(context.lang || 'en');
  const places = context.places || [];

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1400, height: 900 });

    for (const p of places) {
      const rec = {
        mapsUrl: p.mapsUrl || '',
        name: p.name || '',
        title: '',
        rating: null,
        reviewCount: 0,
        website: '',
        hasWebsite: false,
        phone: '',
        address: '',
        category: '',
        error: '',
      };

      if (!rec.mapsUrl) { rec.error = 'missing place url'; out.results.push(rec); continue; }

      try {
        out.step = 'goto:' + rec.name;
        // Waiting for the info panel beats waiting for the network to go quiet: Maps
        // keeps chattering long after the panel is rendered. Measured on Phoenix place
        // pages: 4.7s vs 6.7s per place, with identical review counts and website reads.
        await page.goto(rec.mapsUrl + '?hl=' + encodeURIComponent(lang), { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForSelector('h1, a[data-item-id="authority"]', { timeout: 20000 }).catch(function () {});
        await wait(700);

        const info = await page.evaluate(() => {
          const labels = Array.prototype.slice.call(document.querySelectorAll('[aria-label]'))
            .map((b) => b.getAttribute('aria-label') || '');
          const text = document.body.innerText || '';

          let rating = null;
          for (const l of labels) {
            const m = l.match(/^([0-9.]+)\s+stars?$/i);
            if (m) { rating = Number(m[1]); break; }
          }

          let reviews = 0;
          for (const l of labels) {
            const m = l.match(/^(\d[\d,]*)\s+reviews?$/i);
            if (m) { reviews = Number(m[1].replace(/,/g, '')); break; }
          }
          if (!reviews) {
            // Fallback: the header renders as "4.6 (32)".
            const m = text.match(/[0-9.]+\s*\n?\s*\((\d[\d,]*)\)/);
            if (m) reviews = Number(m[1].replace(/,/g, ''));
          }

          // The website button is a distinct element; its absence is the signal.
          const siteEl = document.querySelector('a[data-item-id="authority"]');
          const siteLabel = labels.find((l) => /^Website:/i.test(l)) || '';

          const pick = (re) => (labels.find((l) => re.test(l)) || '').replace(re, '').trim();

          return {
            title: (document.querySelector('h1') || {}).innerText || '',
            rating: rating,
            reviews: reviews,
            website: siteEl ? (siteEl.getAttribute('href') || '') : '',
            hasWebsite: Boolean(siteEl || siteLabel),
            phone: pick(/^Phone:\s*/i),
            address: pick(/^Address:\s*/i),
            // The category sits next to the rating block as a plain button.
            category: (Array.prototype.slice.call(document.querySelectorAll('button[jsaction*="category"]'))
              .map((b) => (b.innerText || '').trim()).filter(Boolean)[0]) || '',
          };
        });

        rec.title = String(info.title || '').trim();
        rec.rating = info.rating;
        rec.reviewCount = info.reviews;
        rec.website = info.website;
        rec.hasWebsite = info.hasWebsite;
        rec.phone = String(info.phone || '').trim();
        rec.address = String(info.address || '').trim();
        rec.category = String(info.category || '').trim();
      } catch (e) {
        rec.error = String(e && e.message ? e.message : e).slice(0, 160);
      }

      out.results.push(rec);
      await wait(pacing);
    }

    out.ok = true;
    out.step = 'done';
  } catch (e) {
    out.notes.push('error at ' + out.step + ': ' + String(e && e.message ? e.message : e));
  }

  return { data: out, type: 'application/json' };
}
