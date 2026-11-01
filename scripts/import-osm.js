// Build the course directory for the UK & Ireland from OpenStreetMap (ODbL licence —
// show "© OpenStreetMap contributors" in the app, which the front end does).
// Usage: npm run import:osm            (both countries)
//        npm run import:osm -- GB      (one country)
import { db, q } from "../src/db.js";
import { userAgent } from "../src/config.js";

const countries = process.argv.slice(2).filter(c => /^(GB|IE)$/i.test(c)).map(c => c.toUpperCase());
const list = countries.length ? countries : ["GB", "IE"];
const NOT_A_COURSE = /\b(pitch\s*(and|&|n)\s*putt|mini(ature)?\s*golf|crazy\s*golf|adventure\s*golf|foot\s*golf|disc\s*golf|driving\s*range|putting\s*green|par\s*3\s*course|golf\s*centre\s*range)\b/i;

async function overpass(country) {
  const query = `[out:json][timeout:600];
area["ISO3166-1"="${country}"][admin_level=2]->.a;
(way["leisure"="golf_course"](area.a);relation["leisure"="golf_course"](area.a);node["leisure"="golf_course"](area.a););
out center tags;`;
  const endpoints = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
  for (const url of endpoints) {
    try {
      console.log(`Fetching ${country} golf courses from ${new URL(url).host} (this can take a few minutes)…`);
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent }, body: "data=" + encodeURIComponent(query) });
      if (r.ok) return (await r.json()).elements || [];
      console.warn(`  ${r.status} from ${url}`);
    } catch (e) { console.warn(`  ${e.message}`); }
  }
  throw new Error("Overpass API unavailable — try again later");
}

const clean = s => String(s || "").trim();
const site = s => { s = clean(s); if (!s) return ""; if (!/^https?:\/\//i.test(s)) s = "https://" + s; try { return new URL(s).href; } catch { return ""; } };

for (const country of list) {
  const els = await overpass(country);
  let added = 0, hidden = 0;
  const tx = db.transaction(items => {
    for (const e of items) {
      const t = e.tags || {};
      const name = clean(t.name || t["name:en"]);
      const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
      if (!name || lat == null || lon == null) continue;
      const holes = Number.parseInt(t["golf:holes"] || t.holes || "", 10);
      const hide = NOT_A_COURSE.test(name) || (Number.isFinite(holes) && holes < 9) || t.disused === "yes" || Object.keys(t).some(k => /^(abandoned|disused|was):/.test(k));
      q.upsertCourse.run({
        id: `osm-${e.type}-${e.id}`, name, country, lat, lon,
        town: clean(t["addr:city"] || t["addr:town"] || t["addr:village"] || t["addr:suburb"] || t.is_in?.split(",")[0]),
        website: site(t.website || t["contact:website"] || t.url),
        phone: clean(t.phone || t["contact:phone"]), email: clean(t.email || t["contact:email"]),
        holes: Number.isFinite(holes) ? holes : null, hidden: hide ? 1 : 0
      });
      added++; if (hide) hidden++;
    }
  });
  tx(els);
  console.log(`${country}: ${added} courses saved (${hidden} hidden as pitch & putt / mini golf / disused).`);
}
const n = db.prepare("SELECT COUNT(*) n, SUM(website<>'') w FROM courses WHERE hidden=0").get();
console.log(`Directory now has ${n.n} visible courses, ${n.w} with a website. Next: npm run detect:booking`);
