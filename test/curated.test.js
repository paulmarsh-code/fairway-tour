import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fairway-cur-"));
const { ranksFor, tierFor, matchScore } = await import("../scripts/import-curated.js");
const list = JSON.parse(fs.readFileSync(new URL("../curated/scotland.json", import.meta.url)));

test("curated list is well formed", () => {
  const names = new Set();
  for (const c of list.courses) {
    assert.ok(c.name && c.town && c.match?.length, c.name);
    assert.ok(!names.has(c.name), `duplicate ${c.name}`); names.add(c.name);
    assert.ok(["ncg", "t100", "gm", "gd", "gm101", "gp"].some(k => c[k]), `${c.name} has no ranking`);
  }
});

test("ranks are ordered best first and tiers follow the rule", () => {
  const cruden = list.courses.find(c => c.name === "Cruden Bay");
  const r = ranksFor(cruden, list.sources);
  assert.equal(r[0].source, "ncg");
  assert.equal(r[0].label, "#8 in Scotland");
  assert.equal(tierFor(cruden), "top");
  assert.equal(tierFor(list.courses.find(c => c.name === "Kintore")), "gem");
});

test("matching prefers the right course and avoids excluded names", () => {
  const dunes = list.courses.find(c => c.name === "Machrihanish");
  assert.ok(matchScore(dunes, { name: "Machrihanish Golf Club" }, 0.5) > matchScore(dunes, { name: "Machrihanish Dunes" }, 0.2));
  const newc = list.courses.find(c => c.name === "St Andrews New Course");
  assert.ok(matchScore(newc, { name: "New Course" }, 0.3) > matchScore(newc, { name: "Old Course" }, 0.2));
});
