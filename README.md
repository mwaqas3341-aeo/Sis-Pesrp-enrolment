# PESRP Bulk Fetcher — GitHub Actions Method

This replaces the Google Apps Script bulk engine (`startBulkFetch` /
`resumeBulkFetch` / `bulkProcessEnrollment_`) with a Node.js scraper that
runs on **GitHub Actions** instead of Apps Script. This sidesteps the
90-minute/day Apps Script execution quota entirely, because GitHub Actions
jobs are billed in **job-minutes**, not a shared daily script quota — each
job gets up to 6 hours, and public repos get unlimited free minutes
(private repos get 2,000 free minutes/month).

## Why this fixes your problem

Your bulk engine needs roughly 2 HTTP requests per school (pie + area) for
~39,000 schools = ~78,000 requests. Even fast, that's hours of pure fetch
time — far more than Apps Script's 90 min/day free quota, no matter how
well checkpointed the code is. Moving the fetch loop off Apps Script and
onto GitHub's runners removes that ceiling.

## How it works

1. `scripts/pesrp-api.js` — 1:1 port of your `getCsrf`, `parseOptions`,
   `inferLevel`, `formatClassName`, and the districts/tehsils/markazes/
   schools/enrollment fetch calls from `Code_API.gs`.
2. `scripts/run-bulk-fetch.js` — the bulk runner. Walks
   Districts → Tehsils → Markazes → Schools, exactly like your
   `bulkProcessEnrollment_`, but:
   - Checkpoints progress to `data/checkpoint.json` (instead of
     `PropertiesService`), committed back to the repo after every
     5 markazes processed.
   - Fetches schools within a markaz with limited concurrency
     (default 8 at a time) instead of Apps Script's `fetchAll()` batching.
   - Writes results to plain JSON files in `data/`.
   - If the time budget (`--max-ms`) is hit, it saves checkpoint and exits
     cleanly — the next workflow run resumes exactly where it left off.
3. `.github/workflows/bulk-fetch.yml` — runs the script daily (cron) or
   on-demand (`workflow_dispatch`), then commits any changed files in
   `data/` back to the repo.
4. `js/enrolment.js` — frontend loader. Fetches the JSON straight from
   `raw.githubusercontent.com` (or your GitHub Pages URL), with a
   30-minute `sessionStorage` cache so repeat page loads don't
   re-download the whole dataset.

## Output files (in `data/`)

| File | Contents |
|---|---|
| `districts.json` | Reference list of districts |
| `schools.json` | One row per school, with current totals (mirrors your `Schools` sheet) |
| `enrollment.json` | One row per school+class (mirrors your `Enrollment` sheet) — can get large at full scale |
| `enrollment-by-district/{id}.json` | Same data, split per district, for lighter frontend loads |
| `summary.json` | Tiny file with just counts, for dashboard cards |
| `checkpoint.json` | Internal — resume state, don't rely on its shape from the frontend |
| `run-log.txt` | Append-only log of each run, also uploaded as a workflow artifact |

## Setup steps

1. Create a new GitHub repo (or add this into your existing AEO Schools
   Portal repo — they can live side by side).
2. Copy in: `scripts/`, `.github/workflows/bulk-fetch.yml`, `package.json`.
3. Edit `js/enrolment.js`: replace `<your-user>/<your-repo>` with your
   actual repo path, or point `DATA_BASE` at your GitHub Pages URL if you
   prefer serving from Pages instead of raw.githubusercontent.com.
4. Push to GitHub. Go to the **Actions** tab → you should see
   "PESRP Bulk Fetch" listed.
5. Trigger it manually first via **Run workflow** (use `reset: true` for
   the very first run) to confirm it works end-to-end on a small slice
   before trusting the daily cron.
6. Because 39,000 schools won't finish in one run, the workflow will pause
   itself near the time budget and resume automatically on the **next**
   scheduled run (or you can manually re-trigger it right away if you want
   it to finish sooner — repeated `workflow_dispatch` runs will keep
   resuming from `checkpoint.json` until `phase` reaches `"DONE"`).

## Tuning knobs

All passed as CLI flags in the workflow's `run` step, or editable in
`run-bulk-fetch.js`:

- `--max-ms=18000000` — time budget per run (here: 5 hours). Lower this if
  you want the workflow to finish faster and rely on the next scheduled
  run to continue, at the cost of more runs needed to finish a full sweep.
- `--concurrency=8` — how many schools to fetch in parallel within a
  markaz. Raise cautiously — PESRP's server may rate-limit or block you if
  you go too aggressive. Watch `run-log.txt` for HTTP errors if you
  increase this.
- `--delay-ms=50` — pause between markazes, as a courtesy to PESRP's
  server. Increase if you see errors creeping in.

## Important: be considerate of PESRP's server

Hitting their backend with high concurrency for hours could be seen as
abusive load, and you risk being IP-blocked (GitHub Actions runner IPs are
shared infrastructure, so blocking could be especially blunt). Recommendations:

- Start with low concurrency (4-8) and a daily cadence, not hourly.
- Watch `run-log.txt` for repeated `HTTP 4xx/5xx` or timeout errors —
  that's a sign to back off.
- Consider whether you actually need a full 39,000-school refresh daily,
  or whether weekly is enough, with the option to manually trigger a
  refresh for one district/markaz when you need fresher numbers
  immediately (you'd need a small variant script for that — let me know
  if useful, it's a quick addition reusing the same `pesrp-api.js`).

## What stays the same

Your Google Sheets ARE NOT required as a runtime dependency anymore — but
nothing stops you from keeping a *much smaller*, less frequent Apps Script
sync that reads the JSON output (e.g. via `UrlFetchApp.fetch` against your
raw GitHub URL) into Sheets purely for manual inspection/export, since
that's a single lightweight read, not 78,000 scraping calls. Apps Script's
quota is no longer your bottleneck because the heavy lifting has moved
off it entirely.
