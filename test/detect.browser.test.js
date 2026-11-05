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
  if (mode === "blocked") return res.end("<title>Just a moment...</title><h1>Verifying you are human. This may take a few seconds.</h1><p>Performance &amp; security by Cloudflare</p>");
  if (req.url.startsWith("/visitors") && mode === "multi") return res.end(`<h1>Golf courses</h1>
    <a href="https://members.brsgolf.com/hazlehead/login">Member login</a>
    <a href="https://visitors.brsgolf.com/hazlehead#/course/1">Hazlehead visitors</a>
    <a href="https://visitors.brsgolf.com/kingslinks#/course/1">King's Links visitors</a>`);
  if (req.url.startsWith("/visitors")) return res.end(mode === "brs" ? page("club-visitors.html")
    : mode === "email" ? '<h1>Visitors</h1><p>Contact <a href="mailto:membership@testlinks.co.uk">membership</a> or book with <a href="mailto:bookings@testlinks.co.uk">bookings@testlinks.co.uk</a>, <a href="tel:+441779812285">01779 812285</a></p>'
    : "<h1>Visitors</h1><p>Email us to book.</p>");
  if (req.url.startsWith("/golf/tee-times")) return res.end(mode === "chrono" ? page("club-teetimes.html") : "<h1>Tee times</h1>");
  res.end(page("club-home.html"));
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { server.close(); await closeBrowser(); });

const club = (id, name = "Test Links") => { q.upsertCourse.run({ id, name, town: "", country: "GB", lat: 57, lon: -2, website: base + "/", phone: "", email: "", holes: 18, hidden: 0 }); return q.byId.get(id); };

test("follows a 'Visitors' page to a BRS booking link", { timeout: 90000 }, async () => {
  mode = "brs";
  const r = await detectBooking(club("t1"));
  assert.equal(r.system, "brs");
  assert.equal(r.url, "https://visitors.brsgolf.com/testlinks#/course/1");
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

test("recognises a club that takes visitor bookings by email", { timeout: 90000 }, async () => {
  mode = "email";
  const r = await detectBooking(club("t4"));
  assert.equal(r.system, "email");
  assert.equal(r.email, "bookings@testlinks.co.uk");
  const row = q.byId.get("t4");
  assert.equal(row.email, "bookings@testlinks.co.uk");
  assert.equal(row.phone, "+441779812285");
});

test("on a site listing several clubs, picks this club's BRS visitor page, not a members' login", { timeout: 90000 }, async () => {
  mode = "multi";
  const r = await detectBooking(club("t5", "Kings Links Golf Course"));
  assert.equal(r.system, "brs");
  assert.equal(r.url, "https://visitors.brsgolf.com/kingslinks#/course/1");
});

test("recognises a bot-protection screen and stops", { timeout: 90000 }, async () => {
  mode = "blocked";
  const r = await detectBooking(club("t6"));
  assert.equal(r.system, "blocked");
});
