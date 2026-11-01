import { config, userAgent } from "./config.js";

const R_MILES = 3958.8;
const rad = d => (d * Math.PI) / 180;

export function milesBetween(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_MILES * Math.asin(Math.sqrt(h));
}

export function boundingBox({ lat, lon }, miles) {
  const dLat = miles / 69.0;
  const dLon = miles / (69.0 * Math.cos(rad(lat)) || 1);
  return { minLat: lat - dLat, maxLat: lat + dLat, minLon: lon - dLon, maxLon: lon + dLon };
}

const cache = new Map();
const POSTCODE = /^([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})?$/i;

/** Turn "Aberdeen", "AB23 8AY" or "East Lothian" into {lat, lon, label}. UK & Ireland only. */
export async function geocode(text) {
  const key = String(text || "").trim().toLowerCase();
  if (!key) throw Object.assign(new Error("Enter a town, region or postcode"), { status: 400 });
  if (cache.has(key)) return cache.get(key);

  // "57.15, -2.09" — coordinates, e.g. from the phone's location
  const ll = /^(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)$/.exec(key);
  if (ll) return { lat: Number(ll[1]), lon: Number(ll[2]), label: "your location" };

  let hit = null;
  const m = POSTCODE.exec(key.toUpperCase());
  if (m) {
    const url = m[2]
      ? `https://api.postcodes.io/postcodes/${encodeURIComponent(key.replace(/\s+/g, ""))}`
      : `https://api.postcodes.io/outcodes/${encodeURIComponent(m[1])}`;
    const r = await fetch(url, { headers: { "User-Agent": userAgent } }).catch(() => null);
    if (r?.ok) {
      const j = await r.json();
      if (j?.result?.latitude) hit = { lat: j.result.latitude, lon: j.result.longitude, label: key.toUpperCase() };
    }
  }
  if (!hit) {
    const url = "https://nominatim.openstreetmap.org/search?" + new URLSearchParams({
      q: text, format: "jsonv2", limit: "1", countrycodes: "gb,ie", ...(config.contactEmail ? { email: config.contactEmail } : {})
    });
    const r = await fetch(url, { headers: { "User-Agent": userAgent, "Accept-Language": "en-GB" } }).catch(() => null);
    if (r?.ok) {
      const j = await r.json();
      if (j?.[0]) hit = { lat: Number(j[0].lat), lon: Number(j[0].lon), label: j[0].display_name.split(",").slice(0, 2).join(",").trim() };
    }
  }
  if (!hit) throw Object.assign(new Error(`Couldn't find "${text}" in the UK or Ireland`), { status: 404 });
  cache.set(key, hit);
  return hit;
}
