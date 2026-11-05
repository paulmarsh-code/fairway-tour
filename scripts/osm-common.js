// Shared by both course importers: turn OpenStreetMap elements into course rows.
import { db, q } from "../src/db.js";

export const NOT_A_COURSE = /\b(pitch\s*(and|&|n)\s*putt|mini(ature)?\s*golf|crazy\s*golf|adventure\s*golf|foot\s*golf|disc\s*golf|driving\s*range|putting\s*green|golf\s*centre\s*range)\b/i;

const clean = s => String(s || "").trim();
const site = s => { s = clean(s); if (!s) return ""; if (!/^https?:\/\//i.test(s)) s = "https://" + s; try { return new URL(s).href; } catch { return ""; } };

export const saveElements = db.transaction((country, items) => {
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

