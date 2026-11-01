// Find which online booking system a club uses and where its visitor booking page is,
// by visiting the club's own website. Also picks up a contact email if one is linked.
import { withPage, open, pageLinks } from "./browser.js";
import { q } from "./db.js";
import { detectSystem, BOOKING_LINK } from "./teetimes/systems.js";

const sameSite = (a, b) => { try { return new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, ""); } catch { return false; } };

export async function detectBooking(row) {
  if (!row.website) return { system: "none", url: "" };
  return withPage(async page => {
    let website = row.website;
    try { await open(page, website); website = page.url(); }
    catch { q.setBooking.run("unreachable", "", "", row.id); return { system: "unreachable", url: "" }; }

    const visited = new Set([website]);
    let links = await pageLinks(page);
    const email = links.map(l => l.href).find(h => h.startsWith("mailto:"))?.slice(7).split("?")[0] || "";

    const pick = ls => {
      for (const l of ls) { const s = detectSystem(l.href); if (s) return { system: s.id, url: l.href }; }
      return null;
    };
    let hit = pick(links);

    // Follow up to three on-site "book a tee time / visitors / green fees" pages
    if (!hit) {
      const next = links.filter(l => sameSite(l.href, website) && BOOKING_LINK.test(`${l.text} ${l.href}`)).slice(0, 3);
      for (const l of next) {
        if (visited.has(l.href)) continue;
        visited.add(l.href);
        try { await open(page, l.href); } catch { continue; }
        const more = await pageLinks(page);
        hit = pick(more);
        if (!hit && /visitorbooking|tee-?times|booking/i.test(page.url()) && sameSite(page.url(), website)) hit = { system: "other", url: page.url() };
        if (hit) break;
      }
    }
    const result = hit || { system: "none", url: "" };
    q.setBooking.run(result.system, result.url, website, row.id);
    if (email && !row.email) { try { q.upsertCourse.run({ ...row, email, hidden: row.hidden }); } catch {} }
    return result;
  });
}
