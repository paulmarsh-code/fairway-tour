// Fill in course details (tees, slope, fees, hire, catering...) from club websites near a place.
// Needs ANTHROPIC_API_KEY. Review scores need GOOGLE_PLACES_API_KEY.
// Usage: npm run enrich -- "Aberdeen" [radiusMiles=25]
import { q } from "../src/db.js";
import { geocode, boundingBox, milesBetween } from "../src/geo.js";
import { enrichCourse, fetchRating } from "../src/enrich.js";
import { closeBrowser } from "../src/browser.js";

const [place, radius = "25"] = process.argv.slice(2);
if (!place) { console.log('Usage: npm run enrich -- "<place>" [radius]'); process.exit(1); }
const o = await geocode(place);
const b = boundingBox(o, Number(radius));
const rows = q.inBox.all(b.minLat, b.maxLat, b.minLon, b.maxLon).filter(r => milesBetween(o, r) <= Number(radius));
console.log(`${rows.length} courses within ${radius} miles of ${o.label}`);
for (const r of rows) {
  try {
    if (r.website) { const d = await enrichCourse(r); console.log(`✓ ${r.name}: par ${d.par ?? "?"}, ${d.tees?.length || 0} tees, ${d.greenFees?.length || 0} fees`); }
    const rt = await fetchRating(r); if (rt) console.log(`  ★ ${rt.rating} (${rt.count})`);
  } catch (e) { console.log(`✗ ${r.name}: ${e.message.slice(0, 100)}`); }
}
await closeBrowser();
