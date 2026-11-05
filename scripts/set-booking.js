// Point a club at the right visitor booking page by hand (and clear its old results).
// Usage: npm run set-booking -- "Trump International Scotland" https://www.chronogolf.com/club/trump-international-scotland [system]
//        system: brs | chronogolf | intelligentgolf | email | other   (worked out from the address if left out)
import { db, q } from "../src/db.js";
import { detectSystem } from "../src/teetimes/systems.js";

const [who, url, sys] = process.argv.slice(2);
if (!who || !/^https?:\/\//.test(url || "")) { console.log('Usage: npm run set-booking -- "Club name" https://booking-page [system]'); process.exit(1); }
const row = q.byId.get(who) || db.prepare("SELECT * FROM courses WHERE name LIKE ? AND hidden=0 ORDER BY length(name) LIMIT 1").get(`%${who}%`);
if (!row) { console.log(`No club matching "${who}"`); process.exit(1); }
const system = sys || detectSystem(url)?.id || "other";
q.setBooking.run(system, url, "", row.id);
q.setTemplate.run("", row.id);
db.prepare("DELETE FROM tee_sheets WHERE course_id=?").run(row.id);
console.log(`${row.name}: booking page set to ${url} (${system}). Tap Live tee times in the app to try it.`);
