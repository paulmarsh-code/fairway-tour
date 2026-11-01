// Pure functions that turn what a rendered booking page shows into a list of free tee times.
// Kept free of Playwright so they can be unit-tested (see test/parse.test.js).

const TIME = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/;
const UNAVAILABLE = /\b(booked|unavailable|not available|members?['’]? only|members?['’]? time|closed|blocked|reserved|competition|full(?!\s*(?:18|9|round|day|price|rate|green))|sold out|no spaces|0 spaces|society)\b/i;
const PRICE = /(?:£|€|GBP\s?|EUR\s?)\s?(\d{1,4}(?:[.,]\d{2})?)/g;

export function normTime(t) {
  const m = TIME.exec(String(t || ""));
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

export function pricesIn(text) {
  const out = [];
  for (const m of String(text || "").matchAll(PRICE)) {
    const n = Number(m[1].replace(",", "."));
    if (n >= 5 && n <= 2000) out.push(n);
  }
  return out;
}

export function spacesIn(text) {
  const s = String(text || "");
  let m = /(\d)\s*(?:spaces?|slots?|places?|players?)\s*(?:available|left|free|remaining)?/i.exec(s);
  if (m) return Number(m[1]);
  m = /\b(\d)\s*\/\s*4\b/.exec(s); // "2/4" style: booked/capacity
  if (m) return 4 - Number(m[1]);
  return null;
}

/**
 * rows: [{time, text, hasAction, disabledHint}] collected from the DOM.
 * Returns [{time, price, spaces}] for rows that look bookable, de-duplicated by time (cheapest kept).
 */
export function parseRows(rows, { players = 1, earliest = "06:00", latest = "18:30" } = {}) {
  const byTime = new Map();
  for (const r of rows || []) {
    const time = normTime(r.time || r.text);
    if (!time || time < earliest || time > latest) continue;
    const text = String(r.text || "");
    if (UNAVAILABLE.test(text) || r.disabledHint) continue;
    const prices = pricesIn(text);
    if (!prices.length && !r.hasAction) continue;
    const spaces = spacesIn(text);
    if (spaces != null && spaces < players) continue;
    const price = prices.length ? Math.min(...prices) : null;
    const prev = byTime.get(time);
    if (!prev || (price != null && (prev.price == null || price < prev.price))) byTime.set(time, { time, price, spaces });
  }
  return [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
}

/** Fallback when no DOM rows were found: scan text lines for "time ... £price". */
export function parseText(text, opts = {}) {
  const lines = String(text || "").split(/\n+/);
  const rows = [];
  lines.forEach((line, i) => {
    if (!TIME.test(line)) return;
    const ctx = [line, lines[i + 1] || "", lines[i + 2] || ""].join(" ");
    const near = TIME.test(lines[i + 1] || "") ? line : ctx; // don't borrow the next row's price
    if (!pricesIn(near).length) return;
    rows.push({ time: line, text: near, hasAction: false });
  });
  return parseRows(rows, opts);
}

const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
const DAYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];

/** Does the page text show the requested date (YYYY-MM-DD) in any common format? */
export function dateShown(text, iso) {
  const [Y, M, D] = iso.split("-").map(Number);
  const s = String(text || "").toLowerCase();
  const dd = String(D).padStart(2, "0"), mm = String(M).padStart(2, "0");
  const mon = MONTHS[M - 1], mon3 = mon.slice(0, 3);
  const dow = DAYS[new Date(Date.UTC(Y, M - 1, D)).getUTCDay()];
  const pats = [
    `${Y}-${mm}-${dd}`, `${dd}/${mm}/${Y}`, `${D}/${M}/${Y}`, `${dd}-${mm}-${Y}`, `${dd}.${mm}.${Y}`, `${dd}/${mm}/${String(Y).slice(2)}`,
    `${D} ${mon}`, `${D}${["st","nd","rd"][((D + 90) % 100 - 10) % 10 - 1] || "th"} ${mon}`, `${dd} ${mon}`,
    `${D} ${mon3}`, `${dd} ${mon3}`, `${mon} ${D}`, `${mon3} ${D}`, `${mon3} ${dd}`
  ];
  if (pats.some(p => s.includes(p))) return true;
  // "Sat 6" style headings
  return new RegExp(`\\b${dow.slice(0, 3)}\\w*,?\\s+${D}\\b`).test(s);
}

export function fillTemplate(tpl, iso) {
  const [Y, M, D] = iso.split("-");
  const mon3 = MONTHS[Number(M) - 1].slice(0, 3);
  return tpl
    .replace(/\{YYYY\}/g, Y).replace(/\{YY\}/g, Y.slice(2))
    .replace(/\{MM\}/g, M).replace(/\{DD\}/g, D)
    .replace(/\{M\}/g, String(Number(M))).replace(/\{D\}/g, String(Number(D)))
    .replace(/\{MON\}/g, mon3[0].toUpperCase() + mon3.slice(1));
}
