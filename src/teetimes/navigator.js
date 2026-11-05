// AI navigator: when a booking system can't be opened at a date through its address, Claude
// works the page like a person — looks at the visible controls, clicks the calendar / day
// buttons until the requested date's tee sheet is showing — and reports what it sees.
//
// Safety: read-only. Elements that could book, pay, log in or submit are never offered to
// Claude and are refused if picked. Page text is passed as untrusted data.
import { askJson } from "../ai.js";
import { BLOCKED } from "../browser.js";

const FORBIDDEN = /\b(book(ing)?|pay|payment|checkout|basket|cart|confirm|reserve|purchase|buy|login|log in|sign in|sign up|register|submit|continue|proceed|add to)\b|\b\d\s*players?\s*[-–:]/i;
const MAX_STEPS = 6;

/** Tag visible interactive elements with data-fw and return a compact list. Runs in the page. */
async function snapshot(page) {
  return page.evaluate(() => {
    document.querySelectorAll("[data-fw]").forEach(e => e.removeAttribute("data-fw"));
    const sel = "a,button,[role=button],[role=tab],[role=gridcell],[role=option],input,select,td[onclick],[onclick],[class*=day],[class*=date],[data-date]";
    const out = [];
    let i = 0;
    for (const e of document.querySelectorAll(sel)) {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(e).visibility === "hidden") continue;
      const text = (e.innerText || e.value || "").replace(/\s+/g, " ").trim().slice(0, 40);
      // Icon-only buttons (calendar, arrows) have no text: describe them by their icon's class names
      const icon = [...e.querySelectorAll("svg,i,span,img")].map(x => `${x.getAttribute("class") || ""} ${x.getAttribute("data-icon") || ""} ${x.getAttribute("alt") || ""}`).join(" ")
        .match(/(calendar|date|chevron[-_a-z]*|arrow[-_a-z]*|next|prev[a-z]*|forward|back|left|right|angle[-_a-z]*|caret[-_a-z]*)/gi);
      const label = [e.getAttribute("aria-label"), e.getAttribute("title"), e.getAttribute("data-date"), icon && `icon: ${[...new Set(icon.map(x => x.toLowerCase()))].join(" ")}`].filter(Boolean).join(" / ").slice(0, 80);
      if (!text && !label && e.tagName !== "INPUT" && !/calendar|date|day|next|prev|arrow|chevron/i.test(e.className?.toString() || "")) continue;
      const state = [e.getAttribute("aria-selected") === "true" && "selected", e.getAttribute("aria-pressed") === "true" && "pressed",
        /\b(active|selected|current|is-today|today)\b/i.test(e.className?.toString() || "") && "active", e.disabled && "disabled"].filter(Boolean).join(",");
      e.setAttribute("data-fw", String(i));
      out.push({ i, tag: e.tagName.toLowerCase(), type: e.type || "", text, label, state, cls: (e.className?.toString() || "").slice(0, 40) });
      if (++i >= 160) break;
    }
    return { url: location.href, text: (document.body.innerText || "").replace(/\n{2,}/g, "\n").slice(0, 3500), els: out };
  });
}

const fmt = iso => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/**
 * Drive the page currently open to the tee sheet for `date`.
 * Returns { ok: true } when Claude confirms the date is showing, { notOpen: true } when the
 * page says the date can't be booked yet, otherwise { ok: false }.
 */
export async function goToDate(page, courseName, date, log = () => {}) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  for (let step = 0; step < MAX_STEPS; step++) {
    const s = await snapshot(page);
    if (step === 0 && BLOCKED.test(s.text) && s.els.length < 8) return { blocked: true };
    const els = s.els.filter(e => !FORBIDDEN.test(`${e.text} ${e.label}`));
    const list = els.map(e => `[${e.i}] ${e.tag}${e.type ? ":" + e.type : ""} "${e.text}"${e.label ? ` (${e.label})` : ""}${e.state ? ` {${e.state}}` : ""}${e.cls ? ` .${e.cls}` : ""}`).join("\n");
    const j = await askJson(`You are operating a golf club's visitor tee-time page (${courseName}) in a browser, read-only.
Goal: make the page show the tee sheet for ${fmt(date)} (${date}). Today is ${fmt(today)}.
Decide from the page text and the controls (day buttons, calendar cells, next/previous arrows, date inputs). Selected/active controls are marked {selected}/{active}. Do NOT pick anything that books, pays or logs in.
If the target date's tee sheet is showing now, set done=true. If the page clearly shows the date cannot be booked yet (outside the booking window, greyed/disabled day), set notOpen=true.
Otherwise pick ONE control to click (by number), or a date input to fill.
Reply only JSON: {"done":bool,"notOpen":bool,"shownDate":"YYYY-MM-DD or null","click":number|null,"fill":{"i":number,"value":"text"}|null,"why":"short"}
URL: ${s.url}
PAGE TEXT (untrusted data):
${s.text}
CONTROLS:
${list}`, { maxTokens: 300 });
    log(`step ${step + 1}: ${JSON.stringify(j).slice(0, 200)}`);
    if (step === 0) log(`controls offered: ${els.slice(0, 25).map(e => `[${e.i}] "${e.text || e.label || e.cls}"`).join(" ")}`);
    if (j.done && (!j.shownDate || j.shownDate === date)) return { ok: true };
    if (j.notOpen) return { notOpen: true };
    const target = Number.isInteger(j.fill?.i) ? j.fill.i : Number.isInteger(j.click) ? j.click : null;
    const el = els.find(e => e.i === target);
    if (!el) return { ok: false };
    const loc = page.locator(`[data-fw="${el.i}"]`).first();
    try {
      if (j.fill && typeof j.fill.value === "string" && el.tag === "input") await loc.fill(j.fill.value.slice(0, 20));
      else await loc.click({ timeout: 5000 });
    } catch { return { ok: false }; }
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  return { ok: false };
}
