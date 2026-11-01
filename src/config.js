// Central configuration, read once from the environment.
const int = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : d);

export const config = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || "0.0.0.0",
  dataDir: process.env.DATA_DIR || "./data",
  // Contact shown to geocoding services (Nominatim requires one) and in the browser user agent.
  contactEmail: process.env.CONTACT_EMAIL || "",
  publicUrl: process.env.PUBLIC_URL || "",

  // Live tee-sheet reading
  maxBrowserPages: int(process.env.MAX_BROWSER_PAGES, 3),
  perHostGapMs: int(process.env.PER_HOST_GAP_MS, 2500),
  teeSheetCacheMinutes: int(process.env.TEE_SHEET_CACHE_MINUTES, 20),
  pageTimeoutMs: int(process.env.PAGE_TIMEOUT_MS, 30000),
  maxDatesPerRequest: int(process.env.MAX_DATES_PER_REQUEST, 10),

  // Optional services
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
  googlePlacesKey: process.env.GOOGLE_PLACES_API_KEY || "",

  // Admin endpoints (course edits) are disabled unless a token is set.
  adminToken: process.env.ADMIN_TOKEN || ""
};

export const userAgent = `FairwayTourBot/0.1 (+${config.publicUrl || "golf trip planner"}${config.contactEmail ? "; " + config.contactEmail : ""})`;
