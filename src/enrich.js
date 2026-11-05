// Optional course details from the club's own website (needs ANTHROPIC_API_KEY),
// and review scores from Google Places (needs GOOGLE_PLACES_API_KEY).
import { config } from "./config.js";
import { withPage, open, pageText, pageLinks, BLOCKED } from "./browser.js";
import { askJson, aiEnabled } from "./ai.js";
import { q } from "./db.js";

const USEFUL = /(visitor|green[\s-]*fee|rates|prices|scorecard|the course|course guide|hole|tee|catering|restaurant|clubhouse|menu|bar|practice|range|contact|buggy|hire|winter)/i;
const sameSite = (a, b) => { try { return new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, ""); } catch { return false; } };

const DETAILS_SCHEMA = `{"type":"Links|Parkland|Heathland|Clifftop|Moorland|Other|null","par":number|null,
 "tees":[{"name":"","yards":number|null,"par":number|null,"rating":number|null,"slope":number|null}],
 "greenFees":[{"label":"e.g. Winter weekday visitor","price":number}],"currency":"£|€",
 "offers":[""],"visitorTimes":"","visitorDays":[0-6 (0=Sun) days visitors normally welcome],"bookingWindow":"e.g. 'up to 3 days ahead' or null",
 "buggy":{"price":number|null,"note":""},"trolley":{"pull":number|null,"electric":number|null},"clubHire":number|null,
 "catering":{"summary":"","items":[{"item":"","price":number|null}]},
 "practice":"","handicapLimit":"","dressCode":"","bookingEmail":null,"bookingPhone":null,
 "conditions":${"CONDITIONS"},
 "statusUrl":"URL of a course status / course update page if one exists, else null","sources":["urls used"]}`;
const CONDITIONS = `{"status":"open|closed|restricted|unknown","temporaryGreens":true|false|null,"temporaryTees":true|false|null,"mats":true|false|null,"buggies":"allowed|restricted|not allowed|null","trolleys":"allowed|restricted|not allowed|null","maintenance":"e.g. hollow tining, overseeding, or null","notes":"","updated":"date the club gives for this update, as written, or null"}`;

/** Ask Claude which of a club's pages are worth reading (cheap: link list only). */
async function choosePages(row, links) {
  const list = links.slice(0, 120).map((l, i) => `${i}. ${l.text || "(no text)"} -> ${l.href}`).join("\n");
  try {
    const j = await askJson(`These are links on the website of ${row.name} golf club (${row.town}). Pick up to 6 pages most likely to contain, for a visiting golfer: green fees / visitor rates and offers; the scorecard or course details (yardage, par, slope); visitor information (times, handicap, dress code); catering / clubhouse menu; buggy & trolley hire; practice facilities; course status / course conditions updates. Ignore membership, news, weddings, shop, social media and other venues.
Reply only JSON: {"pick":[link numbers]}
${list}`, { maxTokens: 200 });
    return (Array.isArray(j.pick) ? j.pick : []).map(Number).filter(i => links[i]).map(i => links[i].href.split("#")[0]);
  } catch { return null; }
}

export async function enrichCourse(row) {
  if (!aiEnabled()) throw Object.assign(new Error("Course details need ANTHROPIC_API_KEY"), { status: 501 });
  if (!row.website) throw Object.assign(new Error("No website on file"), { status: 404 });

  const pages = await withPage(async page => {
    const out = [];
    await open(page, row.website);
    const home = page.url();
    const homeText = await pageText(page, 7000);
    if (BLOCKED.test(homeText)) throw Object.assign(new Error("Website blocks automated reading"), { blocked: true });
    out.push({ url: home, text: homeText });
    const links = (await pageLinks(page, 300)).filter(l => sameSite(l.href, home) && !/\.(pdf|jpe?g|png|zip|docx?)(\?|$)/i.test(l.href));
    let picks = await choosePages(row, links);
    if (!picks?.length) picks = links.filter(l => USEFUL.test(`${l.text} ${l.href}`)).map(l => l.href.split("#")[0]);
    // The visitor booking page often shows the course description and today's prices
    if (row.booking_url && row.booking_system !== "email") picks.push(row.booking_url);
    const seen = new Set([home.split("#")[0]]);
    for (const href of picks) {
      if (out.length >= 7) break;
      const key = href.split("#")[0];
      if (seen.has(key) && href === key) continue;
      seen.add(key);
      try { await open(page, href); const t = await pageText(page, 7000); if (!BLOCKED.test(t)) out.push({ url: page.url(), text: t }); } catch {}
    }
    return out;
  });

  const j = await askJson(`Pages from the website of ${row.name} (${row.town}), checked ${new Date().toISOString().slice(0, 10)}. Extract ONLY what the pages state; use null (or []) when not stated — never guess. Keep it compact: at most 6 tees, 8 green fees, 5 offers, 8 catering items, short strings. Prices in GBP or EUR as shown; prefer visitor rates and include winter rates if shown. For conditions, use only a course status / course update notice on these pages.
Reply only JSON:
${DETAILS_SCHEMA.replace('${"CONDITIONS"}', CONDITIONS)}
${pages.map(p => `\n=== ${p.url}\n${p.text}`).join("\n").slice(0, 45000)}`, { maxTokens: 4000 });

  const now = new Date().toISOString();
  const details = { ...j, checkedAt: now, conditionsCheckedAt: now, pagesRead: pages.map(p => p.url) };
  q.setDetails.run(JSON.stringify(details), row.id);
  if (j.bookingEmail && !row.email) q.setContact.run(String(j.bookingEmail), row.phone || String(j.bookingPhone || ""), row.id);
  return details;
}

/** Re-read just the course status page (cheap), at most every 12 hours. */
export async function refreshConditions(row) {
  const d = (() => { try { return JSON.parse(row.details || "{}"); } catch { return {}; } })();
  if (!d.statusUrl || !aiEnabled()) return d;
  if (d.conditionsCheckedAt && Date.now() - Date.parse(d.conditionsCheckedAt) < 12 * 3600 * 1000) return d;
  const text = await withPage(async page => { await open(page, d.statusUrl); return pageText(page, 8000); });
  const c = await askJson(`Course status page of ${row.name}, read ${new Date().toISOString().slice(0, 10)}. Extract the current course conditions it states; null when not stated.
Reply only JSON: ${CONDITIONS}
PAGE:
${text}`, { maxTokens: 500 });
  const next = { ...d, conditions: c, conditionsCheckedAt: new Date().toISOString() };
  q.setDetailsOnly.run(JSON.stringify(next), row.id);
  return next;
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
