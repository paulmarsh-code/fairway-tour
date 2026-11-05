// One shared headless Chromium, a small page pool, and a polite gap between requests to the same host.
import { chromium } from "playwright";
import { config, userAgent } from "./config.js";

let browserPromise = null;
async function browser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox", "--disable-dev-shm-usage"] }).catch(e => { browserPromise = null; throw e; });
  }
  return browserPromise;
}

// Concurrency limiter
let active = 0;
const waiting = [];
async function acquire() {
  if (active < config.maxBrowserPages) { active++; return; }
  await new Promise(res => waiting.push(res));
  active++;
}
function release() { active--; waiting.shift()?.(); }

// Per-host spacing so we never hammer a club's booking system
const lastHit = new Map();
async function politeWait(url) {
  let host = ""; try { host = new URL(url).host; } catch { return; }
  const wait = (lastHit.get(host) || 0) + config.perHostGapMs - Date.now();
  lastHit.set(host, Math.max(Date.now(), (lastHit.get(host) || 0) + config.perHostGapMs));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

/** Run fn(page) in a fresh context. Images, fonts and media are blocked to keep it light. */
export async function withPage(fn) {
  await acquire();
  const b = await browser();
  const ctx = await b.newContext({ userAgent: userAgent + " Chrome/128", locale: "en-GB", timezoneId: "Europe/London", viewport: { width: 1280, height: 1600 } });
  await ctx.route("**/*", route => {
    const t = route.request().resourceType();
    return ["image", "media", "font"].includes(t) ? route.abort() : route.continue();
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(config.pageTimeoutMs);
  try { return await fn(page); }
  finally { await ctx.close().catch(() => {}); release(); }
}

/** Navigate politely and wait for the page (and any booking widget) to settle. */
export async function open(page, url) {
  await politeWait(url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.pageTimeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
  // Hash-routed booking apps (BRS, Chronogolf) render after the route change
  await page.waitForTimeout(1500);
  await dismissCookieBanners(page);
}

/** Decline/close common cookie banners so they don't hide the tee sheet. Prefers "reject" options. */
export async function dismissCookieBanners(page) {
  const labels = [/reject all/i, /reject/i, /only necessary|necessary only|essential only/i, /decline/i, /close/i];
  for (const re of labels) {
    const btn = page.getByRole("button", { name: re }).first();
    if (await btn.isVisible({ timeout: 300 }).catch(() => false)) { await btn.click({ timeout: 2000 }).catch(() => {}); return; }
  }
}

/** Bot-protection screens (Cloudflare and similar). Sites that show these don't want automated visits. */
export const BLOCKED = /(verify(ing)? (that )?you are (a )?human|checking (if the site connection is secure|your browser)|just a moment\.\.\.|attention required|cloudflare ray id|performance & security by cloudflare|are you a robot|access denied|request blocked)/i;

export async function pageText(page, max = 15000) {
  const t = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  return t.replace(/\n{3,}/g, "\n\n").slice(0, max);
}

export async function pageLinks(page, max = 300) {
  return page.evaluate(m => {
    const seen = new Set(), out = [];
    for (const a of document.querySelectorAll("a[href], iframe[src]")) {
      const href = a.href || a.src; if (!href || seen.has(href) || href.startsWith("javascript:")) continue;
      seen.add(href); out.push({ href, text: (a.innerText || a.title || a.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 80) });
      if (out.length >= m) break;
    }
    return out;
  }, max).catch(() => []);
}

export async function closeBrowser() {
  if (browserPromise) { const b = await browserPromise.catch(() => null); await b?.close().catch(() => {}); browserPromise = null; }
}
