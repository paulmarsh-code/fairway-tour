// The UK Golf API reader, against two plausible reply shapes (the provider doesn't publish one).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fairway-uk-"));
process.env.UKGOLF_API_KEY = "test"; process.env.UKGOLF_GAP_MS = "0";
const { q } = await import("../src/db.js");
const { fetchScorecard, saveScorecard, callsThisMonth, readTee, nameSimilarity } = await import("../src/ukgolf.js");

const shapes = {
  a: { near: { clubs: [{ id: 7, name: "Murcar Links Golf Club", rating: 4.6, review_count: 210 }, { id: 9, name: "Royal Aberdeen Golf Club", rating: 4.8, review_count: 655 }] },
       courses: { courses: [{ id: 1, name: "Silverburn", tee_sets: [{ name: "Yellow", total_yards: 4000, par: 64, course_rating: 61.2, slope: 108 }] },
                             { id: 2, name: "Balgownie", tee_sets: [{ name: "Blue", total_yards: 6900, par: 71, course_rating: 74.1, slope: 140 }, { name: "White", total_yards: 6545, par: 71, course_rating: 72.6, slope: 136 }] }] } },
  b: { near: { data: [{ club_id: "ra", club_name: "Royal Aberdeen GC", google_rating: "4.8", user_ratings_total: 655 }] },
       courses: [{ course_id: "x", course_name: "Balgownie Links", tees: [{ colour: "White", holes: [{ number: 1, par: 4, yards: 400, si: 5 }, { number: 2, par: 4, yards: 420, si: 1 }], slopeRating: 136, courseRating: 72.6 }] }] }
};
let shape = "a";
globalThis.fetch = async url => {
  const u = String(url);
  const body = u.includes("/nearby") ? shapes[shape].near : shapes[shape].courses;
  return new Response(JSON.stringify(body), { status: 200 });
};

test("finds the right club nearby and the right course, both reply shapes", async () => {
  q.upsertCourse.run({ id: "ra", name: "Royal Aberdeen Golf Club", town: "Aberdeen", country: "GB", lat: 57.18, lon: -2.08, website: "", phone: "", email: "", holes: 18, hidden: 0 });
  const row = q.byId.get("ra");
  const a = await fetchScorecard(row, { courseHint: "Royal Aberdeen (Balgownie)" });
  assert.equal(a.clubId, 9);
  assert.equal(a.course.name, "Balgownie");
  assert.deepEqual(a.course.tees.map(t => [t.name, t.yards, t.rating, t.slope]), [["Blue", 6900, 74.1, 140], ["White", 6545, 72.6, 136]]);
  assert.equal(a.rating, 4.8);
  shape = "b";
  const b = await fetchScorecard(row, { courseHint: "Balgownie" });
  assert.equal(b.clubId, "ra");
  assert.equal(b.course.tees[0].yards, 820);
  assert.equal(b.course.tees[0].slope, 136);
  assert.equal(b.reviews, 655);
  assert.equal(callsThisMonth(), 4);
  const saved = saveScorecard(row, a);
  assert.equal(saved.teesSource, "UK Golf Course API");
  assert.equal(q.byId.get("ra").rating, 4.8);
});

test("name similarity ignores generic words", () => {
  assert.ok(nameSimilarity("Royal Aberdeen Golf Club", "Royal Aberdeen (Balgownie)") > 0.9);
  assert.equal(nameSimilarity("Murcar Links Golf Club", "Royal Aberdeen Golf Club"), 0);
  assert.equal(readTee({ name: "Red" }).yards, null);
});
