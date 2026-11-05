// Show what a club's web page reveals about online booking: booking links, iframes,
// booking systems spotted, and the outside sites it loads from. Paste the output when a
// club's live tee times aren't found, so the detector can be tuned.
// Usage: npm run inspect -- https://www.someclub.co.uk/visitors/
import { inspectSite } from "../src/detect.js";
import { closeBrowser } from "../src/browser.js";

const url = process.argv[2];
if (!/^https?:\/\//.test(url || "")) { console.log("Usage: npm run inspect -- https://club-website/page"); process.exit(1); }
try {
  const r = await inspectSite(url);
  console.log(`Page:    ${r.title}\nURL:     ${r.finalUrl}`);
  console.log(`Booking systems spotted: ${r.systemsSeen.join(", ") || "none"}`);
  console.log(`\nBooking-related links:`);
  for (const l of r.bookingLinks) console.log(`  ${(l.text || "(no text)").slice(0, 40).padEnd(40)}  ${l.href}`);
  console.log(`\nIframes:${r.iframes.length ? "" : " none"}`);
  for (const f of r.iframes) console.log(`  ${f}`);
  console.log(`\nOutside sites loaded:\n  ${r.externalHosts.join("\n  ") || "none"}`);
} catch (e) { console.log(`Couldn't open the page: ${e.message}`); }
await closeBrowser();
