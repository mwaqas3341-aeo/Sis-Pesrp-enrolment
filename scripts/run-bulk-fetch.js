const fs = require('fs');
const path = require('path');

// Configuration
const BASE_URL = 'https://sis.pesrp.edu.pk';
const CONCURRENCY_LIMIT = 15; // Safe parallel limit for government servers
const COOKIE = process.env.PESRP_COOKIE || 'YOUR_ACTIVE_COOKIE'; 
const CSRF_TOKEN = process.env.PESRP_CSRF || 'YOUR_ACTIVE_CSRF';

// File Paths
const MARAKEZ_FILE = path.join(__dirname, '../data/marakez.json');
const OUTPUT_FILE = path.join(__dirname, '../data/class_wise_enrollment.json');
const CHECKPOINT_FILE = path.join(__dirname, '../data/checkpoint.json');

// Helper for delays
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, options);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            if (i === retries - 1) throw err;
            await delay(2000 * (i + 1)); // Backoff
        }
    }
}

async function runBulkFetch() {
    console.log("🚀 Starting GitHub Actions Bulk Fetcher...");

    // 1. Load Data & Checkpoints
    const marakezList = JSON.parse(fs.readFileSync(MARAKEZ_FILE, 'utf8'));
    let outputData = [];
    let startIndex = 0;

    if (fs.existsSync(CHECKPOINT_FILE)) {
        const cp = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
        startIndex = cp.lastProcessedIndex + 1;
        if (fs.existsSync(OUTPUT_FILE)) {
            outputData = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
        }
        console.log(`Resuming from Markaz index ${startIndex}...`);
    }

    const headers = {
        'Cookie': COOKIE,
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    };

    // 2. Loop through Marakez
    for (let i = startIndex; i < marakezList.length; i++) {
        const m = marakezList[i];
        console.log(`[${i + 1}/${marakezList.length}] Processing Markaz: ${m.markaz_name}`);

        try {
            // Fetch schools for this Markaz
            const schoolUrl = `${BASE_URL}/user/get_schools?markaz=${m.markaz_id}&csrf_test_name=${CSRF_TOKEN}`;
            const schoolRes = await fetchWithRetry(schoolUrl, { headers });
            
            const regex = /<option value="(\d+)">(\d+) - (.*?)<\/option>/g;
            let match;
            const schools = [];

            while ((match = regex.exec(schoolRes.html)) !== null) {
                schools.push({ school_id: match[1], emis: match[2], name: match[3] });
            }

            // 3. Concurrently fetch class data for schools in this Markaz
            for (let j = 0; j < schools.length; j += CONCURRENCY_LIMIT) {
                const batch = schools.slice(j, j + CONCURRENCY_LIMIT);
                
                const promises = batch.map(async (sch) => {
                    const classUrl = `${BASE_URL}/dashboard_revamp/get_gender_bar_class?district=${m.district_id}&tehsil=${m.tehsil_id}&markaz=${m.markaz_id}&school=${sch.school_id}&classes=&s_id_emis_code=`;
                    try {
                        const data = await fetchWithRetry(classUrl, { headers });
                        if (data && data.male) {
                            outputData.push({
                                District: m.district_name,
                                Tehsil: m.tehsil_name,
                                Markaz: m.markaz_name,
                                EMIS: sch.emis,
                                School_Name: sch.name,
                                Male_Total: data.male.reduce((a, b) => a + b, 0),
                                Female_Total: data.female.reduce((a, b) => a + b, 0),
                                Class_Male: data.male,
                                Class_Female: data.female
                            });
                        }
                    } catch (e) {
                        console.error(`Failed EMIS ${sch.emis}: ${e.message}`);
                    }
                });

                await Promise.all(promises);
                await delay(500); // 0.5s pause between batches to protect the server
            }

            // 4. Save progress after every Markaz
            fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outputData, null, 2));
            fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({ lastProcessedIndex: i }));

        } catch (error) {
            console.error(`❌ Error on Markaz ${m.markaz_name}: ${error.message}`);
        }
    }

    console.log("🎉 Complete! All 39,000 schools fetched.");
    // Clean up checkpoint file on successful completion
    if (fs.existsSync(CHECKPOINT_FILE)) fs.unlinkSync(CHECKPOINT_FILE);
}

runBulkFetch();
