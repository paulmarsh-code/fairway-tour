// Add (or update) a club the map data is missing.
// Usage: npm run add-club -- "Trump International Scotland" 57.2575 -2.0337 https://www.trumpgolfscotland.com [town]
// Coordinates: in Google Maps, right-click the course and click the numbers at the top of the menu to copy them.
import { q } from "../src/db.js";

const [name, lat, lon, website = "", town = ""] = process.argv.slice(2);
if (!name || !Number.isFinite(+lat) || !Number.isFinite(+lon)) {
  console.log('Usage: npm run add-club -- "Club name" <lat> <lon> [website] [town]');
  process.exit(1);
}
const id = "manual-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const site = website && !/^https?:\/\//i.test(website) ? "https://" + website : website;
const country = +lon < -5.4 && +lat < 55.4 && !(+lat > 54 && +lon > -8.2) ? "IE" : "GB"; // rough: Republic of Ireland vs UK
q.upsertCourse.run({ id, name, town, country, lat: +lat, lon: +lon, website: site, phone: "", email: "", holes: null, hidden: 0 });
console.log(`Saved ${name} (${id}) at ${lat}, ${lon}${site ? ", " + site : ""}.`);
