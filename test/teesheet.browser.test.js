// End-to-end check of the tee-sheet reader against a local booking page that renders with JavaScript.
// Needs a Chromium: run `npx playwright install chromium` first, or set CHROMIUM_PATH.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fairway-test-"));
process.env.PER_HOST_GAP_MS = "0";
const { q } = await import("../src/db.js");
const { getTeeSheets } = await import("../src/teetimes/index.js");
const { closeBrowser } = await import("../src/browser.js");

const html = fs.readFileSync(new URL("./fixtures/teesheet.html", import.meta.url));
const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(html); }).listen(0);
const port = server.address().port;
after(async () => { server.close(); await closeBrowser(); });

test("reads free tee times from a JS-rendered visitor booking page", { timeout: 90000 }, async () => {
  q.upsertCourse.run({ id: "fixture", name: "Fixture Golf Club", town: "Testville", country: "GB", lat: 57, lon: -2, website: `http://127.0.0.1:${port}/`, phone: "", email: "", holes: 18, hidden: 0 });
  q.setBooking.run("intelligentgolf", `http://127.0.0.1:${port}/visitorbooking/`, "", "fixture");

  const r = await getTeeSheets("fixture", ["2026-12-06", "2026-12-07"], 2);
  const d6 = r.dates["2026-12-06"];
  assert.equal(d6.status, "available");
  assert.deepEqual(d6.times.map(t => t.time), ["09:30", "10:20"]); // 09:40 has only 1 space for 2 players
  assert.equal(d6.times[0].price, 85);
  assert.equal(r.dates["2026-12-07"].status, "available");
  assert.match(q.byId.get("fixture").date_template, /visitorbooking\/\?date=\{DD\}-\{MM\}-\{YYYY\}/);

  const again = await getTeeSheets("fixture", ["2026-12-06"], 2);
  assert.equal(again.dates["2026-12-06"].cached, true);
});
