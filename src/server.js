import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { q, rowToCourse, newId } from "./db.js";
import { geocode, milesBetween, boundingBox } from "./geo.js";
import { forecast } from "./weather.js";
import { getTeeSheets, pruneCache } from "./teetimes/index.js";
import { detectBooking } from "./detect.js";
import { enrichCourse, fetchRating } from "./enrich.js";
import { aiEnabled } from "./ai.js";
import { closeBrowser } from "./browser.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: { level: process.env.LOG_LEVEL || "info" }, bodyLimit: 128 * 1024, trustProxy: true });

app.register(fastifyStatic, { root: path.join(here, "..", "public"), prefix: "/" });
app.get("/t/:id", (req, reply) => reply.sendFile("index.html"));

// --- tiny per-IP rate limiter -------------------------------------------------
const buckets = new Map();
function limit(req, name, perMinute) {
  const key = `${name}:${req.ip}`, now = Date.now();
  const b = buckets.get(key) || { n: 0, reset: now + 60000 };
  if (now > b.reset) { b.n = 0; b.reset = now + 60000; }
  b.n++; buckets.set(key, b);
  if (b.n > perMinute) throw Object.assign(new Error("Too many requests — wait a minute and try again"), { statusCode: 429 });
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); pruneCache(); }, 10 * 60000).unref();

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
const datesFrom = s => String(s || "").split(",").map(x => x.trim()).filter(isDate);
const fail = (status, message) => Object.assign(new Error(message), { statusCode: status });

app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode || err.status || 500;
  if (status >= 500) req.log.error(err);
  reply.code(status).send({ error: status >= 500 ? "Something went wrong on our side. Please try again." : err.message });
});

// --- health -------------------------------------------------------------------
app.get("/api/health", async () => ({ ok: true, ai: aiEnabled(), reviews: !!config.googlePlacesKey }));

// --- course search --------------------------------------------------------------
app.get("/api/search", async req => {
  limit(req, "search", 60);
  const radius = Math.min(Math.max(Number(req.query.radius) || 25, 1), 100);
  const origin = await geocode(req.query.location);
  const box = boundingBox(origin, radius);
  const rows = q.inBox.all(box.minLat, box.maxLat, box.minLon, box.maxLon);
  const courses = rows
    .map(r => ({ ...rowToCourse(r), miles: Math.round(milesBetween(origin, r) * 10) / 10 }))
    .filter(c => c.miles <= radius)
    .sort((a, b) => a.miles - b.miles)
    .slice(0, 80);
  return { origin, radius, courses };
});

app.get("/api/courses/:id", async req => {
  const c = rowToCourse(q.byId.get(req.params.id));
  if (!c) throw fail(404, "Course not found");
  return c;
});

// --- live tee times --------------------------------------------------------------
app.get("/api/courses/:id/teetimes", async req => {
  limit(req, "teetimes", 20);
  const dates = datesFrom(req.query.dates);
  if (!dates.length) throw fail(400, "Pick at least one date");
  const players = Math.min(Math.max(Number(req.query.players) || 4, 1), 4);
  return getTeeSheets(req.params.id, dates, players);
});

// Find the club's booking system on demand (for clubs the batch job hasn't reached yet)
app.post("/api/courses/:id/detect", async req => {
  limit(req, "detect", 10);
  const row = q.byId.get(req.params.id);
  if (!row) throw fail(404, "Course not found");
  const recent = row.detected_at && Date.now() - Date.parse(row.detected_at + "Z") < 7 * 86400000;
  if (!recent) await detectBooking(row);
  return rowToCourse(q.byId.get(row.id));
});

// Course details from the club website (+ review score), refreshed at most monthly
app.post("/api/courses/:id/enrich", async req => {
  limit(req, "enrich", 6);
  const row = q.byId.get(req.params.id);
  if (!row) throw fail(404, "Course not found");
  const stale = !row.enriched_at || Date.now() - Date.parse(row.enriched_at + "Z") > 30 * 86400000;
  if (stale) {
    if (aiEnabled() && row.website) await enrichCourse(row).catch(e => req.log.warn({ err: e.message }, "enrich failed"));
    await fetchRating(row).catch(() => null);
  }
  return rowToCourse(q.byId.get(row.id));
});

// --- weather --------------------------------------------------------------------
app.get("/api/weather", async req => {
  limit(req, "weather", 120);
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw fail(400, "lat and lon required");
  return forecast(lat, lon, datesFrom(req.query.dates).slice(0, 31));
});

// --- shared trips (anyone with the link can view and edit) ------------------------
const MAX_TRIP = 64 * 1024;
app.post("/api/trips", async req => {
  limit(req, "trips", 20);
  const data = JSON.stringify(req.body?.data ?? {});
  if (data.length > MAX_TRIP) throw fail(413, "Trip is too large");
  const id = newId(12);
  q.insertTrip.run(id, data);
  return { id, version: 1 };
});
app.get("/api/trips/:id", async req => {
  const t = q.getTrip.get(req.params.id);
  if (!t) throw fail(404, "Trip not found — check the link");
  return { id: t.id, version: t.version, data: JSON.parse(t.data), updatedAt: t.updated_at };
});
app.put("/api/trips/:id", async (req, reply) => {
  limit(req, "trip-save", 120);
  const t = q.getTrip.get(req.params.id);
  if (!t) throw fail(404, "Trip not found");
  const data = JSON.stringify(req.body?.data ?? {});
  if (data.length > MAX_TRIP) throw fail(413, "Trip is too large");
  const res = q.updateTrip.run(data, t.id, Number(req.body?.version));
  if (!res.changes) {
    const cur = q.getTrip.get(t.id);
    return reply.code(409).send({ error: "Someone else changed this trip", version: cur.version, data: JSON.parse(cur.data) });
  }
  return { version: Number(req.body.version) + 1 };
});

// --- admin: fix a club's booking page / date pattern / ranking -----------------------
app.patch("/api/admin/courses/:id", async req => {
  if (!config.adminToken || req.headers.authorization !== `Bearer ${config.adminToken}`) throw fail(401, "Admin token required");
  const row = q.byId.get(req.params.id);
  if (!row) throw fail(404, "Course not found");
  const b = req.body || {};
  if (b.bookingUrl !== undefined) q.setBooking.run(b.bookingSystem || "other", String(b.bookingUrl), "", row.id);
  if (b.dateTemplate !== undefined) q.setTemplate.run(String(b.dateTemplate), row.id);
  if (b.rankLabel !== undefined || b.rankScore !== undefined) q.setRank.run(String(b.rankLabel || ""), b.rankScore ?? null, row.id);
  if (b.hidden !== undefined) q.setHidden.run(b.hidden ? 1 : 0, row.id);
  return rowToCourse(q.byId.get(row.id));
});

const stop = async () => { await app.close(); await closeBrowser(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

await app.listen({ port: config.port, host: config.host });

// First boot on a fresh disk: build the course directory in the background.
import { db } from "./db.js";
import { spawn } from "node:child_process";
if (db.prepare("SELECT COUNT(*) n FROM courses").get().n === 0 && process.env.AUTO_IMPORT !== "0") {
  app.log.info("Course directory is empty — importing UK & Ireland courses from OpenStreetMap in the background");
  const child = spawn(process.execPath, [path.join(here, "..", "scripts", "import-osm.js")], { stdio: "inherit", env: process.env });
  child.on("exit", code => app.log.info(`Course import finished (exit ${code})`));
}
