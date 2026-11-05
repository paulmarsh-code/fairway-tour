// Build the course directory from Geofabrik's daily OpenStreetMap extracts instead of the
// busy public Overpass servers. Downloads the map files (about 2 GB in total), keeps only
// golf courses with osmium, then saves them. Takes roughly 10 minutes on a VPS.
// OpenStreetMap data is ODbL — the app shows "© OpenStreetMap contributors".
//
// Usage: npm run import:geofabrik
//        npm run import:geofabrik -- --keep     (keep the downloaded files for next time)
//        npm run import:geofabrik -- --file x.osm.pbf --country GB   (use a local file)
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { db } from "../src/db.js";
import { config, userAgent } from "../src/config.js";
import { saveElements } from "./osm-common.js";
import { milesBetween } from "../src/geo.js";

// Ireland first, then the UK: Northern Ireland is in both files, and the later
// UK pass sets those clubs to GB.
const REGIONS = [
  { country: "IE", url: "https://download.geofabrik.de/europe/ireland-and-northern-ireland-latest.osm.pbf" },
  { country: "GB", url: "https://download.geofabrik.de/europe/united-kingdom-latest.osm.pbf" }
];

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", e => reject(e.code === "ENOENT" ? new Error(`${cmd} is not installed (apt install osmium-tool)`) : e));
    p.on("exit", code => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0]} exited with ${code}`))));
  });
}

async function download(url, dest) {
  if (fs.existsSync(dest) && Date.now() - fs.statSync(dest).mtimeMs < 20 * 3600 * 1000) {
    console.log(`  using ${path.basename(dest)} downloaded in the last day`);
    return;
  }
  console.log(`  downloading ${url}`);
  const r = await fetch(url, { headers: { "User-Agent": userAgent } });
  if (!r.ok) throw new Error(`Download failed: ${r.status}`);
  const total = Number(r.headers.get("content-length")) || 0;
  let got = 0, shown = 0;
  const body = Readable.fromWeb(r.body);
  body.on("data", c => {
    got += c.length;
    if (got - shown > 200 * 1024 * 1024) { shown = got; console.log(`    ${(got / 1e9).toFixed(1)} GB${total ? ` of ${(total / 1e9).toFixed(1)} GB` : ""}`); }
  });
  await pipeline(body, fs.createWriteStream(dest + ".part"));
  fs.renameSync(dest + ".part", dest);
}

/** Centre of a GeoJSON geometry (middle of its bounding box — fine for "where is the club"). */
export function centre(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = c => {
    if (typeof c[0] === "number") { minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]); minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]); }
    else c.forEach(walk);
  };
  walk(geom.coordinates);
  return { lat: (minY + maxY) / 2, lon: (minX + maxX) / 2 };
}

const TYPE = { n: "node", w: "way", a: "area", r: "relation" };

/** Turn one osmium GeoJSON feature into the element shape saveElements() expects. */
export function featureToElement(f) {
  // osmium --add-unique-id=type_id gives ids like "w123", "r456", "n789".
  // Areas built from ways/relations come out as "a<2*id(+1 for relations)>".
  let type = TYPE[String(f.id)[0]], id = Number(String(f.id).slice(1));
  if (type === "area") { type = id % 2 ? "relation" : "way"; id = Math.floor(id / 2); }
  if (!type || !Number.isFinite(id) || !f.geometry) return null;
  const c = centre(f.geometry);
  return { type, id, lat: c.lat, lon: c.lon, tags: f.properties || {} };
}

const DONOR_MILES = 1.2;
/**
 * Many courses are drawn on the map as an outline with no name, while the name, website and
 * phone sit on a separate point for the club or clubhouse. Copy those details across from the
 * nearest named golf club/clubhouse point. Mutates and returns counts.
 */
export function borrowFromNearby(courses, donors) {
  let named = 0, websites = 0;
  for (const c of courses) {
    const t = c.tags || (c.tags = {});
    const needName = !t.name, needSite = !(t.website || t["contact:website"] || t.url);
    if (!needName && !needSite) continue;
    let best = null, bestD = Infinity;
    for (const d of donors) {
      const dist = milesBetween(c, d);
      if (dist < bestD && dist <= DONOR_MILES) { best = d; bestD = dist; }
    }
    if (!best) continue;
    const b = best.tags;
    if (needName) { t.name = b.name; named++; }
    if (needSite && (b.website || b["contact:website"] || b.url) && (!needName ? similarName(t.name, b.name) : true)) {
      t.website = b.website || b["contact:website"] || b.url; websites++;
    }
    for (const k of ["phone", "contact:phone", "email", "contact:email", "addr:town", "addr:city", "addr:village"]) if (!t[k] && b[k]) t[k] = b[k];
  }
  return { named, websites };
}

// Only borrow a website for an already-named course if the names look like the same club
const words = s => new Set(String(s).toLowerCase().replace(/golf|club|course|links|the|&|and|ltd/g, " ").split(/\W+/).filter(w => w.length > 2));
export function similarName(a, b) { const A = words(a), B = words(b); return [...A].some(w => B.has(w)); }

async function importFile(pbf, country, work) {
  const golf = path.join(work, `golf-${country}.osm.pbf`);
  const json = path.join(work, `golf-${country}.geojsonseq`);
  console.log("  keeping only golf courses…");
  await run("osmium", ["tags-filter", pbf, "nwr/leisure=golf_course", "nwr/club=golf", "nwr/golf=clubhouse", "nwr/sport=golf", "-o", golf, "--overwrite", "--progress"]);
  await run("osmium", ["export", golf, "-f", "geojsonseq", "-o", json, "--overwrite", "--add-unique-id=type_id", "--geometry-types=point,linestring,polygon"]);

  const seen = new Map(), donors = [];
  const rl = readline.createInterface({ input: fs.createReadStream(json) });
  for await (let line of rl) {
    line = line.replace(/^\x1e/, "").trim();
    if (!line) continue;
    let f; try { f = JSON.parse(line); } catch { continue; }
    const t = f.properties || {};
    const el = featureToElement(f);
    if (!el) continue;
    if (t.leisure === "golf_course") seen.set(`${el.type}/${el.id}`, el); // an area replaces its plain-way duplicate
    else if (t.name && (t.club === "golf" || t.golf === "clubhouse" || t.sport === "golf")) donors.push(el);
  }
  const fixed = borrowFromNearby([...seen.values()], donors);
  console.log(`  ${fixed.named} unnamed courses named from a nearby golf club or clubhouse; ${fixed.websites} websites borrowed.`);
  const r = saveElements(country, [...seen.values()]);
  console.log(`${country}: ${r.added} courses saved (${r.hidden} hidden as pitch & putt / mini golf / disused).`);
  fs.rmSync(golf, { force: true }); fs.rmSync(json, { force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const keep = args.includes("--keep");
  const work = path.join(config.dataDir, "osm");
  fs.mkdirSync(work, { recursive: true });
  try {
    const fileIdx = args.indexOf("--file");
    if (fileIdx >= 0) {
      const c = args[args.indexOf("--country") + 1] || "GB";
      await importFile(args[fileIdx + 1], c, work);
    } else {
      for (const { country, url } of REGIONS) {
        console.log(`${country}:`);
        const pbf = path.join(work, path.basename(url));
        await download(url, pbf);
        await importFile(pbf, country, work);
        if (!keep) fs.rmSync(pbf, { force: true });
      }
    }
    const n = db.prepare("SELECT COUNT(*) n, SUM(website<>'') w FROM courses WHERE hidden=0").get();
    console.log(`Directory now has ${n.n} visible courses, ${n.w || 0} with a website. All done.`);
  } catch (e) {
    console.error(`Import failed: ${e.message}`);
    process.exitCode = 1;
  }
}
