// Fairway Tour Planner — front end. Talks to the API in src/server.js.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = v => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const money = (n, cur = "£") => (n == null ? "—" : cur + Math.round(n).toLocaleString("en-GB"));
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TIMES = []; for (let h = 7; h <= 15; h++) for (const m of ["00", "30"]) TIMES.push(String(h).padStart(2, "0") + ":" + m);
const RADII = [10, 25, 50, 75];
const SYSTEM_LABEL = { email: "email", blocked: "club website", brs: "BRS Golf", intelligentgolf: "IntelligentGolf", chronogolf: "Chronogolf", clubv1: "Club V1", golfnow: "GolfNow", howdidido: "HowDidiDo", golfmanager: "Golfmanager", other: "club website" };

/* ---------------- dates ---------------- */
const isoToday = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = parseD(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function parseD(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; }
function tripDays() {
  const a = parseD(T.from), b = parseD(T.to); if (!a || !b || b < a) return [];
  const out = []; for (let d = new Date(a); d <= b && out.length < 31; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}
const dParts = s => { const d = parseD(s); return { dw: DOW[d.getUTCDay()], dn: d.getUTCDate(), dm: MON[d.getUTCMonth()] }; };
const longDate = s => { const p = dParts(s); return `${p.dw} ${p.dn} ${p.dm}`; };
function rangeLabel() {
  const a = parseD(T.from), b = parseD(T.to); if (!a || !b) return "Dates not set";
  return `${a.getUTCDate()} ${MON[a.getUTCMonth()]} – ${b.getUTCDate()} ${MON[b.getUTCMonth()]}`;
}
const playDates = () => Object.keys(T.playDays).filter(d => tripDays().includes(d)).sort();
const targetDates = () => { const p = playDates(); return (p.length ? p : tripDays()).slice(0, 10); };

/* ---------------- state ---------------- */
const defaults = () => {
  const from = addDays(isoToday(), 14);
  return { location: "", from, to: addDays(from, 3), radius: 25, group: 4, sort: "rank", view: "curated",
    playDays: {}, shortlist: [], buggies: "none", trolleys: "none", approved: false,
    booker: { name: "", phone: "" }, emails: {}, sent: {}, confirmed: {} };
};
let T = defaults();
const S = { tripId: null, version: 0, dirty: false, saving: false, results: [], origin: null, courses: {}, live: {}, weather: {}, open: {}, enriching: {}, searched: false };

/* ---------------- API ---------------- */
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: opts.body ? { "Content-Type": "application/json" } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Request failed (${r.status})`), { status: r.status, body: j });
  return j;
}

/* ---------------- sync (shared trip) ---------------- */
let saveTimer;
function save() {
  S.dirty = true; setSync("Saving…");
  clearTimeout(saveTimer); saveTimer = setTimeout(flush, 700);
}
async function flush() {
  if (!S.tripId || S.saving) return;
  S.saving = true;
  const sent = JSON.stringify(T);
  try {
    const r = await api(`/api/trips/${S.tripId}`, { method: "PUT", body: { data: T, version: S.version } });
    S.version = r.version;
    if (JSON.stringify(T) === sent) { S.dirty = false; setSync("Saved"); }
  } catch (e) {
    if (e.status === 409) { T = { ...defaults(), ...e.body.data }; S.version = e.body.version; S.dirty = false; renderAll(); toast("Updated with a change from your group — please redo your last change"); setSync("Saved"); }
    else setSync("Not saved — check connection");
  } finally { S.saving = false; if (S.dirty) saveTimer = setTimeout(flush, 1500); }
}
async function ensureTrip() {
  if (S.tripId) return;
  const r = await api("/api/trips", { method: "POST", body: { data: T } });
  S.tripId = r.id; S.version = r.version;
  history.replaceState(null, "", `/t/${r.id}${location.hash}`);
  renderShare();
}
setInterval(async () => {
  if (!S.tripId || S.dirty || S.saving || document.hidden) return;
  try {
    const r = await api(`/api/trips/${S.tripId}`);
    if (r.version > S.version) { const prevLoc = [T.location, T.radius].join(); T = { ...defaults(), ...r.data }; S.version = r.version; if ([T.location, T.radius].join() !== prevLoc) await search(); renderAll(); toast("Trip updated by your group"); }
  } catch {}
}, 25000);
function setSync(t) { $("sync").textContent = S.tripId ? t : ""; }

/* ---------------- helpers ---------------- */
let toastT;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2800); }
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied"); }
  catch { const f = $("copyFallback"); f.value = text; f.select(); try { document.execCommand("copy"); toast("Copied"); } catch { toast("Select the text and copy it"); } }
}
const course = id => S.courses[id] || null;
const det = c => c?.details || {};
const cur = c => det(c).currency || (c?.country === "IE" ? "€" : "£");
const liveDay = (c, d) => S.live[c.id]?.dates?.[d] || null;
/** The adult visitor rate for the trip's season, from the fees the club publishes. */
function enrichedFee(c) {
  const fees = (det(c).greenFees || []).map(x => ({ label: String(x.label || "").toLowerCase(), price: num(x.price) })).filter(x => x.price != null);
  if (!fees.length) return null;
  const adult = fees.filter(f => !/junior|juvenile|child|student|under|u\d\d|youth|twilight|evening|after \d|9[- ]hole|member|society|senior|concession|ladies/.test(f.label));
  const m = parseD(T.from)?.getUTCMonth() ?? new Date().getMonth();
  const winter = m >= 10 || m <= 2;
  const season = adult.filter(f => winter ? /winter/.test(f.label) : /summer/.test(f.label));
  const pick = season.length ? season : adult.filter(f => !/summer|winter/.test(f.label)).length ? adult.filter(f => !/summer|winter/.test(f.label)) : adult;
  return pick.length ? Math.min(...pick.map(f => f.price)) : Math.max(...fees.map(f => f.price));
}
function liveMin(c, d) {
  const days = d ? [liveDay(c, d)] : Object.values(S.live[c.id]?.dates || {});
  const p = days.flatMap(x => (x?.times || []).map(t => num(t.price))).filter(x => x != null);
  return p.length ? Math.min(...p) : null;
}
function feeOf(c, d) { return num(T.confirmed[c.id]) ?? liveMin(c, d) ?? liveMin(c) ?? enrichedFee(c); }
function feeKind(c, d) { return num(T.confirmed[c.id]) != null ? "Confirmed" : (liveMin(c, d) ?? liveMin(c)) != null ? "Live price" : enrichedFee(c) != null ? "Club website" : "Price"; }
function unapprove() { if (T.approved) { T.approved = false; toast("Itinerary changed — approve it again before booking"); } }

/* ---------------- search ---------------- */
async function search() {
  const st = $("scanStatus");
  if (!T.location) return;
  st.hidden = false; st.className = "status"; st.innerHTML = `<span class="spin"></span> Finding courses within ${T.radius} miles of ${esc(T.location)}…`;
  try {
    const r = await api(`/api/search?location=${encodeURIComponent(T.location)}&radius=${T.radius}`);
    S.origin = r.origin; S.results = r.courses.map(c => c.id); S.searched = true;
    S.curatedCount = r.curatedCount || 0; S.totalCount = r.totalCount || r.courses.length;
    r.courses.forEach(c => (S.courses[c.id] = { ...S.courses[c.id], ...c }));
    // make sure picked courses outside the new radius are still loaded
    await Promise.all(T.shortlist.filter(id => !S.courses[id]).map(id => api(`/api/courses/${id}`).then(c => (S.courses[id] = c)).catch(() => {})));
    st.textContent = S.curatedCount
      ? `${S.curatedCount} top course${S.curatedCount === 1 ? "" : "s"} & hidden gems (of ${S.totalCount} courses) within ${T.radius} miles of ${r.origin.label}.`
      : `${S.totalCount} courses within ${T.radius} miles of ${r.origin.label}. None of them are on our ranked list yet, so all are shown.`;
  } catch (e) { st.className = "status warn"; st.textContent = e.message; }
  renderAll();
}

/* ---------------- live tee times ---------------- */
async function loadLive(id) {
  const c = course(id); if (!c) return;
  const dates = targetDates();
  if (!dates.length) { toast("Set your trip dates first"); return; }
  S.live[id] = { ...(S.live[id] || {}), loading: true, error: "" }; renderCourses();
  try {
    if (!c.bookingUrl && !c.bookingSystem) { const u = await api(`/api/courses/${id}/detect`, { method: "POST" }); S.courses[id] = { ...c, ...u }; }
    else if (!S.courses[id].detectedFresh) { try { S.courses[id] = { ...S.courses[id], ...(await api(`/api/courses/${id}`)), detectedFresh: true }; } catch {} }
    const r = await api(`/api/courses/${id}/teetimes?dates=${dates.join(",")}&players=${Math.min(T.group, 4)}`);
    S.live[id] = { ...r, loading: false, at: Date.now() };
  } catch (e) { S.live[id] = { loading: false, error: e.message, dates: {} }; }
  renderAll();
}
async function loadDetails(id) {
  if (S.enriching[id]) return;
  S.enriching[id] = "loading";
  const c = course(id);
  if (!c.enrichedAt) {
    try { S.courses[id] = { ...c, ...(await api(`/api/courses/${id}/enrich`, { method: "POST" })) }; }
    catch (e) { S.courses[id] = { ...c, enrichError: e.message }; }
  }
  S.enriching[id] = "done";
  try { const full = await api(`/api/courses/${id}`); S.courses[id] = { ...course(id), reports: full.reports, curated: full.curated }; } catch {}
  renderCourses();
  if (det(course(id)).statusUrl) {
    try { const r = await api(`/api/courses/${id}/conditions`, { method: "POST" }); S.courses[id] = { ...course(id), details: { ...det(course(id)), conditions: r.conditions, conditionsCheckedAt: r.checkedAt } }; } catch {}
  }
  if (!S.weather[id]) { try { S.weather[id] = await api(`/api/weather?lat=${c.lat}&lon=${c.lon}&dates=${tripDays().join(",")}`); } catch { S.weather[id] = { error: true }; } }
  renderCourses();
}

/* ---------------- header + share ---------------- */
function renderStrip() {
  const rounds = playDates().filter(d => T.playDays[d]?.courseId).length;
  $("strip").innerHTML = `<span><b>${esc(T.location || "Choose a location")}</b></span><span>${esc(rangeLabel())}</span><span>${T.radius} mi</span><span>${T.group} golfer${T.group > 1 ? "s" : ""}</span><span>${rounds} round${rounds === 1 ? "" : "s"}</span>`;
}
function renderShare() {
  $("sharePanel").hidden = !S.tripId;
  if (!S.tripId) return;
  const url = `${location.origin}/t/${S.tripId}`;
  $("shareUrl").value = url;
  $("waTrip").href = "https://wa.me/?text=" + encodeURIComponent(`Golf trip planner for ${T.location || "our trip"} (${rangeLabel()}): ${url}`);
}

/* ---------------- step 1 ---------------- */
function renderTrip() {
  if (document.activeElement !== $("loc")) $("loc").value = T.location;
  $("from").value = T.from; $("to").value = T.to; $("grp").textContent = T.group;
  $("radius").innerHTML = RADII.map(r => `<button type="button" class="chip-btn" data-r="${r}" aria-pressed="${T.radius === r}">${r} mi</button>`).join("");
  renderDayPicker("dayPicker");
}
function renderDayPicker(id) {
  const days = tripDays();
  $(id).innerHTML = days.length ? days.map(d => { const p = dParts(d);
    return `<button type="button" class="day" data-day="${d}" aria-pressed="${!!T.playDays[d]}"><span class="dw">${p.dw}</span><span class="dn">${p.dn}</span><span class="dm">${p.dm}</span></button>`; }).join("")
    : `<p class="note">Set your arriving and leaving dates first.</p>`;
}

/* ---------------- ranking, conditions ---------------- */
const nameOf = c => c?.curated?.displayName || c?.name || "";
const REPORT_LABELS = { tempGreens: "Temporary greens", tempTees: "Temporary tees", mats: "Fairway mats", hollowTined: "Greens hollow-tined", overseeded: "Recently overseeded", buggiesBanned: "No buggies", wet: "Wet / soft", excellent: "In great condition" };
/** Things that could spoil a round, from the club's status page and recent golfer reports. */
function condAlerts(c) {
  const out = [], C = det(c).conditions;
  if (C) {
    if (C.status === "closed") out.push({ t: "Course closed", src: "club" });
    else if (C.status === "restricted") out.push({ t: "Restrictions in place", src: "club" });
    if (C.temporaryGreens) out.push({ t: "Temporary greens", src: "club" });
    if (C.temporaryTees) out.push({ t: "Temporary tees", src: "club" });
    if (C.mats) out.push({ t: "Fairway mats", src: "club" });
    if (C.buggies && /not|restrict/i.test(C.buggies)) out.push({ t: `Buggies ${C.buggies}`, src: "club" });
    if (C.maintenance) out.push({ t: C.maintenance, src: "club" });
  }
  const recent = (c.reports || []).filter(r => r.playedOn >= addDays(isoToday(), -21));
  for (const k of Object.keys(REPORT_LABELS)) {
    if (k === "excellent") continue;
    const hits = recent.filter(r => r.flags?.[k]);
    if (hits.length && !out.some(o => o.t === REPORT_LABELS[k])) out.push({ t: REPORT_LABELS[k], src: `golfers, ${hits[0].playedOn.slice(8)}/${hits[0].playedOn.slice(5, 7)}` });
  }
  return out;
}
function condSummary(c) {
  const a = condAlerts(c);
  if (a.length) return a.slice(0, 4).map(x => `<span class="pill warn" title="Source: ${esc(x.src)}">⚠ ${esc(x.t)}</span>`).join(" ");
  const d = det(c), good = (c.reports || []).some(r => r.flags?.excellent && r.playedOn >= addDays(isoToday(), -21));
  if (good) return `<span class="pill good">Golfers report it's in great condition</span>`;
  if (d.conditions && d.conditionsCheckedAt) return `<span class="pill good">No restrictions on the club's status page</span>`;
  return "";
}
function rankBadges(c, max = 1) {
  const cu = c.curated;
  if (!cu) return "";
  const tier = cu.tier === "top" ? `<span class="pill good">Top course</span>` : `<span class="pill">Hidden gem</span>`;
  const r = (cu.ranks || []).slice(0, max).map(x => `<a class="rank" href="${esc(x.url)}" target="_blank" rel="noopener" title="${esc(x.sourceLabel)}">★ ${esc(x.label)}${x.course ? ` · ${esc(x.course)}` : ""}</a>`).join(" ");
  return `<div class="badges">${tier} ${r}${cu.access ? ` <span class="pill warn">${esc(cu.access)}</span>` : ""}</div>`;
}

/* ---------------- step 2 ---------------- */
const SORTS = { rank: "Ranking", nearest: "Nearest", rating: "Best reviewed", price: "Cheapest" };
function sortedCourses() {
  let list = S.results.map(course).filter(Boolean);
  if (T.view === "curated" && list.some(c => c.curated)) list = list.filter(c => c.curated);
  const f = {
    nearest: (a, b) => (a.miles ?? 999) - (b.miles ?? 999),
    rank: (a, b) => (b.rankScore ?? -1) - (a.rankScore ?? -1) || (b.rating ?? 0) - (a.rating ?? 0),
    rating: (a, b) => (b.rating ?? 0) - (a.rating ?? 0),
    price: (a, b) => (feeOf(a) ?? 1e9) - (feeOf(b) ?? 1e9)
  }[T.sort] || (() => 0);
  return list.slice().sort(f);
}
function renderCourses() {
  const list = sortedCourses();
  $("coursesTitle").textContent = S.searched ? `${list.length} course${list.length === 1 ? "" : "s"} near ${S.origin?.label || T.location}` : "Courses";
  $("coursesLede").textContent = S.searched
    ? "Ranked courses first, with their rankings, scorecards, current conditions and how to book. Add the ones you like, or let the app plan the trip for you."
    : "Enter a location on the Trip step to find courses.";
  $("view").innerHTML = S.searched ? [["curated", `Top & hidden gems${S.curatedCount != null ? ` (${S.curatedCount})` : ""}`], ["all", `All courses${S.totalCount != null ? ` (${S.totalCount})` : ""}`]]
    .map(([k, v]) => `<button type="button" class="chip-btn" data-view="${k}" aria-pressed="${(T.view || "curated") === k}">${v}</button>`).join("") : "";
  $("sort").innerHTML = Object.entries(SORTS).map(([k, v]) => `<button type="button" class="chip-btn" data-sort="${k}" aria-pressed="${T.sort === k}">${v}</button>`).join("");
  $("courseList").innerHTML = !S.searched ? `<div class="empty"><strong>No search yet.</strong><a class="btn primary" href="#trip">Choose a location</a></div>`
    : list.length ? list.map(courseCard).join("")
    : `<div class="empty"><strong>No courses inside ${T.radius} miles.</strong><span>Widen the radius or try a nearby town.</span><a class="btn" href="#trip">Change search</a></div>`;
  renderBuildbar();
}
function liveStrip(c) {
  const L = S.live[c.id], dates = targetDates();
  if (!L) return `<span class="note">Not checked yet.</span>`;
  if (L.loading) return `<div class="loading-row"><span class="spin"></span> Reading the club's booking page for ${dates.length} day${dates.length > 1 ? "s" : ""}… this can take a minute.</div>`;
  if (L.error) return `<span class="pill warn">Couldn't check</span> <span class="note">${esc(L.error)}</span>`;
  if (L.message) return `<span class="note">${esc(L.message)}</span>`;
  const plays = new Set(playDates());
  return `<div class="avail-row">${dates.map(d => {
    const x = L.dates?.[d], p = dParts(d);
    if (!x) return `<span class="ad limited" title="${esc(longDate(d))}: not checked">${p.dw.slice(0, 2)}<br>${p.dn}<br><b>–</b></span>`;
    const n = x.times.length;
    const cls = x.status === "available" ? "open" : x.status === "none" ? "members" : "limited";
    const mark = x.status === "not_open" ? "–" : null;
    const tip = n ? `${n} free: ${x.times.slice(0, 8).map(t => t.time).join(", ")}` : ({ none: "Nothing free", not_open: "Not open for online booking yet", blocked: "Website blocks automated checks", login: "Booking system needs a login", manual: "Open the booking page", wrong_date: "Couldn't open this date", unverified_date: "Couldn't confirm the date shown" }[x.status] || x.note || "Check manually");
    return `<span class="ad ${cls}${plays.has(d) ? " play" : ""}" title="${esc(longDate(d))}: ${esc(tip)}">${p.dw.slice(0, 2)}<br>${p.dn}<br><b>${n || mark || (cls === "members" ? "0" : "?")}</b></span>`;
  }).join("")}</div>`;
}
function courseCard(c) {
  const inList = T.shortlist.includes(c.id), open = !!S.open[c.id], d = det(c);
  const tees = Array.isArray(d.tees) ? d.tees : [];
  const longest = tees.reduce((m, t) => Math.max(m, num(t.yards) || 0), 0), slopes = tees.map(t => num(t.slope)).filter(Boolean);
  const L = S.live[c.id];
  const sys = c.bookingSystem === "blocked" ? "This club's website blocks automated checks" : c.bookingSystem === "email" ? `Visitor bookings by email${c.email ? `: ${c.email}` : ""}`
    : c.bookingUrl ? `Online booking: ${SYSTEM_LABEL[c.bookingSystem] || "club website"}` : c.bookingSystem === "none" ? "No online booking found" : "";
  return `<article class="course${inList ? " in" : ""}" data-id="${esc(c.id)}">
    <div class="c-head">
      <div style="min-width:0">
        <h3>${esc(nameOf(c))}</h3>
        <div class="c-meta">${esc(c.town || "")}${c.miles != null ? ` · ${c.miles} mi` : ""}${d.type ? ` · ${esc(d.type)}` : ""}${c.holes ? ` · ${c.holes} holes` : ""}</div>
        ${rankBadges(c)}
      </div>
      <div class="score"><div class="big">${c.rating != null ? c.rating.toFixed(1) : "–"}</div><div class="sm">${c.ratingCount ? `★ ${c.ratingCount} reviews` : "Google ★"}</div></div>
    </div>
    <div class="facts">
      <div><div class="v">${money(feeOf(c), cur(c))}</div><div class="k">${feeKind(c)}</div></div>
      <div><div class="v">${num(d.par) ?? "–"}</div><div class="k">Par</div></div>
      <div><div class="v">${longest ? longest.toLocaleString("en-GB") : "–"}</div><div class="k">Yards (back)</div></div>
      <div><div class="v">${slopes.length ? Math.min(...slopes) + "–" + Math.max(...slopes) : "–"}</div><div class="k">Slope</div></div>
    </div>
    ${condSummary(c) ? `<div class="avail" style="padding-bottom:0"><span class="label">Course conditions</span><div class="badges">${condSummary(c)}</div></div>` : ""}
    <div class="avail">
      <span class="label">Live tee times on your ${playDates().length ? "playing days" : "trip days"}</span>
      ${liveStrip(c)}
      ${sys ? `<span class="sys">${esc(sys)}${L?.at ? ` · checked ${new Date(L.at).toTimeString().slice(0, 5)}` : ""}</span>` : ""}
    </div>
    <div class="c-actions">
      <button type="button" class="btn ${inList ? "" : "primary"}" data-add="${esc(c.id)}">${inList ? "✓ In your trip" : "Add to trip"}</button>
      <button type="button" class="btn" data-live="${esc(c.id)}"${L?.loading ? " disabled" : ""}>${c.bookingSystem === "email" ? "How to book" : L && !L.error ? "Refresh tee times" : "Live tee times"}</button>
      <button type="button" class="btn" data-open="${esc(c.id)}" aria-expanded="${open}">${open ? "Hide details" : "Details"}</button>
    </div>
    ${open ? details(c) : ""}
  </article>`;
}
function details(c) {
  const d = det(c), L = S.live[c.id], W = S.weather[c.id], cc = cur(c);
  const tees = Array.isArray(d.tees) ? d.tees : [];
  const fees = Array.isArray(d.greenFees) ? d.greenFees : [];
  const items = Array.isArray(d.catering?.items) ? d.catering.items : [];
  const maps = "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(`${c.lat},${c.lon}`);
  const wDays = W && !W.error ? tripDays().map(x => [x, W.days?.[x]]) : [];
  const enrichPending = S.enriching[c.id] === "loading";
  const read = !!c.enrichedAt; // the club's website has been read
  const missing = enrichPending ? "Checking the club's website…" : c.enrichError ? c.enrichError : read ? "Not published by the club" : "—";
  const val = v => (v == null || v === "" ? `<span class="note">${esc(missing)}</span>` : esc(v));
  const C = d.conditions || null;
  const yn = v => (v === true ? "Yes" : v === false ? "No" : null);
  const condRows = C ? [["Course", C.status && C.status !== "unknown" ? C.status[0].toUpperCase() + C.status.slice(1) : null], ["Temporary greens", yn(C.temporaryGreens)], ["Temporary tees", yn(C.temporaryTees)], ["Fairway mats", yn(C.mats)], ["Buggies", C.buggies], ["Trolleys", C.trolleys], ["Maintenance", C.maintenance]].filter(([, v]) => v) : [];
  const ranks = c.curated?.ranks || [];
  const reports = c.reports || [];
  return `<div class="c-body">
    ${ranks.length ? `<div><span class="label">Rankings</span><div class="price-list">${ranks.map(r => `<div><span><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.sourceLabel)}</a>${r.course ? ` · ${esc(r.course)}` : ""}</span><span>${esc(r.label)}</span></div>`).join("")}</div>${c.curated.access ? `<p class="note">${esc(c.curated.access)}</p>` : ""}</div>` : ""}
    <div><span class="label">Live tee times</span>
      ${L?.dates && Object.keys(L.dates).length ? `<div class="price-list">${Object.entries(L.dates).sort().map(([x, v]) => `<div><span>${esc(longDate(x))}</span><span>${v.times.length ? v.times.slice(0, 10).map(t => esc(t.time) + (t.price != null ? ` (${money(t.price, cc)})` : "")).join(", ") + (v.times.length > 10 ? ` +${v.times.length - 10}` : "") : esc(v.note || ({ none: "Nothing free", not_open: "Not open for booking yet", login: "Needs a login", manual: "Use the booking page" }[v.status] || "Check manually"))}</span></div>`).join("")}</div>`
        : `<p class="note">Tap Live tee times to read the club's booking page.</p>`}
      ${c.bookingUrl ? `<a href="${esc(c.bookingUrl)}" target="_blank" rel="noopener">Open the club's booking page ↗</a>` : ""}</div>
    <div><span class="label">Weather forecast</span>
      ${!W ? `<div class="loading-row"><span class="spin"></span> Loading forecast…</div>` : W.error ? `<p class="note">Forecast unavailable.</p>`
        : `<div class="wx">${wDays.map(([x, w]) => w ? `<div>${esc(longDate(x))}<b>${Math.round(w.high)}° / ${Math.round(w.low)}°</b>${esc(w.summary)}<br>Rain ${w.rainChance ?? "–"}% · Wind ${Math.round(w.windMph ?? 0)} mph<br>Sunset ${esc(w.sunset || "–")}</div>` : `<div>${esc(longDate(x))}<b>–</b>Not out yet</div>`).join("")}</div><p class="note">Forecasts reach about 16 days ahead${W.forecastUntil ? ` (currently to ${esc(longDate(W.forecastUntil))})` : ""}.</p>`}</div>
    <div><span class="label">Tees</span>
      ${tees.length ? `<div class="tbl-wrap"><table><thead><tr><th>Tee</th><th>Yards</th><th>Par</th><th>Rating</th><th>Slope</th></tr></thead><tbody>${tees.map(t => `<tr><td>${esc(t.name || "—")}</td><td>${num(t.yards)?.toLocaleString("en-GB") ?? "–"}</td><td>${num(t.par) ?? num(d.par) ?? "–"}</td><td>${num(t.rating) ?? "–"}</td><td>${num(t.slope) ?? "–"}</td></tr>`).join("")}</tbody></table></div>`
        : enrichPending ? `<div class="loading-row"><span class="spin"></span> Reading the club's website…</div>` : `<p class="note">${esc(missing)}</p>`}
      ${tees.length && d.teesSource ? `<p class="note">Scorecard: ${esc(d.teesSource)}${d.ukgolf?.course ? ` (${esc(d.ukgolf.course)})` : ""}.</p>` : ""}
      ${d.scorecardUrl ? `<a href="${esc(d.scorecardUrl)}" target="_blank" rel="noopener">Club scorecard ↗</a>` : ""}</div>
    <div><span class="label">Course conditions</span>
      ${condRows.length ? `<div class="price-list">${condRows.map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join("")}</div>` : `<p class="note">${esc(enrichPending ? missing : read ? (d.statusUrl ? "No current notice on the club's status page" : "The club doesn't publish a course status page we can read. Call the club for today's conditions.") : missing)}</p>`}
      ${C?.notes ? `<p class="note">${esc(C.notes)}</p>` : ""}
      ${C?.updated || d.conditionsCheckedAt ? `<p class="note">${C?.updated ? `Club update: ${esc(C.updated)}. ` : ""}${d.conditionsCheckedAt ? `Checked ${esc(new Date(d.conditionsCheckedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}.` : ""}</p>` : ""}
      ${d.statusUrl ? `<a href="${esc(d.statusUrl)}" target="_blank" rel="noopener">Club's course status page ↗</a>` : ""}
      <span class="label" style="margin-top:8px">Reported by golfers (last 60 days)</span>
      ${reports.length ? `<div class="price-list">${reports.map(r => `<div><span>${esc(longDate(r.playedOn))}</span><span>${esc(Object.keys(REPORT_LABELS).filter(k => r.flags?.[k]).map(k => REPORT_LABELS[k]).join(", ") || "—")}${r.note ? ` · “${esc(r.note)}”` : ""}</span></div>`).join("")}</div>` : `<p class="note">No reports yet.</p>`}
      <details class="report"><summary>Played it recently? Report conditions</summary>
        <div class="field"><label class="label" for="rp-date-${esc(c.id)}">Day you played</label><input id="rp-date-${esc(c.id)}" type="date" max="${isoToday()}" value="${isoToday()}"></div>
        <div class="checks">${Object.entries(REPORT_LABELS).map(([k, v]) => `<label><input type="checkbox" data-rflag="${k}" data-rcourse="${esc(c.id)}"> ${esc(v)}</label>`).join("")}</div>
        <div class="field"><label class="label" for="rp-note-${esc(c.id)}">Anything else (optional)</label><input id="rp-note-${esc(c.id)}" type="text" maxlength="280" placeholder="e.g. 4 temporary greens on the back nine"></div>
        <button type="button" class="btn small primary" data-report="${esc(c.id)}">Send report</button>
      </details></div>
    <div><span class="label">Green fees & offers</span>
      ${fees.length ? `<div class="price-list">${fees.map(f => `<div><span>${esc(f.label)}</span><span>${money(num(f.price), cc)}</span></div>`).join("")}</div>` : `<p class="note">${esc(read && !enrichPending ? "Not published by the club. Tap Live tee times for current prices." : missing)}</p>`}
      ${(d.offers || []).filter(Boolean).length ? `<ul class="plain">${d.offers.filter(Boolean).map(o => `<li>${esc(o)}</li>`).join("")}</ul>` : ""}
      <div class="field"><label class="label" for="fee-${esc(c.id)}">Confirmed price per golfer (${esc(cc)})</label>
        <input id="fee-${esc(c.id)}" type="number" inputmode="decimal" min="0" data-fee="${esc(c.id)}" placeholder="Enter once confirmed" value="${num(T.confirmed[c.id]) ?? ""}"></div></div>
    <div><span class="label">Visitors</span><p>${val(d.visitorTimes)}</p>${d.bookingWindow ? `<p class="note">Booking window: ${esc(d.bookingWindow)}</p>` : ""}${d.handicapLimit ? `<p class="note">Handicap: ${esc(d.handicapLimit)}</p>` : ""}${d.dressCode ? `<p class="note">Dress code: ${esc(d.dressCode)}</p>` : ""}</div>
    <div><span class="label">Food & hospitality</span><p>${val(d.catering?.summary)}</p>
      ${items.length ? `<div class="price-list">${items.map(i => `<div><span>${esc(i.item)}</span><span>${money(num(i.price), cc)}</span></div>`).join("")}</div>` : ""}</div>
    <div><span class="label">Buggy & trolley hire</span><div class="price-list">
      <div><span>Buggy${d.buggy?.note ? ` · ${esc(d.buggy.note)}` : ""}</span><span>${money(num(d.buggy?.price), cc)}</span></div>
      <div><span>Pull trolley</span><span>${money(num(d.trolley?.pull), cc)}</span></div>
      <div><span>Electric trolley</span><span>${money(num(d.trolley?.electric), cc)}</span></div></div></div>
    <div><span class="label">Practice facilities</span><p>${val(d.practice)}</p></div>
    <div><span class="label">Contact & directions</span>
      ${c.website ? `<p><a href="${esc(c.website)}" target="_blank" rel="noopener">Club website ↗</a></p>` : ""}
      ${(c.phone || d.bookingPhone) ? `<p>Phone: <span class="mail-addr">${esc(d.bookingPhone || c.phone)}</span></p>` : ""}
      <p><a href="${maps}" target="_blank" rel="noopener">Directions in Google Maps ↗</a></p>
      ${c.enrichedAt ? `<p class="note">Details read from the club's website on ${esc(new Date(c.enrichedAt + "Z").toLocaleDateString("en-GB"))}.</p>` : ""}</div>
  </div>`;
}
function renderBuildbar() {
  const on = location.hash === "#courses";
  $("buildbar").hidden = !on;
  const n = T.shortlist.length;
  $("buildCount").textContent = `${n} course${n === 1 ? "" : "s"} picked`;
  $("buildBtn").disabled = n === 0;
}

/* ---------------- plan it for me ---------------- */
/** Pick the best-ranked courses in range with open visitor access and no reported problems, then build the trip. */
async function suggestTrip() {
  const days = playDates();
  if (!S.searched) { toast("Search for a location first"); location.hash = "#trip"; return; }
  if (!days.length) { toast("Tick the days you want to play first"); location.hash = "#trip"; return; }
  const ranked = S.results.map(course).filter(c => c?.curated);
  if (!ranked.length) { toast("No ranked courses in range: widen the radius, or pick courses yourself"); location.hash = "#courses"; return; }
  const open = ranked.filter(c => !/private|members|guests|limited/i.test(c.curated.access || ""));
  const clean = (open.length ? open : ranked).filter(c => !condAlerts(c).some(a => /closed|temporary greens/i.test(a.t)));
  const pool = (clean.length >= Math.min(days.length, 2) ? clean : open.length ? open : ranked)
    .sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0));
  T.shortlist = pool.slice(0, days.length).map(c => c.id);
  save();
  await buildHoliday({ skipLive: true });
  toast(`Planned ${days.length} round${days.length > 1 ? "s" : ""} at ${T.shortlist.length} top-ranked course${T.shortlist.length > 1 ? "s" : ""}. Swap any you like.`);
}

/* ---------------- build holiday ---------------- */
async function buildHoliday({ skipLive = false } = {}) {
  const days = playDates();
  if (!T.shortlist.length) { toast("Add at least one course first"); location.hash = "#courses"; return; }
  if (!days.length) { toast("Pick your playing days first"); location.hash = "#itinerary"; return; }
  location.hash = "#itinerary";
  const missing = T.shortlist.filter(id => !S.live[id]);
  if (missing.length && !skipLive) { toast(`Checking live tee times at ${missing.length} club${missing.length > 1 ? "s" : ""}…`); await Promise.all(missing.map(loadLive)); }
  const used = {};
  for (const d of days) {
    const ranked = T.shortlist.map(course).filter(Boolean).map((c, i) => {
      const x = liveDay(c, d);
      const avail = x ? (x.times.length ? 0 : x.status === "none" ? 100 : 15) : 20;
      return { c, score: avail + (used[c.id] || 0) * 25 + i };
    }).sort((a, b) => a.score - b.score);
    const best = ranked[0]?.c; if (!best) continue;
    used[best.id] = (used[best.id] || 0) + 1;
    const x = liveDay(best, d), want = T.playDays[d]?.time || "10:00";
    const free = x?.times?.map(t => t.time) || [];
    const time = free.length ? free.reduce((b, t) => Math.abs(mins(t) - mins(want)) < Math.abs(mins(b) - mins(want)) ? t : b, free[0]) : want;
    T.playDays[d] = { courseId: best.id, time };
  }
  T.approved = false; save(); renderAll(); toast("Holiday built — check each day");
}
const mins = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

/* ---------------- step 3 ---------------- */
function costs() {
  let feesPP = 0, hirePP = 0, rounds = 0, estimated = false;
  playDates().forEach(d => {
    const c = course(T.playDays[d].courseId); if (!c) return; rounds++;
    const f = feeOf(c, d); if (f == null) estimated = true; feesPP += f || 0;
    const h = det(c);
    if (T.buggies === "share" && num(h.buggy?.price)) hirePP += num(h.buggy.price) * Math.ceil(T.group / 2) / T.group;
    if (T.trolleys === "pull") hirePP += num(h.trolley?.pull) || 0;
    if (T.trolleys === "electric") hirePP += num(h.trolley?.electric) || 0;
  });
  return { rounds, feesPP, hirePP, totalPP: feesPP + hirePP, estimated };
}
function renderItinerary() {
  renderDayPicker("dayPicker2");
  const days = playDates();
  const options = T.shortlist.length ? T.shortlist.map(course).filter(Boolean) : sortedCourses();
  $("rounds").innerHTML = days.length ? days.map(d => {
    const p = dParts(d), r = T.playDays[d], c = course(r.courseId), x = c ? liveDay(c, d) : null;
    const free = x?.times?.map(t => t.time) || [];
    const timeOpts = [...new Set([...free, ...TIMES, r.time])].sort();
    let info = "";
    if (c) {
      const pill = !x ? `<span class="pill">Not checked</span>` : free.length ? (free.includes(r.time) ? `<span class="pill good">${esc(r.time)} is free</span>` : `<span class="pill warn">${esc(r.time)} isn't free</span>`) : `<span class="pill bad">Nothing free</span>`;
      const alerts = condAlerts(c);
      info = `<div class="info">${pill}${alerts.slice(0, 2).map(a => `<span class="pill warn">⚠ ${esc(a.t)}</span>`).join("")}${c.curated?.ranks?.[0] ? `<span>★ ${esc(c.curated.ranks[0].label)}</span>` : ""}<span>${money(feeOf(c, d), cur(c))} pp</span>${free.length ? `<span>Free: ${free.slice(0, 6).map(esc).join(", ")}${free.length > 6 ? "…" : ""}</span>` : ""}</div>`;
    }
    return `<div class="round">
      <div class="date"><div class="dw">${p.dw}</div><div class="dn">${p.dn}</div><div class="dm">${p.dm}</div></div>
      <div class="fields">
        <div class="field"><label class="label" for="c-${d}">Course</label>
          <select id="c-${d}" data-course="${d}"><option value="">Choose a course</option>${options.map(o => `<option value="${esc(o.id)}"${o.id === r.courseId ? " selected" : ""}>${esc(nameOf(o))}</option>`).join("")}</select></div>
        <div class="field"><label class="label" for="t-${d}">Tee time</label>
          <select id="t-${d}" data-time="${d}">${timeOpts.map(t => `<option value="${t}"${t === r.time ? " selected" : ""}>${t}${free.includes(t) ? " ✓ free" : ""}</option>`).join("")}</select></div>
      </div>${info}
    </div>`; }).join("")
    : `<div class="empty"><strong>No playing days yet.</strong><span>Tap the days above that you want to play.</span></div>`;

  $("buggyOpt").innerHTML = [["none", "Walking"], ["share", "Buggy per 2 golfers"]].map(([k, v]) => `<button type="button" class="chip-btn" data-buggy="${k}" aria-pressed="${T.buggies === k}">${v}</button>`).join("");
  $("trolleyOpt").innerHTML = [["none", "Own / none"], ["pull", "Pull trolley"], ["electric", "Electric"]].map(([k, v]) => `<button type="button" class="chip-btn" data-trolley="${k}" aria-pressed="${T.trolleys === k}">${v}</button>`).join("");

  const k = costs();
  $("totals").innerHTML = `
    <div class="tot"><div class="label">Rounds</div><div class="v">${k.rounds}</div></div>
    <div class="tot"><div class="label">Green fees pp</div><div class="v">${money(k.feesPP)}</div></div>
    <div class="tot"><div class="label">Hire pp</div><div class="v">${money(k.hirePP)}</div></div>
    <div class="tot"><div class="label">Total per golfer</div><div class="v">${money(k.totalPP)}</div></div>
    <div class="tot"><div class="label">Group total (${T.group})</div><div class="v">${money(k.totalPP * T.group)}</div></div>`;
  $("costNote").textContent = k.estimated ? "Some rounds have no price yet. Check live tee times or enter a confirmed price on the course." : "Uses confirmed prices first, then live tee-sheet prices, then prices listed on club websites.";

  const text = itinText();
  $("itinText").textContent = text;
  $("waLink").href = "https://wa.me/?text=" + encodeURIComponent(text);
  $("mailShare").href = "mailto:?subject=" + encodeURIComponent(`Golf trip: ${T.location}, ${rangeLabel()}`) + "&body=" + encodeURIComponent(text);
  const ready = k.rounds > 0 && days.every(d => T.playDays[d].courseId);
  $("approveArea").innerHTML = T.approved
    ? `<div class="approved">✓ Itinerary approved</div><a class="btn primary" href="#book">Request tee times</a>`
    : `<button type="button" class="btn primary" id="approveBtn"${ready ? "" : " disabled"}>Approve itinerary</button>${ready ? "" : `<p class="note">Give every playing day a course to approve.</p>`}`;
}
function itinText() {
  const lines = [`⛳ Golf trip: ${T.location}`, `${rangeLabel()} · ${T.group} golfer${T.group > 1 ? "s" : ""}`, ""];
  const days = playDates();
  if (!days.length) lines.push("No rounds planned yet.");
  days.forEach(d => { const r = T.playDays[d], c = course(r.courseId), f = c ? feeOf(c, d) : null;
    lines.push(`${longDate(d)} – ${r.time} – ${c ? `${nameOf(c)}${c.town ? " (" + c.town + ")" : ""}` : "course TBC"}${f != null ? ` – ${money(f, cur(c))} pp` : ""}`); });
  const k = costs();
  if (k.rounds) lines.push("", `Hire: ${T.buggies === "share" ? "buggies (1 per 2)" : "walking"}${T.trolleys !== "none" ? `, ${T.trolleys} trolleys` : ""}`, `Cost: ${money(k.totalPP)} per golfer · ${money(k.totalPP * T.group)} for the group`);
  if (S.tripId) lines.push("", `Trip: ${location.origin}/t/${S.tripId}`);
  return lines.join("\n");
}

/* ---------------- step 4 ---------------- */
function bookingGroups() {
  const g = {};
  playDates().forEach(d => { const r = T.playDays[d]; if (r.courseId) (g[r.courseId] ||= []).push({ date: d, time: r.time }); });
  return g;
}
const toOf = c => T.emails[c.id] ?? (c.email || det(c).bookingEmail || "");
function emailFor(c, rounds) {
  const subj = `Visitor tee time request – ${T.group} golfers – ${rounds.map(r => longDate(r.date)).join(", ")}`;
  const hire = [];
  if (T.buggies === "share") hire.push(`${Math.ceil(T.group / 2)} buggies`);
  if (T.trolleys !== "none") hire.push(`${T.group} ${T.trolleys} trolleys`);
  const body = [`Dear ${nameOf(c)} Bookings Team,`, "",
    `We are a group of ${T.group} golfers visiting the ${T.location} area from ${rangeLabel()}, and we would love to play ${nameOf(c)}.`, "",
    "Could you please confirm availability for:", ...rounds.map(r => `• ${longDate(r.date)} – tee time ${r.time} (or the nearest available)`), "",
    hire.length ? `We would also like to hire ${hire.join(" and ")} if available.` : "We will be walking with our own equipment.",
    "Please confirm the green fee per player, any current offers or group rates, and clubhouse food options.", "",
    "All players hold current handicaps and can provide certificates on request.", "",
    "Many thanks,", T.booker.name || "[Your name]", T.booker.phone || "[Your phone number]"].join("\n");
  return { subj, body };
}
const mailto = (to, m) => "mailto:" + encodeURIComponent(to) + "?subject=" + encodeURIComponent(m.subj) + "&body=" + encodeURIComponent(m.body);
function renderBook() {
  const area = $("bookArea");
  if (!T.approved) { area.innerHTML = `<div class="empty"><strong>Approve your itinerary first.</strong><span>Once the group is happy with the plan, approve it and the booking emails appear here.</span><a class="btn primary" href="#itinerary">Go to itinerary</a></div>`; return; }
  const g = bookingGroups();
  area.innerHTML = `<div class="panel"><h3>Lead booker</h3><div class="grid2">
      <div class="field"><label class="label" for="bName">Your name</label><input id="bName" type="text" autocomplete="name" value="${esc(T.booker.name)}"></div>
      <div class="field"><label class="label" for="bPhone">Phone</label><input id="bPhone" type="tel" autocomplete="tel" value="${esc(T.booker.phone)}"></div></div></div>`
    + Object.keys(g).map(id => {
      const c = course(id); if (!c) return "";
      const m = emailFor(c, g[id]), to = toOf(c);
      return `<div class="panel mail">
        <div class="row" style="justify-content:space-between"><h3>${esc(nameOf(c))}</h3>${T.sent[id] ? `<span class="pill good">Requested</span>` : `<span class="pill warn">Not sent</span>`}</div>
        ${c.bookingUrl && c.bookingSystem !== "email" ? `<a class="btn flag" href="${esc(c.bookingUrl)}" target="_blank" rel="noopener">Book online on the club's booking page ↗</a>` : ""}
        ${c.bookingSystem === "email" ? `<p class="note">This club takes visitor bookings by email.${c.bookingUrl ? ` <a href="${esc(c.bookingUrl)}" target="_blank" rel="noopener">Club's booking information ↗</a>` : ""}</p>` : ""}
        <div class="field"><label class="label" for="to-${esc(id)}">Club booking email</label>
          <input id="to-${esc(id)}" type="email" data-email="${esc(id)}" placeholder="Find it on the club's website" value="${esc(to)}"></div>
        <div class="field"><span class="label">Subject</span><div class="mail-addr">${esc(m.subj)}</div></div>
        <div class="field"><span class="label">Message</span><div class="preview" id="prev-${esc(id)}">${esc(m.body)}</div></div>
        <div class="row">
          <a class="btn primary" id="mailto-${esc(id)}" href="${esc(mailto(to, m))}">Open in email app</a>
          <button type="button" class="btn" data-copymail="${esc(id)}">Copy email</button>
          <button type="button" class="btn" data-sent="${esc(id)}">${T.sent[id] ? "Mark as not sent" : "Mark as requested"}</button>
        </div></div>`; }).join("");
}
function updateMails() {
  const g = bookingGroups();
  for (const id of Object.keys(g)) {
    const c = course(id); if (!c) continue;
    const m = emailFor(c, g[id]);
    const p = $("prev-" + id), a = $("mailto-" + id);
    if (p) p.textContent = m.body; if (a) a.href = mailto(toOf(c), m);
  }
}

async function sendReport(id) {
  const flags = {};
  document.querySelectorAll(`[data-rcourse="${CSS.escape(id)}"]`).forEach(b => { if (b.checked) flags[b.dataset.rflag] = true; });
  const playedOn = $(`rp-date-${id}`)?.value, note = $(`rp-note-${id}`)?.value || "";
  try {
    const r = await api(`/api/courses/${id}/reports`, { method: "POST", body: { playedOn, flags, note } });
    S.courses[id] = { ...course(id), reports: r.reports };
    toast("Thanks, your report is up"); renderAll();
  } catch (e) { toast(e.message); }
}

/* ---------------- routing + render ---------------- */
const TABS = ["trip", "courses", "itinerary", "book"];
const currentTab = () => { const h = location.hash.slice(1); return TABS.includes(h) ? h : "trip"; };
function renderAll() {
  const tab = currentTab();
  document.querySelectorAll("[data-view]").forEach(s => (s.hidden = s.dataset.view !== tab));
  document.querySelectorAll(".steps a").forEach(a => (a.dataset.tab === tab ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  renderStrip(); renderTrip(); renderCourses(); renderItinerary(); renderBook(); renderShare(); renderBuildbar();
}
window.addEventListener("hashchange", () => { renderAll(); window.scrollTo(0, 0); });

/* ---------------- events ---------------- */
function toggleDay(d) { if (T.playDays[d]) delete T.playDays[d]; else T.playDays[d] = { courseId: "", time: "10:00" }; unapprove(); save(); renderAll(); }
document.addEventListener("click", e => {
  const t = e.target.closest("button"); if (!t) return;
  const ds = t.dataset;
  if (ds.r) { T.radius = +ds.r; save(); renderAll(); if (S.searched) search(); }
  else if (ds.day) toggleDay(ds.day);
  else if (ds.sort) { T.sort = ds.sort; save(); renderCourses(); }
  else if (ds.view) { T.view = ds.view; save(); renderCourses(); }
  else if (ds.report) sendReport(ds.report);
  else if (t.id === "suggestBtn" || t.id === "suggestBtn2") suggestTrip();
  else if (ds.add) { T.shortlist = T.shortlist.includes(ds.add) ? T.shortlist.filter(x => x !== ds.add) : [...T.shortlist, ds.add]; save(); renderAll(); }
  else if (ds.live) loadLive(ds.live);
  else if (ds.open) { S.open[ds.open] = !S.open[ds.open]; renderCourses(); if (S.open[ds.open]) loadDetails(ds.open); }
  else if (ds.buggy) { T.buggies = ds.buggy; unapprove(); save(); renderAll(); }
  else if (ds.trolley) { T.trolleys = ds.trolley; unapprove(); save(); renderAll(); }
  else if (ds.copymail) { const c = course(ds.copymail), m = emailFor(c, bookingGroups()[c.id]); copy(`To: ${toOf(c)}\nSubject: ${m.subj}\n\n${m.body}`); }
  else if (ds.sent) { T.sent[ds.sent] = !T.sent[ds.sent]; save(); renderBook(); }
  else if (t.id === "approveBtn") { T.approved = true; save(); renderAll(); toast("Itinerary approved"); }
  else if (t.id === "copyItin") copy(itinText());
  else if (t.id === "copyLink") copy($("shareUrl").value);
  else if (t.id === "buildBtn" || t.id === "rebuild") buildHoliday();
  else if (t.id === "grpMinus") { T.group = Math.max(1, T.group - 1); unapprove(); save(); renderAll(); }
  else if (t.id === "grpPlus") { T.group = Math.min(40, T.group + 1); unapprove(); save(); renderAll(); }
});
document.addEventListener("change", e => {
  const t = e.target;
  if (t.dataset.course) { T.playDays[t.dataset.course].courseId = t.value; unapprove(); save(); renderAll(); }
  else if (t.dataset.time) { T.playDays[t.dataset.time].time = t.value; unapprove(); save(); renderAll(); }
  else if (t.id === "from" || t.id === "to") {
    T[t.id] = t.value; if (T.from && T.to && T.to < T.from) T.to = T.from;
    const valid = new Set(tripDays()); Object.keys(T.playDays).forEach(d => { if (!valid.has(d)) delete T.playDays[d]; });
    S.live = {}; unapprove(); save(); renderAll();
  }
});
document.addEventListener("input", e => {
  const t = e.target;
  if (t.dataset.fee) { const v = num(t.value); if (v == null) delete T.confirmed[t.dataset.fee]; else T.confirmed[t.dataset.fee] = v; save(); renderStrip(); renderItinerary(); }
  else if (t.dataset.email) { T.emails[t.dataset.email] = t.value.trim(); save(); updateMails(); }
  else if (t.id === "bName" || t.id === "bPhone") { T.booker[t.id === "bName" ? "name" : "phone"] = t.value; save(); updateMails(); }
});
$("tripForm").addEventListener("submit", async e => {
  e.preventDefault();
  T.location = $("loc").value.trim();
  if (!T.location) { const st = $("scanStatus"); st.hidden = false; st.className = "status warn"; st.textContent = "Enter a town, region or postcode."; return; }
  $("scanBtn").disabled = true;
  try { await ensureTrip(); save(); await search(); if (S.results.length) location.hash = "#courses"; }
  catch (err) { const st = $("scanStatus"); st.hidden = false; st.className = "status warn"; st.textContent = err.message; }
  finally { $("scanBtn").disabled = false; }
});

/* ---------------- start ---------------- */
(async () => {
  const m = /^\/t\/([A-Za-z0-9_-]+)/.exec(location.pathname);
  if (m) {
    try { const r = await api(`/api/trips/${m[1]}`); T = { ...defaults(), ...r.data }; S.tripId = r.id; S.version = r.version; setSync("Saved"); }
    catch (e) { toast(e.message); history.replaceState(null, "", "/"); }
  }
  renderAll();
  if (T.location) await search();
})();
