// Find which online booking system a club uses and where its visitor booking page is,
// by visiting the club's own website. Looks at links, iframes, the page HTML (booking
// widgets often hide their address in scripts or data attributes) and the network requests
// the page makes while loading. Also picks up a contact email if one is linked.
import { withPage, open, pageLinks } from "./browser.js";
import { q } from "./db.js";
import { detectSystem } from "./teetimes/systems.js";

const sameSite = (a, b) => { try { return new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, ""); } catch { return false; } };
const URLS_IN_HTML = /https?:\/\/[^\s"'<>\\)]+/g;

/** Score a candidate link: higher = more likely to lead to visitor booking. */
function linkScore(l) {
  const s = `${l.text} ${l.href}`.toLowerCase();
  let n = 0;
  if (/book(ing)?[\s-]*(a\s*)?tee|tee[\s-]*times?/.test(s)) n += 5;
  if (/book online|online booking|book now/.test(s)) n += 4;
  if (/visitor/.test(s)) n += 3;
  if (/green[\s-]*fees?|rates|prices/.test(s)) n += 2;
  if (/\bbook/.test(s)) n += 1;
  if (/member|login|competition|results|news|shop|function|wedding|hotel|spa|membership/.test(s)) n -= 3;
  return n;
}

/** Everything on the current page that could reveal a booking system, plus the requests seen while loading. */
async function evidence(page, requests) {
  const links = await pageLinks(page, 400);
  const html = await page.content().catch(() => "");
  const htmlUrls = [...new Set(html.match(URLS_IN_HTML) || [])].slice(0, 800).map(href => ({ href, text: "" }));
  const reqs = [...requests].map(href => ({ href, text: "" }));
  return { links, all: [...links, ...htmlUrls, ...reqs] };
}

/** Pick the best booking URL for a detected system from what we saw. */
function pickSystem(items) {
  let found = null;
  for (const l of items) {
    const s = detectSystem(l.href);
    if (!s) continue;
    // Prefer a URL that identifies the club (e.g. chronogolf.com/club/<slug>, visitors.brsgolf.com/<club>)
    const good = s.id === "chronogolf" ? /\/club\/[^/?#]+/.test(l.href)
      : s.id === "brs" ? /brsgolf\.com\/[a-z0-9_-]+/i.test(l.href) && !/\.(js|css)(\?|$)/.test(l.href)
      : !/\.(js|css|png|svg|woff2?)(\?|$)/.test(l.href);
    if (good) return { system: s.id, url: l.href.replace(/[),.;]+$/, "") };
    found ||= { system: s.id, url: "" };
  }
  return found;
}

export async function detectBooking(row) {
  if (!row.website) return { system: "none", url: "" };
  return withPage(async page => {
    const requests = new Set();
    page.on("request", r => { const u = r.url(); if (/^https?:/.test(u) && !sameSite(u, row.website)) requests.add(u.slice(0, 400)); });

    let website = row.website;
    try { await open(page, website); website = page.url(); }
    catch { q.setBooking.run("unreachable", "", "", row.id); return { system: "unreachable", url: "" }; }

    let ev = await evidence(page, requests);
    const email = ev.links.map(l => l.href).find(h => h.startsWith("mailto:"))?.slice(7).split("?")[0] || "";
    let hit = pickSystem(ev.all);
    let onSiteBooking = "";

    // Follow up to five on-site visitor / tee time / green fee pages, best first
    if (!hit?.url) {
      const visited = new Set([website.split("#")[0]]);
      const next = ev.links
        .filter(l => sameSite(l.href, website) && linkScore(l) > 0)
        .sort((a, b) => linkScore(b) - linkScore(a))
        .slice(0, 8);
      for (const l of next) {
        const href = l.href.split("#")[0];
        if (visited.has(href)) continue;
        if (visited.size > 5) break;
        visited.add(href);
        try { await open(page, href); } catch { continue; }
        ev = await evidence(page, requests);
        const h = pickSystem(ev.all);
        if (h?.url) { hit = h; break; }
        hit ||= h;
        if (!onSiteBooking && /tee-?times?|visitorbooking|book(ing)?/i.test(page.url()) && sameSite(page.url(), website)) onSiteBooking = page.url();
      }
    }

    let result;
    if (hit?.url) result = hit;
    else if (hit) result = { system: hit.system, url: onSiteBooking || website }; // system seen, but no club-specific address
    else if (onSiteBooking) result = { system: "other", url: onSiteBooking };
    else result = { system: "none", url: "" };

    q.setBooking.run(result.system, result.url, website, row.id);
    if (email && !row.email) { try { q.upsertCourse.run({ ...row, email, hidden: row.hidden }); } catch {} }
    return result;
  });
}

/** Diagnostic: what a club's site reveals about booking. Used by scripts/inspect-site.js. */
export async function inspectSite(url) {
  return withPage(async page => {
    const requests = new Set();
    page.on("request", r => { const u = r.url(); if (/^https?:/.test(u) && !sameSite(u, url)) requests.add(u.slice(0, 200)); });
    await open(page, url);
    const ev = await evidence(page, requests);
    return {
      finalUrl: page.url(),
      title: await page.title().catch(() => ""),
      bookingLinks: ev.links.filter(l => linkScore(l) > 0 || detectSystem(l.href)).slice(0, 40),
      iframes: await page.$$eval("iframe", fs => fs.map(f => f.src).filter(Boolean)).catch(() => []),
      systemsSeen: [...new Set(ev.all.map(l => detectSystem(l.href)?.id).filter(Boolean))],
      externalHosts: [...new Set([...requests].map(u => { try { return new URL(u).host; } catch { return ""; } }))].filter(Boolean).sort()
    };
  });
}
