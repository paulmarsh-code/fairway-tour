// Real forecasts from Open-Meteo (free, no key). Forecasts reach ~16 days ahead;
// further out we return null for those dates and the app shows "forecast from <date>".
import { userAgent } from "./config.js";

const cache = new Map(); // key -> {at, data}
const TTL = 60 * 60 * 1000;

const CODES = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Freezing fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Showers", 81: "Showers", 82: "Heavy showers",
  85: "Snow showers", 86: "Snow showers", 95: "Thunderstorm", 96: "Thunderstorm, hail", 99: "Thunderstorm, hail"
};

export async function forecast(lat, lon, dates) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  let hit = cache.get(key);
  if (!hit || Date.now() - hit.at > TTL) {
    const url = "https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
      latitude: lat.toFixed(4), longitude: lon.toFixed(4), timezone: "Europe/London", forecast_days: "16",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset",
      wind_speed_unit: "mph"
    });
    const r = await fetch(url, { headers: { "User-Agent": userAgent } }).catch(() => null);
    if (!r?.ok) throw Object.assign(new Error("Weather service unavailable"), { status: 502 });
    const j = await r.json();
    const d = j.daily || {};
    const byDate = {};
    (d.time || []).forEach((t, i) => {
      byDate[t] = {
        summary: CODES[d.weather_code?.[i]] || "—",
        high: d.temperature_2m_max?.[i], low: d.temperature_2m_min?.[i],
        rainChance: d.precipitation_probability_max?.[i], windMph: d.wind_speed_10m_max?.[i], gustMph: d.wind_gusts_10m_max?.[i],
        sunrise: d.sunrise?.[i]?.slice(11, 16), sunset: d.sunset?.[i]?.slice(11, 16)
      };
    });
    hit = { at: Date.now(), data: byDate, lastDate: (d.time || []).at(-1) || null };
    cache.set(key, hit);
  }
  const out = {};
  for (const date of dates) out[date] = hit.data[date] || null;
  return { days: out, forecastUntil: hit.lastDate, source: "Open-Meteo" };
}
