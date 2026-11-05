import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new Database(path.join(config.dataDir, "fairway.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS courses (
  id              TEXT PRIMARY KEY,          -- e.g. osm-way-12345 or a slug
  name            TEXT NOT NULL,
  town            TEXT DEFAULT '',
  country         TEXT DEFAULT '',           -- GB / IE
  lat             REAL NOT NULL,
  lon             REAL NOT NULL,
  website         TEXT DEFAULT '',
  phone           TEXT DEFAULT '',
  email           TEXT DEFAULT '',
  holes           INTEGER,
  booking_system  TEXT DEFAULT '',           -- brs | intelligentgolf | chronogolf | clubv1 | golfnow | other | none
  booking_url     TEXT DEFAULT '',
  date_template   TEXT DEFAULT '',           -- URL with {YYYY}{MM}{DD} tokens that opens the tee sheet for a date
  details         TEXT DEFAULT '{}',         -- JSON: tees, fees, hire, catering, practice, visitor days...
  rating          REAL,                      -- review score (e.g. Google) if configured
  rating_count    INTEGER,
  rank_label      TEXT DEFAULT '',
  rank_score      REAL,
  hidden          INTEGER DEFAULT 0,         -- 1 = exclude from search (pitch & putt, closed...)
  detected_at     TEXT,
  enriched_at     TEXT,
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS courses_latlon ON courses(lat, lon);

CREATE TABLE IF NOT EXISTS tee_sheets (
  course_id   TEXT NOT NULL,
  date        TEXT NOT NULL,
  players     INTEGER NOT NULL,
  fetched_at  INTEGER NOT NULL,              -- ms epoch
  result      TEXT NOT NULL,                 -- JSON {status, times, note, url}
  PRIMARY KEY (course_id, date, players)
);

CREATE TABLE IF NOT EXISTS trips (
  id          TEXT PRIMARY KEY,
  data        TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);
`);

const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

export function rowToCourse(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, town: r.town, country: r.country, lat: r.lat, lon: r.lon,
    website: r.website, phone: r.phone, email: r.email, holes: r.holes,
    bookingSystem: r.booking_system, bookingUrl: r.booking_url, hasDateTemplate: !!r.date_template,
    details: parse(r.details, {}), rating: r.rating, ratingCount: r.rating_count,
    rankLabel: r.rank_label, rankScore: r.rank_score, enrichedAt: r.enriched_at
  };
}

export const q = {
  allVisible: db.prepare("SELECT * FROM courses WHERE hidden = 0"),
  inBox: db.prepare("SELECT * FROM courses WHERE hidden = 0 AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?"),
  byId: db.prepare("SELECT * FROM courses WHERE id = ?"),
  upsertCourse: db.prepare(`
    INSERT INTO courses (id, name, town, country, lat, lon, website, phone, email, holes, hidden)
    VALUES (@id, @name, @town, @country, @lat, @lon, @website, @phone, @email, @holes, @hidden)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, town=CASE WHEN excluded.town<>'' THEN excluded.town ELSE courses.town END,
      country=excluded.country, lat=excluded.lat, lon=excluded.lon,
      website=CASE WHEN courses.website='' THEN excluded.website ELSE courses.website END,
      phone=CASE WHEN courses.phone='' THEN excluded.phone ELSE courses.phone END,
      email=CASE WHEN courses.email='' THEN excluded.email ELSE courses.email END,
      holes=COALESCE(excluded.holes, courses.holes), updated_at=datetime('now')`),
  setBooking: db.prepare("UPDATE courses SET booking_system=?, booking_url=?, website=COALESCE(NULLIF(?, ''), website), detected_at=datetime('now'), updated_at=datetime('now') WHERE id=?"),
  setContact: db.prepare("UPDATE courses SET email=?, phone=?, updated_at=datetime('now') WHERE id=?"),
  setTemplate: db.prepare("UPDATE courses SET date_template=?, updated_at=datetime('now') WHERE id=?"),
  setDetails: db.prepare("UPDATE courses SET details=?, enriched_at=datetime('now'), updated_at=datetime('now') WHERE id=?"),
  setRating: db.prepare("UPDATE courses SET rating=?, rating_count=?, updated_at=datetime('now') WHERE id=?"),
  setRank: db.prepare("UPDATE courses SET rank_label=?, rank_score=?, updated_at=datetime('now') WHERE id=?"),
  setHidden: db.prepare("UPDATE courses SET hidden=? WHERE id=?"),
  needDetection: db.prepare("SELECT * FROM courses WHERE hidden=0 AND website<>'' AND (detected_at IS NULL OR detected_at < datetime('now', ?)) ORDER BY detected_at IS NOT NULL, name LIMIT ?"),

  getSheet: db.prepare("SELECT * FROM tee_sheets WHERE course_id=? AND date=? AND players=?"),
  putSheet: db.prepare("INSERT OR REPLACE INTO tee_sheets (course_id, date, players, fetched_at, result) VALUES (?, ?, ?, ?, ?)"),
  pruneSheets: db.prepare("DELETE FROM tee_sheets WHERE fetched_at < ?"),

  getTrip: db.prepare("SELECT * FROM trips WHERE id=?"),
  insertTrip: db.prepare("INSERT INTO trips (id, data) VALUES (?, ?)"),
  updateTrip: db.prepare("UPDATE trips SET data=?, version=version+1, updated_at=datetime('now') WHERE id=? AND version=?")
};

export const newId = (bytes = 16) => crypto.randomBytes(bytes).toString("base64url");
