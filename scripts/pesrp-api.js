// ============================================================
// PESRP API Client (Node.js port of Code_API.gs helpers)
// ============================================================

const BASE = "https://sis.pesrp.edu.pk";

// Simple in-memory CSRF cache (per process run)
let cachedCsrf = null;
let csrfFetchedAt = 0;
const CSRF_TTL_MS = 5 * 60 * 1000; // 5 min, same as your GAS CacheService TTL

// ------------------------------------------------------------
// Basic fetch wrapper with retry + timeout
// ------------------------------------------------------------
async function fetchWithRetry(url, opts = {}, retries = 3, timeoutMs = 20000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) throw err;
      // exponential backoff: 500ms, 1000ms, 2000ms...
      await sleep(500 * Math.pow(2, attempt - 1));
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------
// CSRF token (mirrors getCsrf() in Code_API.gs)
// ------------------------------------------------------------
async function getCsrf(force = false) {
  const now = Date.now();
  if (!force && cachedCsrf && now - csrfFetchedAt < CSRF_TTL_MS) {
    return cachedCsrf;
  }
  const url =
    BASE +
    "/dashboard_revamp/get_gender_summary_pie" +
    "?district=&tehsil=&markaz=&school=&classes=&s_id_emis_code=";
  const text = await fetchWithRetry(url);
  const data = JSON.parse(text);
  if (!data.csrf_test_name) throw new Error("Could not obtain CSRF token");
  cachedCsrf = data.csrf_test_name;
  csrfFetchedAt = now;
  return cachedCsrf;
}

// ------------------------------------------------------------
// parseOptions (mirrors parseOptions() in Code_API.gs)
// ------------------------------------------------------------
function parseOptions(html) {
  const re = /<option[^>]+value=["']([^"']*)["'][^>]*>([^<]*)<\/option>/gi;
  const items = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    items.push({ id: m[1].trim(), name: m[2].trim() });
  }
  return items;
}

// ------------------------------------------------------------
// inferLevel (mirrors inferLevel() in Code_API.gs)
// ------------------------------------------------------------
function inferLevel(name, categories) {
  const n = name.toUpperCase();
  if (n.indexOf("GHSS") !== -1) return "Higher Secondary";
  if (n.indexOf("GHS") !== -1) return "High";
  if (n.indexOf("GMS") !== -1) return "Middle";
  if (n.indexOf("GES") !== -1) return "Elementary";
  if (n.indexOf("GPS") !== -1) return "Primary";
  let max = 0;
  (categories || []).forEach((c) => {
    const v = parseInt(c);
    if (!isNaN(v) && v > max) max = v;
  });
  if (max >= 11) return "Higher Secondary";
  if (max >= 9) return "High";
  if (max >= 6) return "Middle";
  return "Primary";
}

// ------------------------------------------------------------
// formatClassName (mirrors formatClassName_() in Code_API.gs)
// ------------------------------------------------------------
function formatClassName(raw) {
  if (raw === null || raw === undefined || raw === "") return "";
  const s = String(raw).trim();
  if (s === "" || s === "null" || s === "undefined") return "";
  const named = ["ECE", "Nursery", "KG", "PG", "Katchi", "Pre-Primary", "Prep"];
  if (named.indexOf(s) !== -1) return s;
  const n = parseFloat(s);
  if (!isNaN(n) && n >= 0 && n <= 12) return "Class " + Math.round(n);
  if (s.toLowerCase().indexOf("class") !== -1) return s;
  return s;
}

// ------------------------------------------------------------
// Districts (mirrors actionDistricts())
// ------------------------------------------------------------
async function fetchDistricts() {
  const html = await fetchWithRetry(BASE + "/dashboard");
  const block = html.match(/name=["']districts["'][^>]*>([\s\S]*?)<\/select>/i);
  if (!block) throw new Error("Could not parse districts from dashboard HTML");

  const items = [];
  const re = /<option[^>]+value=["'](\d+)["'][^>]*>([^<]+)<\/option>/gi;
  let m;
  while ((m = re.exec(block[1])) !== null) {
    items.push({ id: m[1].trim(), name: m[2].trim() });
  }
  return items;
}

// ------------------------------------------------------------
// Tehsils (mirrors actionTehsils())
// ------------------------------------------------------------
async function fetchTehsils(districtId) {
  const csrf = await getCsrf();
  const url =
    BASE +
    "/user/get_tehsils?district=" +
    districtId +
    "&selectedTehsil=false&all=All&csrf_test_name=" +
    csrf;
  const text = await fetchWithRetry(url);
  const data = JSON.parse(text);
  return parseOptions(data.html).filter((o) => o.id !== "");
}

// ------------------------------------------------------------
// Markazes (mirrors actionMarkazes())
// ------------------------------------------------------------
async function fetchMarkazes(tehsilId) {
  const csrf = await getCsrf();
  const url =
    BASE +
    "/user/get_markazes?tehsil=" +
    tehsilId +
    "&selectedMarkaz=false&all=All&csrf_test_name=" +
    csrf;
  const text = await fetchWithRetry(url);
  const data = JSON.parse(text);
  return parseOptions(data.html).filter((o) => o.id !== "");
}

// ------------------------------------------------------------
// Schools list for a markaz (mirrors the school-list step
// inside actionEnrollment() / processSingleMarkaz_())
// ------------------------------------------------------------
async function fetchSchools(markazId) {
  const csrf = await getCsrf();
  const url =
    BASE +
    "/user/get_schools?markaz=" +
    markazId +
    "&selectedSchool=false&all=All&csrf_test_name=" +
    csrf;
  const text = await fetchWithRetry(url);
  const data = JSON.parse(text);
  return parseOptions(data.html)
    .filter((o) => o.id !== "")
    .map((o) => {
      const m = o.name.match(/^(\d+)\s*-\s*(.+)$/);
      return { id: o.id, emis: m ? m[1] : o.id, name: m ? m[2].trim() : o.name };
    });
}

// ------------------------------------------------------------
// Pie + Area enrollment data for ONE school
// (mirrors the per-school fetch inside processSingleMarkaz_())
// ------------------------------------------------------------
async function fetchSchoolEnrollment(districtId, tehsilId, markazId, schoolId) {
  const pieUrl =
    BASE +
    `/dashboard_revamp/get_gender_summary_pie?district=${districtId}&tehsil=${tehsilId}&markaz=${markazId}&school=${schoolId}&classes=&s_id_emis_code=`;
  const areaUrl =
    BASE +
    `/dashboard_revamp/get_gender_bar_area?district=${districtId}&tehsil=${tehsilId}&markaz=${markazId}&school=${schoolId}&classes=&s_id_emis_code=`;

  const [pieText, areaText] = await Promise.all([
    fetchWithRetry(pieUrl),
    fetchWithRetry(areaUrl),
  ]);

  const pie = JSON.parse(pieText);
  const area = JSON.parse(areaText);

  const male = parseInt(String(pie.male_count || "0").replace(/,/g, "")) || 0;
  const female = parseInt(String(pie.female_count || "0").replace(/,/g, "")) || 0;
  const total = parseInt(String(pie.total || "0").replace(/,/g, "")) || 0;

  let details = [];
  if (area.categories && area.categories.length) {
    details = area.categories.map((cls, j) => {
      const mRaw = area.male ? area.male[j] : 0;
      const fRaw = area.female ? area.female[j] : 0;
      const m = Array.isArray(mRaw) ? mRaw[0] || 0 : mRaw || 0;
      const f = Array.isArray(fRaw) ? fRaw[0] || 0 : fRaw || 0;
      return {
        className: formatClassName(cls),
        m: parseInt(m, 10) || 0,
        f: parseInt(f, 10) || 0,
      };
    });
  }
  if (!details.length && (male > 0 || female > 0)) {
    details = [{ className: "Total", m: male, f: female }];
  }

  return {
    male,
    female,
    total,
    categories: area.categories || [],
    details,
  };
}

module.exports = {
  getCsrf,
  parseOptions,
  inferLevel,
  formatClassName,
  fetchDistricts,
  fetchTehsils,
  fetchMarkazes,
  fetchSchools,
  fetchSchoolEnrollment,
  fetchWithRetry,
  sleep,
};
