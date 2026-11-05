// Clear saved results so they are fetched again with the latest code.
// Usage: npm run reset -- details     (course details and conditions)
//        npm run reset -- teetimes    (cached tee sheets and saved date patterns)
//        npm run reset -- all
import { db } from "../src/db.js";

const what = process.argv[2] || "";
if (!["details", "teetimes", "all"].includes(what)) { console.log("Usage: npm run reset -- details | teetimes | all"); process.exit(1); }
if (what === "details" || what === "all") {
  const r = db.prepare("UPDATE courses SET enriched_at=NULL, details='{}' WHERE enriched_at IS NOT NULL OR details<>'{}'").run();
  console.log(`Cleared details for ${r.changes} clubs; they'll be read again when opened.`);
}
if (what === "teetimes" || what === "all") {
  const a = db.prepare("DELETE FROM tee_sheets").run();
  const b = db.prepare("UPDATE courses SET date_template='' WHERE date_template<>''").run();
  console.log(`Cleared ${a.changes} cached tee sheets and ${b.changes} saved date patterns.`);
}
