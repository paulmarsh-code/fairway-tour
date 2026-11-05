// The AI navigator clicking through a booking page that has no dates in its address.
// Claude is replaced by a scripted stand-in that reads the controls list it is given.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fairway-nav-"));
process.env.PER_HOST_GAP_MS = "0";
process.env.ANTHROPIC_API_KEY = "test-key";

const prompts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (!String(url).includes("api.anthropic.com")) return realFetch(url, opts);
  const prompt = JSON.parse(opts.body).messages[0].content;
  prompts.push(prompt);
  let reply = { template: null };
  if (prompt.startsWith("You are operating")) {
    const target = /Goal: make the page show the tee sheet for (\w+),? (\d+)/.exec(prompt);
    const want = `${target[1].slice(0, 3)} ${target[2]}`;
    const line = prompt.split("\n").find(l => l.includes(`"${want}"`));
    if (!line) reply = { done: false, notOpen: true };
    else if (line.includes("{active}")) reply = { done: true, shownDate: null };
    else reply = { done: false, click: Number(/^\[(\d+)\]/.exec(line)[1]) };
  }
  return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(reply) }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn" }));
};

const { q } = await import("../src/db.js");
const { getTeeSheets } = await import("../src/teetimes/index.js");
const { closeBrowser } = await import("../src/browser.js");

const html = fs.readFileSync(new URL("./fixtures/brs-like.html", import.meta.url));
const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); }).listen(0);
after(async () => { server.close(); await closeBrowser(); });

const ukDay = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

test("clicks to each day and reads the free times; never offers 'Book now'", { timeout: 120000 }, async () => {
  q.upsertCourse.run({ id: "nav", name: "Nav Links", town: "", country: "GB", lat: 57, lon: -2, website: "", phone: "", email: "", holes: 18, hidden: 0 });
  q.setBooking.run("other", `http://127.0.0.1:${server.address().port}/kingslinks/`, "", "nav");
  const r = await getTeeSheets("nav", [ukDay(1), ukDay(2), ukDay(3), ukDay(9)], 4);
  if (process.env.DEBUG_NAV) { console.log(JSON.stringify(r, null, 1)); console.log(prompts.filter(p => p.startsWith("You are")).map(p => p.split("CONTROLS:")[1]).slice(0, 2).join("\n----\n")); }
  assert.deepEqual(r.dates[ukDay(1)].times.map(t => t.time), ["11:14", "11:38"]);
  assert.equal(r.dates[ukDay(1)].times[0].price, 24.5);
  assert.equal(r.dates[ukDay(1)].times[0].spaces, 4);
  assert.deepEqual(r.dates[ukDay(2)].times.map(t => t.time), ["09:10", "10:20", "12:30"]);
  assert.equal(r.dates[ukDay(3)].status, "none");
  assert.equal(r.dates[ukDay(9)].status, "not_open");
  const navPrompts = prompts.filter(p => p.startsWith("You are operating"));
  assert.ok(navPrompts.length > 0);
  assert.ok(navPrompts.every(p => !/"Book now"/.test(p) && !/Player - £/.test(p.split("CONTROLS:")[1])), "booking and price buttons must not be offered");
});
