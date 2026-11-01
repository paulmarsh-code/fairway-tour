// A handful of Aberdeen-area clubs for trying the app locally before the full OpenStreetMap import.
// Coordinates are approximate. Run: npm run seed:sample
import { q } from "../src/db.js";

const clubs = [
  ["royal-aberdeen", "Royal Aberdeen Golf Club", "Bridge of Don, Aberdeen", 57.1836, -2.0812, "https://www.royalaberdeengolf.com", "GB&I Top 100", 95],
  ["murcar-links", "Murcar Links Golf Club", "Bridge of Don, Aberdeen", 57.2071, -2.0702, "https://www.murcarlinks.com", "Scotland Top 100", 80],
  ["trump-scotland", "Trump International Scotland", "Balmedie", 57.2712, -2.0339, "https://www.trumpgolfscotland.com", "GB&I Top 100", 90],
  ["newburgh-on-ythan", "Newburgh on Ythan Golf Club", "Newburgh", 57.3079, -1.9946, "https://www.newburghgolfclub.co.uk", "", null],
  ["cruden-bay", "Cruden Bay Golf Club", "Cruden Bay", 57.4152, -1.8583, "https://www.crudenbaygolfclub.co.uk", "GB&I Top 100", 92],
  ["deeside", "Deeside Golf Club", "Bieldside, Aberdeen", 57.1217, -2.2046, "https://www.deesidegolfclub.com", "", null],
  ["stonehaven", "Stonehaven Golf Club", "Stonehaven", 56.9741, -2.1951, "https://www.stonehavengolfclub.com", "", null]
];
for (const [id, name, town, lat, lon, website, rankLabel, rankScore] of clubs) {
  q.upsertCourse.run({ id, name, town, country: "GB", lat, lon, website, phone: "", email: "", holes: 18, hidden: 0 });
  if (rankLabel) q.setRank.run(rankLabel, rankScore, id);
}
console.log(`Seeded ${clubs.length} Aberdeen-area clubs. Rankings are a starter list: edit them with the admin API.`);
