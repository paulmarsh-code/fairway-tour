// Test live tee times for one club from the command line — use this to check a booking system works.
// Usage: npm run check -- "Royal Aberdeen" 2026-12-07 [players=4]
//        npm run check -- osm-way-12345 2026-12-07
import { db, q } from "../src/db.js";
import { detectBooking } from "../src/detect.js";
import { getTeeSheets } from "../src/teetimes/index.js";
import { closeBrowser } from "../src/browser.js";

const [who, date, players = "4"] = process.argv.slice(2).filter(a => !a.startsWith("--"));
if (!who || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
  console.log('Usage: npm run check -- "<club name or id>" YYYY-MM-DD [players]');
  process.exit(1);
}
let row = q.byId.get(who) || db.prepare("SELECT * FROM courses WHERE name LIKE ? AND hidden=0 ORDER BY length(name) LIMIT 1").get(`%${who}%`);
if (!row) { console.log(`No club matching "${who}"`); process.exit(1); }
console.log(`Club: ${row.name} (${row.id})\nWebsite: ${row.website || "—"}`);

const redetect = process.argv.includes("--redetect") || ["", "none", "other", "unreachable"].includes(row.booking_system || "");
if (redetect || !row.booking_url) {
  console.log("Finding the booking system…");
  if (row.date_template) q.setTemplate.run("", row.id);
  db.prepare("DELETE FROM tee_sheets WHERE course_id=?").run(row.id); // forget old results
  console.log(await detectBooking(row));
  row = q.byId.get(row.id);
}
console.log(`Booking: ${row.booking_system || "—"} ${row.booking_url || ""}`);
const res = await getTeeSheets(row.id, [date], Number(players));
console.log(JSON.stringify(res, null, 2));
console.log(`Date pattern saved: ${q.byId.get(row.id).date_template || "none"}`);
await closeBrowser();
