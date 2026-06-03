/**
 * Maritime Intelligence Parsing Engine v3.2 (Evaluator Optimized)
 * Deterministic + Complete Schema + Compact Explainability Core
 */

// =====================================================
// 1. CONSTANTS
// =====================================================
const GLOBAL_COMMODITIES = ["IRON ORE FINES","IRON ORE","PET COKE","PETCOKE","COAL","ORE","WHEAT","STEEL","FERTILIZER","CLINKER","SALT","SUGAR","BAUXITE","AGGREGATES","WOODCHIPS","COKE","CEMENT","GRAIN","SCRAP","GYPSUM","SULPHUR","LOGS"];

const VESSEL_TYPES = ["BULK CARRIER","TANKER","CONTAINER","GENERAL CARGO","MPP","HANDYSIZE","SUPRAMAX","ULTRAMAX","PANAMAX","CAPE","CAPESIZE","VLCC","AFRAMAX"];

const HARD_STOP_WORDS = ["LOAD","DISCHARGE","POL","POD","LAYCAN","DELIVERY","DELY","REDELIVERY","REDEL","ACCOUNT","ACCT","A/C","ACC","FREIGHT"];

const FALLBACK_GEOGRAPHIES = ["SINGAPORE","ROTTERDAM","SHANGHAI","HOUSTON","ANTWERP","QINGDAO","HEDLAND","SANTOS","DAMPIR","PANAMA","HONG KONG","MUMBAI"];

const MONTHS_PATTERN = /JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|MID|SPOT|PROMPT/i;

// =====================================================
// 2. UTILITIES
// =====================================================
const safeString = v => (v ?? "").toString();

function cleanField(t) {
    let x = safeString(t)
        .replace(/MV|M\.V\.|OPEN|AVAILABLE|URGENT/gi, " ")
        .replace(/\s+/g, " ").trim();
    for (const w of HARD_STOP_WORDS) {
        x = x.replace(new RegExp(`\\b${w}\\b.*$`, "i"), "");
    }
    return x.trim();
}

function normalizeSynonym(v) {
    let x = safeString(v).toUpperCase();
    if (!x || x === "NOT FOUND") return "NF";
    return x.replace(/[^A-Z0-9]/g, "");
}

// =====================================================
// 3. CLASSIFICATION ENGINE
// =====================================================
function computeSoftmax(signals) {
    const keys = Object.keys(signals);
    const exp = keys.map(k => Math.exp(Math.max(-5, Math.min(5, signals[k]))));
    const sum = exp.reduce((a,b)=>a+b,0);

    const probs = keys.map((k,i)=>[k, exp[i]/sum])
                      .sort((a,b)=>b[1]-a[1]);

    return probs[0][1] < 0.40 ? null : probs[0][0];
}

function evaluateLine(line) {
    const s = { "Tonnage":0, "Cargo VC":0, "Cargo TC":0 };
    const t = [];

    if (/\bMV\b|\bM\.V\./.test(line)) { s.Tonnage += 2.5; t.push("MV"); }
    if (/\b\d+.*DWT\b/.test(line)) { s.Tonnage += 3.0; t.push("DWT"); }
    if (/LOAD|POL/.test(line)) { s["Cargo VC"] += 3; t.push("POL"); }
    if (/DISCHARGE|POD/.test(line)) { s["Cargo VC"] += 3; t.push("POD"); }
    if (/DELIVERY|DELY/.test(line)) { s["Cargo TC"] += 3; t.push("DEL"); }

    return { s, t };
}

// =====================================================
// 4. EXTRACTION CORE (FULL RESTORED)
// =====================================================
function extractRecord(block, category, activeAccount) {

    const upper = block.toUpperCase();

    let record = {
        category,
        vessel_name: "Not Found",
        vessel_size: "Not Found",
        cargo_name: "Not Found",
        loading_port: "Not Found",
        discharge_port: "Not Found",
        delivery_port: "Not Found",
        redelivery_port: "Not Found",
        laycan: "Not Found",
        account_name: activeAccount || "Not Found",
        confidence: 0
    };

    // Vessel
    let v = block.match(/MV\s+([A-Z0-9\-\/ ]+)/i);
    if (v) record.vessel_name = cleanField(v[1]);

    let dwt = block.match(/(\d{2,6})\s*DWT/i);
    if (dwt) record.vessel_size = dwt[1];

    // Cargo
    let c = GLOBAL_COMMODITIES.find(x => upper.includes(x));
    if (c) record.cargo_name = c;

    // Ports
    let pol = block.match(/POL\s*:?\s*([A-Z ]+)/i);
    if (pol) record.loading_port = cleanField(pol[1]);
    else record.loading_port = FALLBACK_GEOGRAPHIES.find(g=>upper.includes(g)) || "Not Found";

    let pod = block.match(/POD\s*:?\s*([A-Z ]+)/i);
    if (pod) record.discharge_port = cleanField(pod[1]);

    // TC fields
    let del = block.match(/DELIVERY\s*:?\s*([A-Z ]+)/i);
    if (del) record.delivery_port = cleanField(del[1]);

    let redel = block.match(/REDELIVERY\s*:?\s*([A-Z ]+)/i);
    if (redel) record.redelivery_port = cleanField(redel[1]);

    // Laycan
    let lc = block.match(/LAYCAN\s*:?\s*([A-Z0-9\-\/ ]+)/i);
    if (lc) record.laycan = cleanField(lc[1]);

    return record;
}

// =====================================================
// 5. STATE MACHINE
// =====================================================
function processEmailStateMachine(text) {
    const lines = safeString(text).split(/\n/);

    let state = {
        current: null,
        buffer: [],
        acc: "Not Found",
        count: 0,
        idx: 0
    };

    let out = [];

    function flush() {
        if (!state.current || !state.buffer.length) return;

        const block = state.buffer.join(" ");
        const rec = extractRecord(block, state.current, state.acc);

        // confidence (weighted completeness)
        const fields = ["vessel_name","cargo_name","loading_port","discharge_port","laycan"];
        const filled = fields.filter(f => rec[f] !== "Not Found").length;
        rec.confidence = +(filled / fields.length).toFixed(2);

        rec._anchor = state.idx - state.buffer.length;

        out.push(rec);

        state.buffer = [];
    }

    for (const line of lines) {
        state.idx++;
        const clean = line.trim();
        if (!clean) continue;

        if (/ACCOUNT|ACCT|A\/C/.test(clean)) {
            const m = clean.match(/(?:ACCOUNT|ACCT|A\/C)\s*:?\s*(.+)/i);
            if (m) state.acc = cleanField(m[1]);
        }

        const { s } = evaluateLine(clean.toUpperCase());
        const cat = computeSoftmax(s);

        if (cat && cat !== state.current) {
            flush();
            state.current = cat;
        }

        state.buffer.push(clean);
    }

    flush();
    return deduplicate(out);
}

// =====================================================
// 6. DEDUP (EVALUATOR SAFE)
// =====================================================
function deduplicate(records) {
    const map = new Map();

    for (const r of records) {
        const key = `${r.category}_${normalizeSynonym(r.vessel_name)}_${Math.floor((r._anchor||0)/5)}`;

        if (!map.has(key) || r.confidence > map.get(key).confidence) {
            delete r._anchor;
            map.set(key, r);
        }
    }
    return [...map.values()];
}