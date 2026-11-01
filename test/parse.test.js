import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRows, parseText, dateShown, fillTemplate, normTime, spacesIn } from "../src/teetimes/parse.js";
import { detectSystem, templateFromDatedUrl, SYSTEMS } from "../src/teetimes/systems.js";
import { extractJson } from "../src/ai.js";

test("normTime pads and accepts dots", () => {
  assert.equal(normTime("9:10"), "09:10");
  assert.equal(normTime("Tee 14.30"), "14:30");
  assert.equal(normTime("no time"), null);
});

test("parseRows keeps bookable rows, drops booked / member / closed rows", () => {
  const rows = [
    { time: "08:00", text: "08:00 Members only", hasAction: false },
    { time: "08:10", text: "08:10 Book £95.00 4 spaces", hasAction: true },
    { time: "08:20", text: "08:20 Booked", hasAction: false },
    { time: "08:30", text: "08:30 £95 1 space available", hasAction: true },
    { time: "09:00", text: "09:00 Select", hasAction: true },
    { time: "09:10", text: "09:10 Competition", hasAction: true },
    { time: "05:30", text: "05:30 £20", hasAction: true },
    { time: "10:00", text: "10:00 Full 18 holes £120", hasAction: true },
    { time: "10:10", text: "10:10 Fully booked", hasAction: false }
  ];
  const out = parseRows(rows, { players: 2 });
  assert.deepEqual(out.map(t => t.time), ["08:10", "09:00", "10:00"]);
  assert.equal(out[0].price, 95);
  assert.equal(out[0].spaces, 4);
  assert.equal(out[2].price, 120);
});

test("parseRows keeps the cheapest price per time", () => {
  const out = parseRows([
    { time: "11:00", text: "11:00 Visitor £150", hasAction: true },
    { time: "11:00", text: "11:00 Winter offer £110", hasAction: true }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].price, 110);
});

test("parseText reads tee sheet text without borrowing the next row's price", () => {
  const text = "Saturday 6 December\n09:30\n£85.00\n09:40\n09:50\n£85.00\nBook";
  const out = parseText(text);
  assert.deepEqual(out.map(t => t.time), ["09:30", "09:50"]);
});

test("spacesIn handles common formats", () => {
  assert.equal(spacesIn("3 spaces"), 3);
  assert.equal(spacesIn("1/4"), 3);
  assert.equal(spacesIn("Book"), null);
});

test("dateShown recognises common date formats", () => {
  assert.ok(dateShown("Tee times for Sunday 6th December 2026", "2026-12-06"));
  assert.ok(dateShown("06/12/2026", "2026-12-06"));
  assert.ok(dateShown("Dec 6, 2026", "2026-12-06"));
  assert.ok(dateShown("Sun 6", "2026-12-06"));
  assert.ok(!dateShown("Monday 7 December", "2026-12-06"));
  assert.ok(dateShown("22nd December", "2026-12-22"));
  assert.ok(dateShown("1st January", "2027-01-01"));
});

test("fillTemplate fills all tokens", () => {
  assert.equal(fillTemplate("x?d={DD}-{MM}-{YYYY}&m={MON}&s={D}/{M}/{YY}", "2026-12-06"), "x?d=06-12-2026&m=Dec&s=6/12/26");
});

test("detectSystem recognises booking systems from links", () => {
  assert.equal(detectSystem("https://visitors.brsgolf.com/royalaberdeen")?.id, "brs");
  assert.equal(detectSystem("https://www.someclub.co.uk/visitorbooking/")?.id, "intelligentgolf");
  assert.equal(detectSystem("https://www.chronogolf.com/club/trump-international-scotland")?.id, "chronogolf");
  assert.equal(detectSystem("https://www.example.com/contact"), null);
});

test("system candidates build dated URLs", () => {
  const brs = SYSTEMS.find(s => s.id === "brs").candidates("https://visitors.brsgolf.com/royalaberdeen");
  assert.ok(brs[0].includes("royalaberdeen") && brs[0].includes("{YYYY}"));
  assert.equal(templateFromDatedUrl("https://x.com/book?date=2026-12-06"), "https://x.com/book?date={YYYY}-{MM}-{DD}");
  assert.equal(templateFromDatedUrl("https://x.com/book"), null);
});

test("extractJson copes with fences and prose", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here: {"a":2} done'), { a: 2 });
});
