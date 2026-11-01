# Fairway Tour Planner

A golf trip planner for the UK and Ireland. Golfers enter where they're going, their dates and group size, and the app:

- finds every golf club inside the radius (course directory built from OpenStreetMap)
- reads **live tee times and prices** from each club's own visitor booking page, using a headless browser on the server
- shows real **weather forecasts** for the trip days (Open-Meteo)
- pulls **course details** from club websites: tees, yardage, rating and slope, green fees, offers, buggy and trolley hire, catering, practice facilities (optional, needs an Anthropic API key)
- shows **review scores** (optional, needs a Google Places API key)
- builds a day-by-day **itinerary** using live availability, with costs for the whole group
- **shares the trip by link**: anyone in the group can open and edit it, no login
- shares the itinerary on WhatsApp or email, and drafts a **booking request email** per club, with a direct link to the club's online booking page

The app only **reads** booking pages. It never books, holds a tee time or submits a form.

## How live tee times work

1. **Detection.** For each club, the server visits its website and finds the online booking system: BRS Golf, IntelligentGolf, Chronogolf, Club V1, GolfNow, HowDidiDo or Golfmanager. This runs on demand the first time someone checks a club, or in bulk with `npm run detect:booking`.
2. **Date pattern.** The server works out the URL that opens the tee sheet for a given date. It tries known patterns for each system and only accepts one when the page actually shows the requested date. If none work and `ANTHROPIC_API_KEY` is set, Claude looks at the live page and its links to work out the pattern. The pattern that works is saved per club.
3. **Reading.** For each date, the page is opened in headless Chromium and the rendered tee sheet is read. Booked, member-only, competition and closed slots, and slots with too few spaces for the group, are dropped. Results are cached for 20 minutes (`TEE_SHEET_CACHE_MINUTES`).
4. **Politeness.** At most 3 pages are open at once (`MAX_BROWSER_PAGES`), with a gap of at least 2.5 s between requests to the same site (`PER_HOST_GAP_MS`).

### What to expect

- **Tested so far:** the reader has passed against a test page that behaves like a JavaScript booking app (`test/teesheet.browser.test.js`).
- **Not yet tested:** the per-system URL patterns in `src/teetimes/systems.js` are best guesses that have not been run against the real BRS, IntelligentGolf or Chronogolf sites. Test a few clubs with `npm run check` before launch. When a pattern is wrong, fix it in `systems.js` or set it for one club through the admin API.
- **Clubs the reader can't handle** are marked "Check manually" with a link to their booking page. These are clubs whose booking needs a login, clubs whose calendar only works by clicking, and clubs with no online visitor booking.
- **Terms of use:** reading booking pages automatically may be against some booking systems' terms. Before a public launch, contact BRS (Golf Software Ltd), Lightspeed (Chronogolf), GolfNow and IntelligentGolf about partner or affiliate access. That also gives you a more reliable data feed.

## Run it locally

You need Node 20+.

```bash
npm install
npx playwright install chromium        # headless browser for tee sheets
cp .env.example .env                   # add CONTACT_EMAIL at least
npm run seed:sample                    # 7 Aberdeen clubs, for a quick try
node --env-file=.env src/server.js     # http://localhost:3000
```

For the full UK & Ireland directory, run `npm run import:osm`. It takes a few minutes and is safe to re-run.

### Test live tee times for a club

```bash
npm run check -- "Royal Aberdeen" 2026-12-07 4
```

This prints the booking system found, the date pattern, and the free tee times. Use it to check each booking system before going live.

### Tests

```bash
npm test     # parser unit tests + the headless-browser tee-sheet test
```

## Deploy on your own Linux server (e.g. Contabo VPS)

You need a server with at least 2 GB of RAM, plus Docker and the Docker Compose plugin. Ubuntu or Debian are fine.

1. **Point a domain at the server.** At your DNS provider (e.g. 123 Reg), add an **A record** for a subdomain such as `golf.yourdomain.co.uk`, pointing to the server's IP address.
2. **Open the web ports.** Make sure ports 80 and 443 are open in the server's firewall:
   ```bash
   sudo ufw allow 80,443/tcp
   ```
3. **Get the code onto the server:**
   ```bash
   git clone https://github.com/<you>/fairway-tour.git && cd fairway-tour
   cp .env.example .env && nano .env   # set DOMAIN, CONTACT_EMAIL, PUBLIC_URL (+ optional keys)
   docker compose up -d --build
   ```
4. **Open your domain.** Caddy gets an HTTPS certificate automatically. On first start, the server imports the UK & Ireland course directory in the background, which takes about 5 minutes. Watch progress with `docker compose logs -f app`.
5. **To update after new code is pushed:**
   ```bash
   git pull && docker compose up -d --build
   ```
6. **Optionally, pre-find booking systems** for 500 clubs at a time:
   ```bash
   docker compose exec app npm run detect:booking -- 500
   ```
7. **To test one club's live tee times:**
   ```bash
   docker compose exec app npm run check -- "Cruden Bay" 2026-12-07
   ```

If something else on the server already uses ports 80 and 443 (for example nginx), remove the `caddy` service from `docker-compose.yml`. Then publish the app's port with `ports: ["127.0.0.1:3000:3000"]` and point your existing proxy at it.

## Deploy on Render

1. Push this folder to a GitHub repo.
2. In Render, choose **New → Blueprint** and pick the repo. `render.yaml` sets up a Docker web service on the **Standard** plan, which has the 2 GB memory Chromium needs, plus a 1 GB disk for the database.
3. Set these environment variables:
   - `CONTACT_EMAIL` (required by OpenStreetMap's geocoder)
   - `PUBLIC_URL`, your site address
   - optionally `ANTHROPIC_API_KEY` and `GOOGLE_PLACES_API_KEY`
4. Deploy. On first boot the server imports the UK & Ireland course directory in the background, which takes about 5 minutes.
5. Optional: from the Render shell, run `npm run detect:booking -- 500` to pre-find booking systems for 500 clubs at a time.
6. Add your own domain in Render. If it's managed at 123 Reg, add the CNAME record Render gives you.

Cost: Render Standard is about $25 a month. Anthropic and Google usage is pay-as-you-go, and only applies if you set those keys.

## Deploy on Fly.io (alternative)

```bash
fly launch --no-deploy
fly volumes create fairway_data --size 1 --region lhr
fly secrets set CONTACT_EMAIL=you@example.com PUBLIC_URL=https://... ANTHROPIC_API_KEY=... ADMIN_TOKEN=...
fly deploy
```

## Admin: fix a club

With `ADMIN_TOKEN` set:

```bash
curl -X PATCH https://YOUR-SITE/api/admin/courses/<id> \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"bookingUrl":"https://visitors.brsgolf.com/clubname","bookingSystem":"brs",
       "dateTemplate":"https://visitors.brsgolf.com/clubname#/course/1/date/{YYYY}-{MM}-{DD}",
       "rankLabel":"GB&I Top 100","rankScore":90}'
```

The date template accepts these tokens:
- `{YYYY}`, `{YY}`
- `{MM}`, `{DD}` (zero-padded)
- `{M}`, `{D}` (not padded)
- `{MON}` (Jan, Feb…)

## Project layout

```
src/server.js            API + static front end
src/teetimes/            live tee-sheet reader (systems, parser, cache)
src/detect.js            finds each club's booking system
src/enrich.js            course details from club websites (Claude) + review scores (Google)
src/weather.js           Open-Meteo forecasts
src/geo.js               place / postcode lookup, distances
src/db.js                SQLite: courses, cached tee sheets, shared trips
public/                  the app (no build step)
scripts/                 OSM import, booking detection, single-club check, enrichment, sample seed
```

## Not in version 1

- **Course rankings:** there's no free source. Set them per club through the admin API (the sample seed includes a few). Sorting falls back to review score.
- **Accounts and logins:** trips are shared by link instead.
- **Booking inside the app:** golfers book on the club's own page or by email.
