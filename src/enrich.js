// Optional course details from the club's own website (needs ANTHROPIC_API_KEY),
// and review scores from Google Places (needs GOOGLE_PLACES_API_KEY).
import { config } from "./config.js";
import { withPage, open, pageText, pageLinks } from "./browser.js";
import { askJson, aiEnabled } from "./ai.js";
import { q } from "./db.js";

const USEFUL = /(visitor|green[\s-]*fee|rates|prices|scorecard|the course|course guide|hole|tee|catering|restaurant|clubhouse|menu|bar|practice|range|contact|buggy|hire|winter)/i;
const sameSite = (a, b) => { try { return new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, ""); } catch { return false; } };

export async function enrichCourse(row) {
  if (!aiEnabled()) throw Object.assign(new Error("Course details need ANTHROPIC_API_KEY"), { status: 501 });
  if (!row.website) throw Object.assign(new Error("No website on file"), { status: 404 });

  const pages = await withPage(async page => {
    const out = [];
    await open(page, row.website);
    out.push({ url: page.url(), text: await pageText(page, 6000) });
    const links = (await pageLinks(page)).filter(l => sameSite(l.href, row.website) && USEFUL.test(`${l.text} ${l.href}`));
    const seen = new Set([page.url()]);
    for (const l of links) {
      if (out.length >= 6) break;
      const href = l.href.split("#")[0];
      if (seen.has(href)) continue;
      seen.add(href);
      try { await open(page, href); out.push({ url: page.url(), text: await pageText(page, 5000) }); } catch {}
    }
    return out;
  });

  const j = await askJson(`Pages from the website of ${row.name} (${row.town}). Extract ONLY what the pages state; use null when not stated. Prices in GBP or EUR as shown.
Reply only JSON:
{"type":"Links|Parkland|Heathland|Clifftop|Moorland|Other|null","par":number|null,
 "tees":[{"name":"","yards":number|null,"par":number|null,"rating":number|null,"slope":number|null}],
 "greenFees":[{"label":"e.g. Winter weekday","price":number}],"currency":"£|€",
 "offers":[""],"visitorTimes":"","visitorDays":[0-6 (0=Sun) days visitors normally welcome] ,
 "buggy":{"price":number|null,"note":""},"trolley":{"pull":number|null,"electric":number|null},
 "catering":{"summary":"","items":[{"item":"","price":number|null}]},
 "practice":"","handicapLimit":"","dressCode":"","bookingEmail":null,"bookingPhone":null,"sources":["urls used"]}
${pages.map(p => `\n=== ${p.url}\n${p.text}`).join("\n").slice(0, 60000)}`, { maxTokens: 3000 });

  const details = { ...j, checkedAt: new Date().toISOString() };
  q.setDetails.run(JSON.stringify(details), row.id);
  return details;
}

export async function fetchRating(row) {
  if (!config.googlePlacesKey) return null;
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": config.googlePlacesKey, "X-Goog-FieldMask": "places.rating,places.userRatingCount,places.displayName" },
    body: JSON.stringify({ textQuery: `${row.name} golf ${row.town}`, locationBias: { circle: { center: { latitude: row.lat, longitude: row.lon }, radius: 3000 } }, maxResultCount: 1 })
  });
  if (!r.ok) return null;
  const p = (await r.json()).places?.[0];
  if (!p?.rating) return null;
  q.setRating.run(p.rating, p.userRatingCount || null, row.id);
  return { rating: p.rating, count: p.userRatingCount };
}
