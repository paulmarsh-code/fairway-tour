// Booking-system detection against local club sites. Needs Chromium (see teesheet test).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fairway-detect-"));
process.env.PER_HOST_GAP_MS = "0";
const { q } = await import("../src/db.js");
const { detectBooking } = await import("../src/detect.js");
const { closeBrowser } = await import("../src/browser.js");

const page = f => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url));
let mode = "brs";
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  if (req.url.startsWith("/visitors")) return res.end(mode === "brs" ? page("club-visitors.html") : "<h1>Visitors</h1><p>Email us to book.</p>");
  if (req.url.startsWith("/golf/tee-times")) return res.end(mode === "chrono" ? page("club-teetimes.html") : "<h1>Tee times</h1>");
  res.end(page("club-home.html"));
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { server.close(); await closeBrowser(); });

const club = id => { q.upsertCourse.run({ id, name: "Test Links", town: "", country: "GB", lat: 57, lon: -2, website: base + "/", phone: "", email: "", holes: 18, hidden: 0 }); return q.byId.get(id); };

test("follows a 'Visitors' page to a BRS booking link", { timeout: 90000 }, async () => {
  mode = "brs";
  const r = await detectBooking(club("t1"));
  assert.equal(r.system, "brs");
  assert.equal(r.url, "https://visitors.brsgolf.com/testlinks");
});

test("finds a Chronogolf widget that is added to the page after it loads", { timeout: 90000 }, async () => {
  mode = "chrono";
  const r = await detectBooking(club("t2"));
  assert.equal(r.system, "chronogolf");
  assert.match(r.url, /chronogolf\.com\/club\/test-links-scotland/);
});

test("falls back to the club's own tee-times page when no system is found", { timeout: 90000 }, async () => {
  mode = "none";
  const r = await detectBooking(club("t3"));
  assert.equal(r.system, "other");
  assert.match(r.url, /\/golf\/tee-times/);
});
