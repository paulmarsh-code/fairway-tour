// Scorecards and review scores from the UK Golf Course Data API.
// Usage: npm run ukgolf -- probe "Royal Aberdeen"     raw replies for one club (2 calls) — to check field names
//        npm run ukgolf -- club "Royal Aberdeen"      fetch and save one club (2 calls)
//        npm run ukgolf -- curated [max]              fetch every ranked club not yet fetched (2 calls each)
//        npm run ukgolf -- usage                      calls used this month
import { db, q } from "../src/db.js";
import { config } from "../src/config.js";
import { fetchScorecard, saveScorecard, probe, callsThisMonth } from "../src/ukgolf.js";

const [cmd, arg] = process.argv.slice(2);
const find = who => q.byId.get(who) || db.prepare("SELECT * FROM courses WHERE name LIKE ? ORDER BY curated<>'' DESC, length(name) LIMIT 1").get(`%${who}%`);
const hint = row => { try { return JSON.parse(row.curated || "{}").courses?.[0] || ""; } catch { return ""; } };
const show = (row, sc) => {
  if (!sc.found) return console.log(`  ✗ ${row.name}: not found nearby${sc.candidates?.length ? ` (nearby: ${sc.candidates.join(", ")})` : ""}`);
  const t = sc.course?.tees || [];
  console.log(`  ✓ ${row.name} → ${sc.clubName}${sc.course ? ` / ${sc.course.name}` : ""}: ${t.length} tees${t.length ? ` (${t.map(x => `${x.name} ${x.yards ?? "?"}y ${x.rating ?? "?"}/${x.slope ?? "?"}`).join(", ")})` : ""}${sc.rating ? `, ★ ${sc.rating}${sc.reviews ? ` (${sc.reviews})` : ""}` : ""}`);
};

if (!config.ukgolfKey && cmd !== "usage") { console.log("Set UKGOLF_API_KEY in .env first (free plan on RapidAPI)."); process.exit(1); }
try {
  if (cmd === "usage") console.log(`UK Golf API calls this month: ${callsThisMonth()} of ${config.ukgolfMonthlyLimit}`);
  else if (cmd === "probe") {
    const row = find(arg); if (!row) throw new Error(`No club matching "${arg}"`);
    console.log(JSON.stringify(await probe(row), null, 1).slice(0, 6000));
  } else if (cmd === "club") {
    const row = find(arg); if (!row) throw new Error(`No club matching "${arg}"`);
    const sc = await fetchScorecard(row, { courseHint: hint(row) }); show(row, sc); if (sc.found) saveScorecard(row, sc);
  } else if (cmd === "curated") {
    const max = Number(arg) || 999;
    const rows = q.curatedAll.all().filter(r => !JSON.parse(r.details || "{}").ukgolf).sort((a, b) => (b.rank_score || 0) - (a.rank_score || 0)).slice(0, max);
    console.log(`${rows.length} ranked clubs to fetch (~${rows.length * 2} calls, about ${Math.ceil(rows.length * 2 * config.ukgolfGapMs / 60000)} minutes). Used so far this month: ${callsThisMonth()}.`);
    for (const row of rows) {
      try { const sc = await fetchScorecard(row, { courseHint: hint(row) }); show(row, sc); if (sc.found) saveScorecard(row, sc); }
      catch (e) { console.log(`  ! ${row.name}: ${e.message}`); if (e.limit) break; }
    }
    console.log(`Done. Calls used this month: ${callsThisMonth()} of ${config.ukgolfMonthlyLimit}.`);
  } else console.log('Usage: npm run ukgolf -- probe|club|curated|usage ["club name"]');
} catch (e) { console.log(e.message); process.exitCode = 1; }
