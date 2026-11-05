// Load a curated "top courses & hidden gems" list (curated/<region>.json) and attach the
// rankings to the matching clubs in the directory. Clubs the map data lacks are added.
// Usage: npm run curated                 (all files in curated/)
//        npm run curated -- --dry        (show matches without saving)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { q } from "../src/db.js";
import { geocode, boundingBox, milesBetween } from "../src/geo.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "curated");
const dry = process.argv.includes("--dry");
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Ranking badges for one curated entry, best first. */
export function ranksFor(entry, sources) {
  const out = [];
  const add = (key, rank, label, score) => sources[key] && out.push({ source: key, rank, label, sourceLabel: sources[key].label, url: sources[key].url, score });
  if (entry.ncg) add("ncg", entry.ncg, `#${entry.ncg} in Scotland`, 100 - entry.ncg * 0.9);
  if (entry.t100) add("t100", entry.t100, `#${entry.t100} GB&I`, 100 - entry.t100 * 0.45);
  if (entry.gm) add("gm", entry.gm, `#${entry.gm} UK & Ireland`, 100 - entry.gm * 0.45);
  if (entry.gd) add("gd", entry.gd, `#${entry.gd} UK & Ireland`, 100 - entry.gd * 0.45);
  if (entry.gm101) add("gm101", null, "UK & Ireland Next 100", 45);
  if (entry.gp) add("gp", entry.gp, `Hidden gem #${entry.gp}`, 40 - entry.gp * 0.5);
  return out.sort((a, b) => b.score - a.score);
}

export function tierFor(entry) {
  return (entry.ncg && entry.ncg <= 30) || entry.gm || entry.t100 || (entry.gd && entry.gd <= 50) ? "top" : "gem";
}

const words = s => String(s).toLowerCase();
/** How well a directory club matches a curated entry: its match words, minus excluded words, minus distance. */
export function matchScore(entry, row, miles) {
  const name = words(row.name);
  let score = 0;
  for (const m of entry.match || []) if (name.includes(m)) score += 3;
  for (const x of entry.exclude || []) if (name.includes(x)) score -= 10;
  if (/pitch|putt|mini|driving range|footgolf/.test(name)) score -= 10;
  return score - miles * 0.5;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  if (!dry) q.clearCurated.run();
  const byRow = new Map(); // course id -> {row, entries[]}
  let added = 0;

  for (const f of files) {
    const list = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    console.log(`\n${list.region}: ${list.courses.length} courses`);
    for (const entry of list.courses) {
      let where;
      try { where = await geocode(`${entry.town}, ${list.region}`); await sleep(1100); }
      catch { console.log(`  ?  ${entry.name}: couldn't find "${entry.town}"`); continue; }
      const box = boundingBox(where, 4);
      const cands = q.inBoxAll.all(box.minLat, box.maxLat, box.minLon, box.maxLon)
        .map(row => ({ row, miles: milesBetween(where, row) }))
        .filter(c => c.miles <= 4)
        .map(c => ({ ...c, score: matchScore(entry, c.row, c.miles) }))
        .sort((a, b) => b.score - a.score);
      let row = cands[0]?.score >= 1 ? cands[0].row : null;
      if (!row) {
        const id = "manual-" + entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        row = q.byId.get(id);
        if (!row && !dry) {
          q.upsertCourse.run({ id, name: entry.name, town: entry.town, country: "GB", lat: where.lat, lon: where.lon, website: "", phone: "", email: "", holes: 18, hidden: 0 });
          row = q.byId.get(id); added++;
        }
        console.log(`  +  ${entry.name}  (not in map data: added at ${entry.town}${cands[0] ? `; nearest was "${cands[0].row.name}"` : ""})`);
        if (!row) continue;
      } else console.log(`  ✓  ${entry.name}  →  "${row.name}" (${cands[0].miles.toFixed(1)} mi)`);
      const item = byRow.get(row.id) || { row, entries: [], sources: list.sources };
      item.entries.push(entry);
      byRow.set(row.id, item);
    }
  }

  for (const { row, entries, sources } of byRow.values()) {
    const ranks = entries.flatMap(e => ranksFor(e, sources).map(r => ({ ...r, course: entries.length > 1 ? e.name : undefined })))
      .sort((a, b) => b.score - a.score);
    const tier = entries.some(e => tierFor(e) === "top") ? "top" : "gem";
    const curated = {
      displayName: entries.length === 1 ? entries[0].name : null,
      courses: entries.map(e => e.name),
      tier, ranks: ranks.slice(0, 8),
      access: entries.map(e => e.access).filter(Boolean)[0] || ""
    };
    const best = ranks[0];
    if (!dry) q.setCurated.run(JSON.stringify(curated), best ? `${best.label} (${best.sourceLabel})` : "", best?.score ?? null, row.id);
  }
  console.log(`\n${dry ? "Would attach" : "Attached"} rankings to ${byRow.size} clubs; ${added} added that the map data lacked.`);
}
