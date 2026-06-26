// ============================================================
// PESRP Bulk Fetch Runner
// Replaces: startBulkFetch / resumeBulkFetch / bulkProcessEnrollment_
//
// Run modes:
//   node scripts/run-bulk-fetch.js              -> resume or start
//   node scripts/run-bulk-fetch.js --reset       -> wipe checkpoint, start over
//   node scripts/run-bulk-fetch.js --max-ms=18000000  -> override time budget
// ============================================================

const fs = require("fs");
const path = require("path");
const api = require("./pesrp-api");

// ── Paths ─────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "..", "data");
const CHECKPOINT_FILE = path.join(DATA_DIR, "checkpoint.json");
const DISTRICTS_FILE = path.join(DATA_DIR, "districts.json");
const SCHOOLS_FILE = path.join(DATA_DIR, "schools.json");
const ENROLLMENT_FILE = path.join(DATA_DIR, "enrollment.json");
const ENROLLMENT_BY_DISTRICT_DIR = path.join(DATA_DIR, "enrollment-by-district");
const LOG_FILE = path.join(DATA_DIR, "run-log.txt");

// ── Tunables ──────────────────────────────────────────────────
// GitHub Actions free-tier jobs can run up to 6 hrs (360 min), but we
// stop well short of that so the workflow has time to commit + push.
const MAX_RUN_MS = getArgNumber("--max-ms", 5 * 60 * 60 * 1000); // 5 hours default
const SCHOOL_CONCURRENCY = getArgNumber("--concurrency", 8); // parallel schools per markaz
const RATE_LIMIT_DELAY_MS = getArgNumber("--delay-ms", 50); // gentle pacing between batches

const startTime = Date.now();

function getArgNumber(flag, fallback) {
  const arg = process.argv.find((a) => a.startsWith(flag + "="));
  if (!arg) return fallback;
  const val = Number(arg.split("=")[1]);
  return isNaN(val) ? fallback : val;
}

function isTimeUp() {
  return Date.now() - startTime > MAX_RUN_MS;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ENROLLMENT_BY_DISTRICT_DIR))
    fs.mkdirSync(ENROLLMENT_BY_DISTRICT_DIR, { recursive: true });
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log(`WARN: failed to read ${file}: ${err.message}`);
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── Checkpoint shape ──────────────────────────────────────────
// {
//   phase: "DISTRICTS" | "TEHSILS" | "MARKAZES" | "SCHOOLS" | "DONE",
//   districts: [...],
//   tehsils: [...],
//   markazRefs: [...],       // { id, name, tehsil_id, district_id, tehsil_name, district_name }
//   markazIdx: number,       // next markaz to process
//   stats: { ... }
// }

function loadCheckpoint() {
  const cp = readJsonSafe(CHECKPOINT_FILE, null);
  if (cp) return cp;
  return {
    phase: "DISTRICTS",
    districts: [],
    tehsils: [],
    markazRefs: [],
    markazIdx: 0,
    stats: {
      districtsTotal: 0,
      tehsilsTotal: 0,
      markazesTotal: 0,
      markazesDone: 0,
      schoolsFetched: 0,
      enrollmentRows: 0,
      errors: 0,
    },
  };
}

function saveCheckpoint(state) {
  writeJson(CHECKPOINT_FILE, state);
}

// ── Result accumulators (loaded fresh each run, since we
//    rewrite schools.json / enrollment.json wholesale at the end
//    of each markaz's processing to keep partial progress safe) ──

function loadSchoolsMap() {
  const arr = readJsonSafe(SCHOOLS_FILE, []);
  const map = {};
  arr.forEach((s) => (map[s.school_id] = s));
  return map;
}

function loadEnrollmentRows() {
  return readJsonSafe(ENROLLMENT_FILE, []);
}

// ============================================================
// PHASE 1: Districts
// ============================================================
async function phaseDistricts(state) {
  log("Phase: DISTRICTS — fetching district list");
  const districts = await api.fetchDistricts();
  state.districts = districts;
  state.stats.districtsTotal = districts.length;
  writeJson(DISTRICTS_FILE, districts);
  log(`Found ${districts.length} districts`);
  state.phase = "TEHSILS";
  state.districtIdx = 0;
  state.tehsils = [];
  return state;
}

// ============================================================
// PHASE 2: Tehsils (per district)
// ============================================================
async function phaseTehsils(state) {
  log("Phase: TEHSILS");
  state.districtIdx = state.districtIdx || 0;

  while (state.districtIdx < state.districts.length) {
    if (isTimeUp()) {
      log("Time limit hit during TEHSILS — checkpoint saved");
      return state;
    }
    const d = state.districts[state.districtIdx];
    try {
      const tehsils = await api.fetchTehsils(d.id);
      tehsils.forEach((t) =>
        state.tehsils.push({
          id: t.id,
          name: t.name,
          district_id: d.id,
          district_name: d.name,
        })
      );
      log(`District ${d.name} (${d.id}) -> ${tehsils.length} tehsils`);
    } catch (err) {
      log(`SKIP district ${d.id}: ${err.message}`);
      state.stats.errors++;
    }
    state.districtIdx++;
    saveCheckpoint(state);
  }

  state.stats.tehsilsTotal = state.tehsils.length;
  state.phase = "MARKAZES";
  state.tehsilIdx = 0;
  state.markazRefs = state.markazRefs || [];
  log(`All tehsils loaded: ${state.tehsils.length}. -> MARKAZES`);
  return state;
}

// ============================================================
// PHASE 3: Markazes (per tehsil)
// ============================================================
async function phaseMarkazes(state) {
  log("Phase: MARKAZES");
  state.tehsilIdx = state.tehsilIdx || 0;
  state.markazRefs = state.markazRefs || [];

  while (state.tehsilIdx < state.tehsils.length) {
    if (isTimeUp()) {
      log("Time limit hit during MARKAZES — checkpoint saved");
      return state;
    }
    const t = state.tehsils[state.tehsilIdx];
    try {
      const markazes = await api.fetchMarkazes(t.id);
      markazes.forEach((mk) =>
        state.markazRefs.push({
          id: mk.id,
          name: mk.name,
          tehsil_id: t.id,
          tehsil_name: t.name,
          district_id: t.district_id,
          district_name: t.district_name,
        })
      );
      log(`Tehsil ${t.name} (${t.id}) -> ${markazes.length} markazes`);
    } catch (err) {
      log(`SKIP tehsil ${t.id}: ${err.message}`);
      state.stats.errors++;
    }
    state.tehsilIdx++;
    saveCheckpoint(state);
  }

  state.stats.markazesTotal = state.markazRefs.length;
  state.phase = "SCHOOLS";
  state.markazIdx = 0;
  log(`All markazes loaded: ${state.markazRefs.length}. -> SCHOOLS`);
  return state;
}

// ── Small concurrency-limited map helper (no extra deps) ──────
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ============================================================
// PHASE 4: Schools + Enrollment (per markaz, batched/concurrent)
// ============================================================
async function phaseSchools(state) {
  log("Phase: SCHOOLS/ENROLLMENT");
  state.markazIdx = state.markazIdx || 0;

  const schoolMap = loadSchoolsMap();
  let enrollRows = loadEnrollmentRows();
  const today = new Date().toISOString().slice(0, 10);
  const acYear = process.env.ACADEMIC_YEAR || "2025-26";

  // Track which districts had ANY update this run, so we only
  // rewrite the per-district enrollment files that changed.
  const touchedDistricts = new Set();

  let sinceLastSave = 0;
  const SAVE_EVERY_N_MARKAZ = 5; // flush to disk periodically, not just at the end

  while (state.markazIdx < state.markazRefs.length) {
    if (isTimeUp()) {
      log("Time limit hit during SCHOOLS — flushing and saving checkpoint");
      flushResults(schoolMap, enrollRows, touchedDistricts);
      saveCheckpoint(state);
      return state;
    }

    const mk = state.markazRefs[state.markazIdx];
    try {
      const schools = await api.fetchSchools(mk.id);

      if (!schools.length) {
        log(`Markaz ${mk.name} (${mk.id}) -> 0 schools`);
      } else {
        // Remove any previous rows for this markaz+today before re-adding
        enrollRows = enrollRows.filter(
          (r) => !(r.markaz_id === mk.id && r.fetch_date === today)
        );

        let mkMale = 0,
          mkFemale = 0,
          mkTotal = 0;

        await mapWithConcurrency(schools, SCHOOL_CONCURRENCY, async (school) => {
          try {
            const enr = await api.fetchSchoolEnrollment(
              mk.district_id,
              mk.tehsil_id,
              mk.id,
              school.id
            );
            const level = api.inferLevel(school.name, enr.categories);

            schoolMap[school.id] = {
              school_id: school.id,
              emis_code: school.emis,
              school_name: school.name,
              level,
              markaz_id: mk.id,
              markaz_name: mk.name,
              tehsil_id: mk.tehsil_id,
              tehsil_name: mk.tehsil_name,
              district_id: mk.district_id,
              district_name: mk.district_name,
              total_enrollment: enr.total,
              total_male: enr.male,
              total_female: enr.female,
              last_fetched: new Date().toISOString(),
            };

            enr.details.forEach((d) => {
              enrollRows.push({
                school_id: school.id,
                emis_code: school.emis,
                school_name: school.name,
                markaz_id: mk.id,
                markaz_name: mk.name,
                tehsil_id: mk.tehsil_id,
                district_id: mk.district_id,
                class_name: d.className,
                male: d.m,
                female: d.f,
                total: d.m + d.f,
                fetch_date: today,
                academic_year: acYear,
              });
            });

            mkMale += enr.male;
            mkFemale += enr.female;
            mkTotal += enr.total;
            state.stats.schoolsFetched++;
            state.stats.enrollmentRows += enr.details.length;
          } catch (err) {
            log(`  SKIP school ${school.name} (${school.id}): ${err.message}`);
            state.stats.errors++;
          }
        });

        touchedDistricts.add(mk.district_id);
        log(
          `[${state.markazIdx + 1}/${state.markazRefs.length}] ${mk.name} -> ${
            schools.length
          } schools, M=${mkMale} F=${mkFemale} T=${mkTotal}`
        );
      }
    } catch (err) {
      log(`SKIP markaz ${mk.id} (${mk.name}): ${err.message}`);
      state.stats.errors++;
    }

    state.markazIdx++;
    state.stats.markazesDone++;
    sinceLastSave++;

    if (sinceLastSave >= SAVE_EVERY_N_MARKAZ) {
      flushResults(schoolMap, enrollRows, touchedDistricts);
      saveCheckpoint(state);
      sinceLastSave = 0;
    }

    if (RATE_LIMIT_DELAY_MS > 0) await api.sleep(RATE_LIMIT_DELAY_MS);
  }

  flushResults(schoolMap, enrollRows, touchedDistricts);
  state.phase = "DONE";
  log("All markazes processed. -> DONE");
  return state;
}

function flushResults(schoolMap, enrollRows, touchedDistricts) {
  writeJson(SCHOOLS_FILE, Object.values(schoolMap));
  writeJson(ENROLLMENT_FILE, enrollRows);

  // Also write per-district enrollment files for lighter frontend loads.
  // Only rewrite districts touched this run to save time on huge datasets.
  const byDistrict = {};
  enrollRows.forEach((r) => {
    if (!byDistrict[r.district_id]) byDistrict[r.district_id] = [];
    byDistrict[r.district_id].push(r);
  });
  touchedDistricts.forEach((distId) => {
    const file = path.join(ENROLLMENT_BY_DISTRICT_DIR, `${distId}.json`);
    writeJson(file, byDistrict[distId] || []);
  });

  // Lightweight summary for dashboards (counts only, fast to load)
  const summary = {
    generatedAt: new Date().toISOString(),
    totalSchools: Object.keys(schoolMap).length,
    totalEnrollmentRows: enrollRows.length,
  };
  writeJson(path.join(DATA_DIR, "summary.json"), summary);
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  ensureDataDir();

  if (process.argv.includes("--reset")) {
    log("--reset flag passed: clearing checkpoint and output files");
    [CHECKPOINT_FILE, SCHOOLS_FILE, ENROLLMENT_FILE, DISTRICTS_FILE].forEach((f) => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });
  }

  let state = loadCheckpoint();
  log(`Starting run. Current phase: ${state.phase}`);

  try {
    if (state.phase === "DISTRICTS") state = await phaseDistricts(state);
    if (state.phase === "TEHSILS" && !isTimeUp()) state = await phaseTehsils(state);
    if (state.phase === "MARKAZES" && !isTimeUp()) state = await phaseMarkazes(state);
    if (state.phase === "SCHOOLS" && !isTimeUp()) state = await phaseSchools(state);
  } catch (err) {
    log(`FATAL ERROR: ${err.stack || err.message}`);
    saveCheckpoint(state);
    process.exitCode = 1;
    return;
  }

  saveCheckpoint(state);

  if (state.phase === "DONE") {
    log("=== BULK FETCH COMPLETE ===");
    log(
      `Districts: ${state.stats.districtsTotal} | Tehsils: ${state.stats.tehsilsTotal} | ` +
        `Markazes: ${state.stats.markazesTotal} | Schools: ${state.stats.schoolsFetched} | ` +
        `Enrollment rows: ${state.stats.enrollmentRows} | Errors: ${state.stats.errors}`
    );
  } else {
    log(
      `=== RUN PAUSED (time budget reached) — phase=${state.phase}, ` +
        `markaz ${state.markazIdx || 0}/${state.markazRefs.length || 0}. ` +
        `Re-run the workflow to resume. ===`
    );
  }
}

main();
