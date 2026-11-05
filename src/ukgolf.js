// UK Golf Course Data API (ukgolfapi.uk, via RapidAPI): scorecards with tee sets, yardage,
// course rating and slope, plus Google review scores. The free plan allows 200 requests a month
// and 5 a minute, so every call is counted, spaced out, and results are saved for good.
//
// The provider doesn't publish response field names, so the reader below accepts the common
// spellings and keeps the raw reply. Run `npm run ukgolf -- probe "<club>"` to see a real reply.
import { config, userAgent } from "./config.js";
import { db, q } from "./db.js";

const PROVIDER = "ukgolf";
const month = () => new Date().toISOString().slice(0, 7);
const usage = db.prepare("SELECT calls FROM api_usage WHERE provider=? AND month=?");
const bump = db.prepare("INSERT INTO api_usage (provider, month, calls) VALUES (?, ?, 1) ON CONFLICT(provider, month) DO UPDATE SET calls = calls + 1");
export const callsThisMonth = () => usage.get(PROVIDER, month())?.calls || 0;
export const ukgolfEnabled = () => !!config.ukgolfKey;

let last = 0;
async function call(path) {
  if (!config.ukgolfKey) throw new Error("UKGOLF_API_KEY not set");
  if (callsThisMonth() >= config.ukgolfMonthlyLimit) throw Object.assign(new Error(`Monthly limit of ${config.ukgolfMonthlyLimit} UK Golf API calls reached`), { limit: true });
  const wait = last + config.ukgolfGapMs - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  last = Date.now();
  bump.run(PROVIDER, month());
  const r = await fetch(config.ukgolfBase + path, {
    headers: { "X-RapidAPI-Key": config.ukgolfKey, "X-RapidAPI-Host": config.ukgolfHost, "User-Agent": userAgent, Accept: "application/json" }
  });
  if (r.status === 429) throw Object.assign(new Error("UK Golf API rate limit hit"), { limit: true });
  if (!r.ok) throw new Error(`UK Golf API ${r.status} for ${path}: ${(await r.text()).slice(0, 150)}`);
  return r.json();
}

// ---- tolerant readers -------------------------------------------------------------------
const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== "") return o[k]; return null; };
const num = v => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
/** The list in a reply, whatever it's called. */
export function listOf(j, ...keys) {
  if (Array.isArray(j)) return j;
  for (const k of [...keys, "data", "results", "items", "clubs", "courses", "tee_sets", "teeSets", "tees"]) {
    if (Array.isArray(j?.[k])) return j[k];
    if (Array.isArray(j?.data?.[k])) return j.data[k];
  }
  return [];
}
const squash = s => String(s || "").toLowerCase().replace(/golf|club|course|links|the|&|and|ltd|[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 2);
export function nameSimilarity(a, b) {
  const A = new Set(squash(a)), B = new Set(squash(b));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

export function readTee(t) {
  const holes = listOf(t, "holes");
  const yards = num(pick(t, "total_yards", "yards", "yardage", "total_yardage", "length_yards", "length"))
    ?? (holes.length ? holes.reduce((s, h) => s + (num(pick(h, "yards", "yardage", "length")) || 0), 0) || null : null);
  return {
    name: String(pick(t, "name", "tee_name", "colour", "color", "tee") || "Tee"),
    colour: pick(t, "colour", "color", "tee_colour", "hex"),
    gender: pick(t, "gender", "sex"),
    yards,
    par: num(pick(t, "par", "total_par", "par_total")) ?? (holes.length ? holes.reduce((s, h) => s + (num(pick(h, "par")) || 0), 0) || null : null),
    rating: num(pick(t, "course_rating", "courseRating", "rating", "cr")),
    slope: num(pick(t, "slope", "slope_rating", "slopeRating", "sr")),
    holes: holes.length ? holes.map(h => ({ n: num(pick(h, "number", "hole", "hole_number")), par: num(pick(h, "par")), yards: num(pick(h, "yards", "yardage", "length")), si: num(pick(h, "si", "stroke_index", "handicap", "index")) })) : undefined
  };
}

/** Find this club in the UK Golf API, then fetch its courses' tee sets. Uses 2 calls. */
export async function fetchScorecard(row, { courseHint = "" } = {}) {
  const near = await call(`/clubs/nearby?lat=${row.lat.toFixed(5)}&lng=${row.lon.toFixed(5)}&radius_km=3`);
  const clubs = listOf(near, "clubs");
  const scored = clubs.map(c => ({ c, s: nameSimilarity(pick(c, "name", "club_name") || "", row.name) + nameSimilarity(pick(c, "name", "club_name") || "", courseHint) * 0.5 }))
    .sort((a, b) => b.s - a.s);
  const best = scored[0]?.s > 0 ? scored[0].c : clubs.length === 1 ? clubs[0] : null;
  if (!best) return { found: false, candidates: clubs.slice(0, 5).map(c => pick(c, "name", "club_name")) };
  const clubId = pick(best, "id", "club_id", "uuid", "slug");
  const rating = num(pick(best, "rating", "google_rating", "avg_rating"));
  const reviews = num(pick(best, "review_count", "reviews_count", "user_ratings_total", "google_review_count"));

  const cj = await call(`/clubs/${encodeURIComponent(clubId)}/courses`);
  const courses = listOf(cj, "courses").map(c => ({
    id: pick(c, "id", "course_id"), name: String(pick(c, "name", "course_name") || ""),
    tees: listOf(c, "tee_sets", "teeSets", "tees").map(readTee).filter(t => t.yards || t.slope || t.rating)
  }));
  const course = courses.length > 1 && courseHint
    ? courses.map(c => ({ c, s: nameSimilarity(c.name, courseHint) })).sort((a, b) => b.s - a.s)[0].c
    : courses.find(c => c.tees.length) || courses[0];
  return {
    found: true, clubId, clubName: pick(best, "name", "club_name"), rating, reviews,
    course: course ? { name: course.name, tees: course.tees } : null,
    otherCourses: courses.filter(c => c !== course).map(c => c.name)
  };
}

/** Save a scorecard into the course's details (kept when club websites are re-read). */
export function saveScorecard(row, sc) {
  const d = (() => { try { return JSON.parse(row.details || "{}"); } catch { return {}; } })();
  const tees = sc.course?.tees || [];
  const next = {
    ...d,
    ukgolf: { clubId: sc.clubId, clubName: sc.clubName, course: sc.course?.name || null, otherCourses: sc.otherCourses, fetchedAt: new Date().toISOString() },
    ...(tees.length ? { tees, teesSource: "UK Golf Course API", par: tees.find(t => t.par)?.par ?? d.par } : {})
  };
  q.setDetailsOnly.run(JSON.stringify(next), row.id);
  if (sc.rating) q.setRating.run(sc.rating, sc.reviews, row.id);
  return next;
}

/** Raw replies for one club, to check the field names (uses 2 calls). */
export async function probe(row) {
  const near = await call(`/clubs/nearby?lat=${row.lat.toFixed(5)}&lng=${row.lon.toFixed(5)}&radius_km=3`);
  const first = listOf(near, "clubs")[0];
  const id = first && pick(first, "id", "club_id", "uuid", "slug");
  const courses = id ? await call(`/clubs/${encodeURIComponent(id)}/courses`) : null;
  return { near, courses };
}
