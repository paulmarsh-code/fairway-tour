// Find which online booking system a club uses and where its visitor booking page is,
// by visiting the club's own website. Looks at links, iframes, the page HTML (booking
// widgets often hide their address in scripts or data attributes) and the network requests
// the page makes while loading. Also picks up a contact email if one is linked.
import { withPage, open, pageLinks, pageText, BLOCKED } from "./browser.js";
import { q } from "./db.js";
import { detectSystem, systemById } from "./teetimes/systems.js";

const sameSite = (a, b) => { try { return new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, ""); } catch { return false; } };
const URLS_IN_HTML = /https?:\/\/[^\s"'<>\\)]+/g;

/** Rank contact emails: a bookings/visitors address beats a general one. Returns -1 for ones to ignore. */
export function emailScore(addr) {
  const a = String(addr).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) return -1;
  if (/(membership|members|accounts?|finance|hr|jobs|careers|weddings?|events?|functions?|marketing|press|media|captain|junior|ladies|greens?keep)/.test(a.split("@")[0])) return 0;
  if (/(booking|visitor|tee|starter|reservations?)/.test(a)) return 5;
  if (/(proshop|pro-shop|pro\.?shop|golfshop|shop|\bpro\b)/.test(a)) return 4;
  if (/(office|reception|admin|secretary|manager|enquir|info|hello|golf)/.test(a)) return 3;
  return 1;
}

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

const squash = s => String(s || "").toLowerCase().replace(/golf|club|course|links|the|&|and|ltd|[^a-z0-9]/g, "");
/** How well a booking URL's club slug matches the club's name (Sport Aberdeen-style sites link several clubs). */
function nameMatch(href, name) {
  const slug = squash((/brsgolf\.com\/([^/#?]+)/.exec(href) || /\/club\/([^/#?]+)/.exec(href) || [])[1]);
  const n = squash(name);
  if (!slug || !n) return 0;
  return slug === n ? 3 : slug.includes(n) || n.includes(slug) ? 2 : 0;
}

/** Pick the best booking URL for a detected system from what we saw. */
function pickSystem(items, clubName = "") {
  let best = null, bestScore = -1, seenSystem = null;
  for (const l of items) {
    const s = detectSystem(l.href);
    if (!s) continue;
    seenSystem ||= s.id;
    const h = l.href.replace(/[),.;]+$/, "");
    if (/\.(js|css|png|svg|woff2?)(\?|$)/.test(h)) continue;
    if (/\/(login|signin|sign-in|register|account)\b/i.test(h) || /members\.brsgolf\.com/i.test(h)) continue; // members' areas, not visitor booking
    let score = 1;
    if (s.id === "chronogolf" && /\/club\/[^/?#]+/.test(h)) score += 2;
    if (s.id === "brs" && /visitors\.brsgolf\.com\/[a-z0-9_-]+/i.test(h)) score += 2;
    score += nameMatch(h, clubName) * 2;
    if (score > bestScore) { best = { system: s.id, url: h }; bestScore = score; }
  }
  return best || (seenSystem ? { system: seenSystem, url: "" } : null);
}

export async function detectBooking(row) {
  if (!row.website) return { system: "none", url: "" };
  return withPage(async page => {
    const requests = new Set();
    page.on("request", r => { const u = r.url(); if (/^https?:/.test(u) && !sameSite(u, row.website)) requests.add(u.slice(0, 400)); });

    let website = row.website;
    try { await open(page, website); website = page.url(); }
    catch { q.setBooking.run("unreachable", "", "", row.id); return { system: "unreachable", url: "" }; }

    if (BLOCKED.test(await pageText(page, 3000))) {
      q.setBooking.run("blocked", website, website, row.id);
      return { system: "blocked", url: website };
    }
    let ev = await evidence(page, requests);
    const emails = new Map(), phones = [];
    const collect = (links, at) => {
      for (const l of links) {
        if (l.href.startsWith("mailto:")) {
          const addr = decodeURIComponent(l.href.slice(7).split("?")[0]).trim().toLowerCase();
          const sc = emailScore(addr) + (/book|visitor|tee|green-?fee/i.test(at) ? 1 : 0);
          if (sc > (emails.get(addr)?.score ?? -1)) emails.set(addr, { addr, score: sc, at });
        } else if (l.href.startsWith("tel:")) phones.push(decodeURIComponent(l.href.slice(4)).trim());
      }
    };
    collect(ev.links, page.url());
    let hit = pickSystem(ev.all, row.name);
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
        collect(ev.links, page.url());
        const h = pickSystem(ev.all, row.name);
        if (h?.url) { hit = h; break; }
        hit ||= h;
        if (!onSiteBooking && /tee-?times?|visitorbooking|book(ing)?/i.test(page.url()) && sameSite(page.url(), website)) onSiteBooking = page.url();
      }
    }

    const best = [...emails.values()].filter(e => e.score > 0).sort((a, b) => b.score - a.score)[0];
    let result;
    if (hit?.url) result = hit.system === "brs" ? { ...hit, url: systemById("brs").visitorUrl(hit.url) } : hit;
    else if (hit) result = { system: hit.system, url: onSiteBooking || website }; // system seen, but no club-specific address
    else if (best && best.score >= 3) result = { system: "email", url: best.at }; // books by email, no online tee sheet
    else if (onSiteBooking) result = { system: "other", url: onSiteBooking };
    else result = { system: "none", url: "" };

    q.setBooking.run(result.system, result.url, website, row.id);
    if (best) { result.email = best.addr; q.setContact.run(best.addr, row.phone || phones[0] || "", row.id); }
    else if (phones[0] && !row.phone) q.setContact.run(row.email || "", phones[0], row.id);
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
