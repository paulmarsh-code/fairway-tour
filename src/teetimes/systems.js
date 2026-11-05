// Known UK & Ireland golf booking systems: how to recognise them from a link,
// and candidate URL patterns that open the visitor tee sheet for a date.
//
// The date patterns are best guesses that are CHECKED at run time: a candidate is only
// accepted if the rendered page shows the requested date. When none works and an
// Anthropic key is configured, the AI navigator (ai.js) works out the pattern from the
// live page instead, and the result is saved per course.

export const SYSTEMS = [
  {
    id: "brs", label: "BRS Golf",
    match: /(^|\.)brsgolf\.com/i,
    visitorUrl(url) {
      const slug = new URL(url).pathname.split("/").filter(Boolean)[0];
      return slug ? `https://visitors.brsgolf.com/${slug}#/course/1` : url;
    },
    candidates(url) {
      const u = new URL(url);
      const slug = u.pathname.split("/").filter(Boolean)[0];
      if (!slug) return [];
      const base = `https://visitors.brsgolf.com/${slug}`;
      return [`${base}#/course/1/date/{YYYY}-{MM}-{DD}`, `${base}#/course/1/date/{DD}-{MM}-{YYYY}`];
    }
  },
  {
    id: "intelligentgolf", label: "IntelligentGolf",
    match: /intelligentgolf\.co\.uk|\/visitorbooking\b/i,
    candidates(url) {
      const o = new URL(url).origin;
      return [`${o}/visitorbooking/?date={DD}-{MM}-{YYYY}`, `${o}/visitorbooking/?date={YYYY}-{MM}-{DD}`, `${o}/visitorbooking/?date={DD}/{MM}/{YYYY}`];
    }
  },
  {
    id: "chronogolf", label: "Chronogolf (Lightspeed)",
    match: /chronogolf\.(com|ca|co\.uk|fr)|golf\.lightspeed/i,
    candidates(url) {
      const m = /\/club\/([^/?#]+)/.exec(url);
      if (!m) return [];
      const slug = m[1];
      return [
        `https://www.chronogolf.com/club/${slug}#?date={YYYY}-{MM}-{DD}&step=teetimes&nb_holes=18`,
        `https://www.chronogolf.co.uk/club/${slug}/booking/?source=club&medium=widget#?date={YYYY}-{MM}-{DD}&nb_holes=18`
      ];
    }
  },
  { id: "clubv1", label: "Club V1", match: /clubv1\.com/i, candidates: () => [] },
  { id: "golfnow", label: "GolfNow", match: /golfnow\.(co\.uk|com|ie)/i, candidates: () => [] },
  { id: "howdidido", label: "HowDidiDo", match: /howdidido\.com/i, candidates: () => [] },
  { id: "golfmanager", label: "Golfmanager", match: /golfmanager\.(com|app|es)/i, candidates: () => [] }
];

export const systemById = id => SYSTEMS.find(s => s.id === id) || null;

export function detectSystem(url) {
  for (const s of SYSTEMS) if (s.match.test(url)) return s;
  return null;
}

/** If a booking URL already carries a date, turn it into a template. */
export function templateFromDatedUrl(url) {
  let t = url;
  t = t.replace(/(\d{4})-(\d{2})-(\d{2})/, "{YYYY}-{MM}-{DD}");
  if (t === url) t = url.replace(/\b(\d{2})-(\d{2})-(\d{4})\b/, "{DD}-{MM}-{YYYY}");
  if (t === url) t = url.replace(/\b(\d{2})\/(\d{2})\/(\d{4})\b/, "{DD}/{MM}/{YYYY}");
  return t === url ? null : t;
}

/** Link text/URL that suggests a visitor booking page on a club's own site. */
export const BOOKING_LINK = /(book(ing)?[\s-]*(a\s*)?tee|tee[\s-]*times?|visitor[\s-]*(booking|tee)|book online|online booking|book now|green[\s-]*fees?)/i;
