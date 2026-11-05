// Live tee times: open each club's own visitor booking page for a date in a headless browser,
// read what is shown as free, and cache it briefly. Read-only: never books, holds or submits anything.
import { config } from "../config.js";
import { q, rowToCourse } from "../db.js";
import { withPage, open, pageText, pageLinks } from "../browser.js";
import { aiEnabled, askJson } from "../ai.js";
import { parseRows, parseText, dateShown, fillTemplate } from "./parse.js";
import { goToDate } from "./navigator.js";
import { systemById, detectSystem, templateFromDatedUrl } from "./systems.js";

const LOGIN = /\b(log ?in|sign ?in|password|member number|register to book)\b/i;

/** Collect candidate tee-time rows from the rendered DOM. Runs inside the page. */
async function extractRows(page) {
  return page.evaluate(() => {
    const TIME = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/;
    const out = [], seen = new Set();
    for (const el of document.querySelectorAll("body *")) {
      if (el.children.length > 2) continue;
      const own = (el.textContent || "").trim();
      if (own.length > 14 || !TIME.test(own)) continue;
      if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") continue; // hidden
      let row = el;
      for (let i = 0; i < 6 && row.parentElement; i++) {
        row = row.parentElement;
        if ((row.innerText || "").length > own.length + 12) break;
      }
      if (seen.has(row)) continue;
      seen.add(row);
      // Join the row's text pieces with spaces: inline buttons ("£24.50" "2 Player") would otherwise run together
      const parts = [], walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) { const t = n.textContent.trim(); if (t) parts.push(t); }
      const text = parts.join(" ").replace(/\s+/g, " ").slice(0, 300);
      // Skip containers that hold several different times (whole tables), keep row-sized ones
      const times = text.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g) || [];
      if (new Set(times).size > 2) continue;
      const action = row.querySelector("button:not([disabled]), a[href]:not([href='#']), [role=button]:not([aria-disabled=true]), input[type=submit]:not([disabled])");
      const cls = typeof row.className === "string" ? row.className.toLowerCase() : "";
      const disabledHint = /\b(disabled|unavailable|booked|blocked|closed|full)\b/.test(cls) || !!row.querySelector("[aria-disabled=true]") && !action;
      out.push({ time: own.match(TIME)[0], text, hasAction: !!action, disabledHint });
      if (out.length >= 500) break;
    }
    return out;
  }).catch(() => []);
}

const ukToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const NOT_OPEN = /(too far in advance|not (yet )?(open|available) for (online )?booking|bookings? (open|opens|are available) \d+|can only be made \d+ days|in advance of the date|no tee times (are )?available|no times available)/i;

/** Open a tee sheet URL and read what is free. Returns {shown, times, text}. */
async function loadSheet(page, url, date, players) {
  await open(page, url);
  const text = await pageText(page, 20000);
  const shown = dateShown(text, date);
  let times = parseRows(await extractRows(page), { players });
  if (!times.length) times = parseText(text, { players });
  return { shown, times, text };
}
const signature = times => times.map(t => `${t.time}/${t.price ?? ""}`).join(",");

async function readSheet(page, course, url, date, players) {
  await open(page, url);
  return readOpenPage(page, course, url, date, players, false);
}

/** Read the tee sheet already showing in the page. `confirmed` = the navigator confirmed the date. */
async function readOpenPage(page, course, url, date, players, confirmed) {
  const text = await pageText(page, 20000);
  const shown = confirmed || dateShown(text, date);
  let times = parseRows(await extractRows(page), { players });
  if (!times.length) times = parseText(text, { players });
  let note = "";

  if (!times.length && shown && aiEnabled() && /\b([01]?\d|2[0-3])[:.][0-5]\d\b/.test(text)) {
    try {
      const j = await askJson(`Visible text of the live visitor booking page for ${course.name}, opened for ${date}. A group of ${players} wants to play.
List tee times shown as AVAILABLE to book on ${date} (ignore booked/closed/member-only times and other dates) with the visitor price per player if shown.
Reply only JSON: {"times":[{"time":"HH:MM","price":number|null,"spaces":number|null}],"note":"short"}
PAGE TEXT:
${text.slice(0, 14000)}`, { maxTokens: 1500 });
      times = (Array.isArray(j.times) ? j.times : []).map(t => ({ time: String(t.time).slice(0, 5), price: Number.isFinite(+t.price) && t.price !== null ? +t.price : null, spaces: Number.isFinite(+t.spaces) && t.spaces !== null ? +t.spaces : null }))
        .filter(t => /^\d{2}:\d{2}$/.test(t.time) && (t.spaces == null || t.spaces >= players));
      note = String(j.note || "").slice(0, 140);
    } catch { /* fall through */ }
  }

  let status;
  if (times.length) status = shown ? "available" : "unverified_date";
  else if (shown) status = "none";
  else if (NOT_OPEN.test(text) || date > addDays(ukToday(), 2)) { status = "not_open"; note ||= "Not open for online booking yet. Clubs open visitor tee times a set number of days ahead."; }
  else if (LOGIN.test(text)) status = "login";
  else status = "wrong_date";
  return { status, times, note, url };
}

/**
 * Find (and remember) a URL template that opens this course's tee sheet for any date.
 * Tested on the next two days (always inside a club's booking window), not on the trip date.
 * A template is accepted if the page shows the date, or if the tee sheet changes with the date.
 */
async function resolveTemplate(page, row) {
  if (row.date_template) return row.date_template;
  const bookingUrl = row.booking_url;
  const cands = [];
  const sys = systemById(row.booking_system) || detectSystem(bookingUrl);
  if (sys) { try { cands.push(...sys.candidates(bookingUrl)); } catch {} }
  const dated = templateFromDatedUrl(bookingUrl);
  if (dated) cands.unshift(dated);
  const d1 = addDays(ukToday(), 1), d2 = addDays(ukToday(), 2);

  const works = async tpl => {
    const a = await loadSheet(page, fillTemplate(tpl, d1), d1, 1);
    if (a.shown) return true;
    const b = await loadSheet(page, fillTemplate(tpl, d2), d2, 1);
    if (b.shown) return true;
    return a.times.length > 0 && b.times.length > 0 && signature(a.times) !== signature(b.times);
  };
  for (const tpl of cands) {
    try { if (await works(tpl)) { q.setTemplate.run(tpl, row.id); return tpl; } } catch { /* try next */ }
  }

  if (!aiEnabled()) return null;
  // AI navigator: look at the live booking page and work out how dates are put in its URL.
  try {
    await open(page, bookingUrl);
    const text = await pageText(page, 6000);
    const links = (await pageLinks(page, 200)).map(l => `${l.text} -> ${l.href}`).join("\n").slice(0, 8000);
    const j = await askJson(`This is a golf club's visitor tee time booking page: ${page.url()}
Work out a URL template that opens the tee sheet for ANY date, using tokens {YYYY} {MM} {DD} (zero-padded) or {D} {M} (not padded) or {MON} (Jan, Feb...). Use the current URL and the links below (calendar day links often reveal the pattern). If dates can only be chosen by clicking with no URL change, return null.
Reply only JSON: {"template": "https://..." | null, "why": "short"}
CURRENT URL: ${page.url()}
PAGE TEXT:
${text}
LINKS:
${links}`, { maxTokens: 600 });
    const tpl = typeof j.template === "string" && /^https?:\/\//.test(j.template) && /\{(YYYY|DD|D|MON)\}/.test(j.template) ? j.template : null;
    if (tpl && await works(tpl)) { q.setTemplate.run(tpl, row.id); return tpl; }
  } catch { /* give up */ }
  return null;
}

const inflight = new Map();

/**
 * Live tee times for one course across several dates.
 * Returns { course, fetchedAt, dates: { [date]: {status, times, note, url, cached} }, bookingUrl, message }
 */
export async function getTeeSheets(courseId, dates, players = 4) {
  const row = q.byId.get(courseId);
  if (!row) throw Object.assign(new Error("Course not found"), { status: 404 });
  dates = [...new Set(dates)].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(0, config.maxDatesPerRequest);
  const course = rowToCourse(row);

  if (row.booking_system === "blocked") {
    return { course: course.id, dates: {}, bookingUrl: row.booking_url, message: "This club's website blocks automated checks, so live tee times can't be read. Use the club's booking page." };
  }
  if (row.booking_system === "email") {
    return { course: course.id, dates: {}, bookingUrl: row.booking_url, bookingEmail: row.email,
      message: `This club takes visitor bookings by email${row.email ? ` (${row.email})` : ""}, not online. Add it to your trip and use the Book step to send a request.` };
  }
  if (!row.booking_url) {
    return { course: course.id, dates: {}, bookingUrl: "", message: row.detected_at
      ? "No online visitor booking found on the club's website. Phone or email the club."
      : "This club hasn't been checked for online booking yet." };
  }

  const fresh = Date.now() - config.teeSheetCacheMinutes * 60000;
  const result = {}, missing = [];
  for (const d of dates) {
    const c = q.getSheet.get(courseId, d, players);
    if (c && c.fetched_at > fresh) result[d] = { ...JSON.parse(c.result), cached: true, fetchedAt: c.fetched_at };
    else missing.push(d);
  }
  if (missing.length) {
    const key = `${courseId}|${players}|${missing.join(",")}`;
    if (!inflight.has(key)) {
      inflight.set(key, withPage(async page => {
        const out = {};
        const tpl = await resolveTemplate(page, row);
        let baseline = null; // tomorrow's sheet, to spot booking pages that ignore far-off dates
        let opened = false;   // navigator: booking page loaded once, then clicked from day to day
        for (const d of missing) {
          let r;
          if (!tpl && aiEnabled()) {
            try {
              const start = row.booking_system === "brs" ? systemById("brs").visitorUrl(row.booking_url) : row.booking_url;
              if (!opened) { await open(page, start); opened = true; }
              const nav = await goToDate(page, course.name, d, m => console.log(`[nav] ${course.name} ${d} ${m}`));
              console.log(`[nav] ${course.name} ${d} result: ${JSON.stringify(nav)}`);
              if (nav.ok) r = await readOpenPage(page, course, row.booking_url, d, players, true);
              else if (nav.blocked) r = { status: "blocked", times: [], note: "This club's website blocks automated checks. Use the booking page.", url: row.booking_url };
              else if (nav.notOpen) r = { status: "not_open", times: [], note: "Not open for online booking yet. Clubs open visitor tee times a set number of days ahead.", url: row.booking_url };
              else r = { status: "manual", times: [], note: "Couldn't find this date on the club's booking page. Use the booking page.", url: row.booking_url };
            } catch (e) { if (process.env.DEBUG_NAV) console.error(e); r = { status: "error", times: [], note: "The booking page didn't load", url: row.booking_url }; opened = false; }
          } else if (!tpl) r = { status: "manual", times: [], note: "This booking system doesn't let us open a date directly. Use the booking page.", url: row.booking_url };
          else {
            try {
              r = await readSheet(page, course, fillTemplate(tpl, d), d, players);
              if (r.status === "unverified_date") {
                const t1 = addDays(ukToday(), 1);
                baseline ??= signature((await loadSheet(page, fillTemplate(tpl, t1), t1, players)).times);
                if (d !== t1 && signature(r.times) === baseline) r = { status: "not_open", times: [], note: "Not open for online booking yet. Clubs open visitor tee times a set number of days ahead.", url: r.url };
                else r.status = "available";
              }
            } catch (e) { r = { status: "error", times: [], note: "The booking page didn't load", url: fillTemplate(tpl, d) }; }
          }
          const at = Date.now();
          if (r.status !== "error") q.putSheet.run(courseId, d, players, at, JSON.stringify(r));
          out[d] = { ...r, cached: false, fetchedAt: at };
        }
        return out;
      }).finally(() => inflight.delete(key)));
    }
    Object.assign(result, await inflight.get(key));
  }
  return { course: course.id, dates: result, bookingUrl: row.booking_url, message: "" };
}

export function pruneCache() { q.pruneSheets.run(Date.now() - 24 * 3600 * 1000); }
