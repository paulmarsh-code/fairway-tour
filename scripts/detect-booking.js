// Visit club websites to find their online booking system and visitor booking page.
// Resumable: re-run any time; it skips clubs checked in the last 30 days.
// Usage: npm run detect:booking -- [maxClubs=200]
import { q } from "../src/db.js";
import { detectBooking } from "../src/detect.js";
import { closeBrowser } from "../src/browser.js";

const max = Number(process.argv[2]) || 200;
const rows = q.needDetection.all("-30 days", max);
console.log(`Checking ${rows.length} club websites…`);
const tally = {};
let i = 0;
await Promise.all(Array.from({ length: 3 }, async () => {
  while (i < rows.length) {
    const row = rows[i++];
    try {
      const r = await detectBooking(row);
      tally[r.system] = (tally[r.system] || 0) + 1;
      console.log(`${String(i).padStart(4)}  ${r.system.padEnd(16)} ${row.name}${r.url ? "  " + r.url : ""}`);
    } catch (e) {
      tally.error = (tally.error || 0) + 1;
      console.log(`${String(i).padStart(4)}  error            ${row.name}  ${e.message.slice(0, 80)}`);
    }
  }
}));
console.log("\nSummary:", tally);
await closeBrowser();
