// ============================================================
// js/enrolment.js
// Loads PESRP enrollment data directly from your GitHub repo's
// raw JSON / GitHub Pages output — no Apps Script involved.
// ============================================================

// If your repo is public, raw.githubusercontent.com works directly
// and is CDN-cached. If you're already serving the frontend from
// GitHub Pages, you can instead point at your Pages URL, e.g.
// "https://<user>.github.io/<repo>/data/summary.json"
const DATA_BASE =
  "https://raw.githubusercontent.com/mwaqas3341-aeo/Sis-Pesrp-enrolment/main/data";

// Simple cache-busting + localStorage TTL cache so you're not
// re-downloading the full dataset on every page load.
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function fetchJsonCached(path) {
  const cacheKey = "pesrp_cache_" + path;
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) {
    try {
      const { ts, data } = JSON.parse(cached);
      if (Date.now() - ts < CACHE_TTL_MS) return data;
    } catch (_) {
      /* fall through to refetch */
    }
  }

  const res = await fetch(`${DATA_BASE}/${path}`);
  if (!res.ok) throw new Error(`Failed to load ${path}: HTTP ${res.status}`);
  const data = await res.json();

  try {
    sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data }));
  } catch (_) {
    /* sessionStorage full or unavailable — non-fatal */
  }

  return data;
}

// Lightweight summary for dashboard cards (counts only)
export async function getSummary() {
  return fetchJsonCached("summary.json");
}

// Full schools list (one row per school, current totals)
export async function getSchools() {
  return fetchJsonCached("schools.json");
}

// Full enrollment detail (one row per school+class) — can be large
// for 39,000 schools, so prefer getEnrollmentByDistrict() when you
// only need one district's data.
export async function getAllEnrollment() {
  return fetchJsonCached("enrollment.json");
}

// Per-district enrollment detail — much lighter, loads only what's
// needed for the markaz/tehsil the AEO is currently viewing.
export async function getEnrollmentByDistrict(districtId) {
  return fetchJsonCached(`enrollment-by-district/${districtId}.json`);
}

// Districts/Tehsils/Markazes reference lists
export async function getDistricts() {
  return fetchJsonCached("districts.json");
}
