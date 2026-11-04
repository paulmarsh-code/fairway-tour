// Build the course directory for the UK & Ireland from OpenStreetMap (ODbL licence —
// show "© OpenStreetMap contributors" in the app, which the front end does).
//
// The countries are fetched in small map squares (tiles) so each request is light enough
// for the public Overpass servers. Each tile is retried on other servers, and saved as it
// arrives, so a re-run fills in anything that failed.
//
// Usage: npm run import:osm            (both countries)
//        npm run import:osm -- GB      (one country)
import { db, q } from "../src/db.js";
import { userAgent } from "../src/config.js";
import { pathToFileURL } from "node:url";

const countries = process.argv.slice(2).filter(c => /^(GB|IE)$/i.test(c)).map(c => c.toUpperCase());
const list = countries.length ? countries : ["GB", "IE"];
const NOT_A_COURSE = /\b(pitch\s*(and|&|n)\s*putt|mini(ature)?\s*golf|crazy\s*golf|adventure\s*golf|foot\s*golf|disc\s*golf|driving\s*range|putting\s*green|golf\s*centre\s*range)\b/i;

// Bounding boxes [south, west, north, east] and tile size in degrees
const BOUNDS = { GB: [49.8, -8.7, 60.9, 1.8], IE: [51.3, -10.7, 55.5, -5.9] };
const TILE = 1.5;
const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function tiles([s, w, n, e], size = TILE) {
  const out = [];
  for (let lat = s; lat < n; lat += size)
    for (let lon = w; lon < e; lon += size)
      out.push([+lat.toFixed(3), +lon.toFixed(3), +Math.min(lat + size, n).toFixed(3), +Math.min(lon + size, e).toFixed(3)]);
  return out;
}

async function fetchTile(country, [s, w, n, e]) {
  const query = `[out:json][timeout:120];
area["ISO3166-1"="${country}"][admin_level=2]->.a;
(way["leisure"="golf_course"](area.a)(${s},${w},${n},${e});relation["leisure"="golf_course"](area.a)(${s},${w},${n},${e});node["leisure"="golf_course"](area.a)(${s},${w},${n},${e}););
out center tags;`;
  let last = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(150000)
      });
      if (r.ok) {
        const j = await r.json();
        if (j.remark && /runtime error|timed out/i.test(j.remark)) { last = j.remark.slice(0, 80); }
        else return j.elements || [];
      } else last = `${r.status} from ${new URL(url).host}`;
    } catch (e) { last = `${e.name === "TimeoutError" ? "timeout" : e.message} from ${new URL(url).host}`; }
    await sleep(Math.min(5000 * 2 ** attempt, 60000)); // back off: 5s, 10s, 20s, 40s, 60s
  }
  throw new Error(last || "no response");
}

const clean = s => String(s || "").trim();
const site = s => { s = clean(s); if (!s) return ""; if (!/^https?:\/\//i.test(s)) s = "https://" + s; try { return new URL(s).href; } catch { return ""; } };

const save = db.transaction((country, items) => {
  let added = 0, hidden = 0;
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
  return { added, hidden };
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failed = [];
  for (const country of list) {
    const ts = tiles(BOUNDS[country]);
    let added = 0, hidden = 0;
    console.log(`${country}: fetching golf courses in ${ts.length} map squares…`);
    for (const [i, t] of ts.entries()) {
      try {
        const r = save(country, await fetchTile(country, t));
        added += r.added; hidden += r.hidden;
        console.log(`  ${country} ${String(i + 1).padStart(2)}/${ts.length}  ${String(r.added).padStart(4)} courses  (${t.join(", ")})`);
      } catch (e) {
        failed.push(`${country} ${t.join(",")}`);
        console.log(`  ${country} ${String(i + 1).padStart(2)}/${ts.length}  FAILED: ${e.message}`);
      }
      await sleep(1500); // be gentle with the shared servers
    }
    console.log(`${country}: ${added} courses saved (${hidden} hidden as pitch & putt / mini golf / disused).`);
  }
  const n = db.prepare("SELECT COUNT(*) n, SUM(website<>'') w FROM courses WHERE hidden=0").get();
  console.log(`Directory now has ${n.n} visible courses, ${n.w || 0} with a website.`);
  if (failed.length) {
    console.log(`${failed.length} map square(s) failed — run "npm run import:osm" again later to fill them in.`);
    process.exitCode = 1;
  }
}
