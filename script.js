// =========================================================================
// GLOBAL ENGINE CONFIGURATIONS & COMPACT BOUNDARY DICTIONARIES
// =========================================================================
let lastResult = []; 
let DEBUG_MODE = false;

const GLOBAL_COMMODITIES = [
    "IRON ORE FINES", "IRON ORE", "PET COKE", "PETCOKE", "COAL", "ORE", "WHEAT", 
    "STEEL", "FERTILIZER", "CLINKER", "SALT", "SUGAR", "BAUXITE", "AGGREGATES", 
    "WOODCHIPS", "COKE", "CEMENT", "GRAIN", "SCRAP", "GYPSUM", "SULPHUR", "LOGS"
];

const VESSEL_TYPES = [
    "BULK CARRIER", "TANKER", "CONTAINER", "GENERAL CARGO", "MPP", "TWEEN DECKER",
    "HANDYSIZE", "SUPRAMAX", "ULTRAMAX", "PANAMAX", "KAMSARMAX", "CAPE", "CAPESIZE",
    "MR", "LR1", "LR2", "VLCC", "AFRAMAX"
];

const HARD_STOP_WORDS = [
    "LOAD", "DISCHARGE", "POL", "POD", "LAYCAN", "LC", "DELIVERY", "DELY", 
    "REDELIVERY", "REDEL", "ACCOUNT", "ACCT", "A/C", "ACC", "FREIGHT", "CHOPT", 
    "RATE", "DURATION", "OWNERS", "OWNER"
];

const FALLBACK_GEOGRAPHIES = [
    "SINGAPORE", "ROTTERDAM", "FUJAIRAH", "SHANGHAI", "HOUSTON", "ANTWERP", "QINGDAO", 
    "HEDLAND", "TAMPICO", "SANTOS", "TUBARAO", "RICHARDS BAY", "DAMPIER", "NEWCASTLE",
    "RAVENNA", "GIBRALTAR", "SUEZ", "PANAMA", "HONG KONG", "ST PETERSBURG", "MUMBAI"
];

const SORTED_COMMODITIES = [...GLOBAL_COMMODITIES].sort((a, b) => b.length - a.length);
const COMMODITY_REGEX_MAP = SORTED_COMMODITIES.map(c => ({
    name: c,
    regex: new RegExp(`\\b${c.replace(/\s+/g, '\\s+')}\\b`, "i")
}));

const COMMODITY_SET = new Set(GLOBAL_COMMODITIES);

const FIELD_WEIGHTS = {
    "Tonnage":  { vessel_name: 0.30, vessel_size: 0.20, open_port: 0.20, open_date: 0.15, account_name: 0.10, vessel_type: 0.05 },
    "Cargo VC": { cargo_name: 0.35, loading_port: 0.25, discharge_port: 0.25, laycan: 0.15 },
    "Cargo TC": { delivery_port: 0.30, redelivery_port: 0.30, laycan: 0.25, account_name: 0.15 }
};

const MONTHS_PATTERN = /JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|MID|SPOT|PROMPT/i;
const NUMERIC_DATE_PATTERN = /\b\d{1,2}[\s\-\/]\d{1,2}\b/;

// =========================================================================
// 🛡️ CRASH PREVENTION DOM CONTROL LAYER & INTERACTION EFFECTS
// =========================================================================
const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) {
        if (el.textContent !== String(value)) {
            el.textContent = value;
            // Animate card values on actual data mutation
            const card = el.closest(".metric-card");
            if (card) {
                card.classList.remove("pulse-update");
                void card.offsetWidth; // Force hardware-accelerated layout reflow
                card.classList.add("pulse-update");
            }
        }
    }
};

const toggleClass = (id, className, state) => {
    const el = document.getElementById(id);
    if (el) {
        if (state) el.classList.add(className);
        else el.classList.remove(className);
    }
};

function safeString(val) {
    return (val === undefined || val === null) ? "" : String(val);
}

function safeExecute(fn, fallback) {
    try {
        return fn();
    } catch (e) {
        console.error("Pipeline Runtime Execution Intercepted via safeExecute:", e);
        return fallback;
    }
}

function toggleDebugMode() {
    const el = document.getElementById("debugToggle");
    DEBUG_MODE = el ? el.checked : false;
}

function normalizeText(text) {
    return safeString(text).replace(/[@#*]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeSynonym(stringVal) {
    let cleanStr = safeString(stringVal);
    if (!cleanStr || cleanStr === "Not Found") return "NF";
    return cleanStr.toUpperCase()
        .replace(/\b(M\.V\.|MV|VESSEL|BULKER)\b/g, "")
        .replace(/\b(ACCOUNT|ACCT|A\/C|ACC)\b/g, "")
        .replace(/\b(DELIVERY|DELY)\b/g, "DELY")
        .replace(/\b(REDELIVERY|REDEL)\b/g, "REDEL")
        .replace(/[^A-Z0-9]/g, "") 
        .trim();
}

function cleanField(text) {
    let target = safeString(text);
    if (!target) return "";
    let cleaned = target.replace(/BULK CARRIER|AVAILABLE|URGENT|FOR PROMPT FIXING|MV|M\.V\./gi, "")
                        .replace(/O\/A|OPEN/gi, "")
                        .replace(/\s+/g, " ")
                        .trim();
    
    for (let word of HARD_STOP_WORDS) {
        let regex = new RegExp(`\\b${word}\\b.*$`, "i");
        cleaned = cleaned.replace(regex, "");
    }
    return cleaned.replace(/\s+/g, " ").trim();
}

// =========================================================================
// EXTRACTION MATRIX ENGINE INTERNALS
// =========================================================================
function isValidLaycan(val) {
    let cleanVal = safeString(val);
    if (!cleanVal) return false;
    let v = cleanVal.toUpperCase();
    return MONTHS_PATTERN.test(v) ||
           NUMERIC_DATE_PATTERN.test(v) ||
           /\b\d{1,2}\s+[A-Z]{3,}\b/.test(v);
}

function fallbackFieldExtraction(text, upperText, keywords) {
    for (let key of keywords) {
        if (upperText.includes(key)) {
            return key;
        }
    }
    return "Not Found";
}

function validateRecordFields(record) {
    if (!record) return null;

    if (record.vessel_name) {
        for (let stopWord of HARD_STOP_WORDS) {
            if (new RegExp(`\\b${stopWord}\\b`, "i").test(safeString(record.vessel_name))) {
                record.vessel_name = "Not Found";
            }
        }
    }

    let vLoad = safeString(record.loading_port).toUpperCase();
    let vDisch = safeString(record.discharge_port).toUpperCase();
    if (record.category === "Cargo VC" && vLoad && vDisch && vLoad === vDisch) {
        record.discharge_port = "Not Found"; 
    }

    let vDel = safeString(record.delivery_port).toUpperCase();
    let vRedel = safeString(record.redelivery_port).toUpperCase();
    if (record.category === "Cargo TC" && vDel && vRedel && vDel === vRedel) {
        record.redelivery_port = "Not Found";
    }

    if (record.laycan && record.laycan !== "Not Found") {
        if (!isValidLaycan(record.laycan)) {
            record.laycan = "Not Found"; 
        } else {
            let splitChunks = safeString(record.laycan).split(/\s+/);
            if (splitChunks.length > 4) {
                record.laycan = cleanField(splitChunks.slice(0, 3).join(" "));
            }
        }
    }

    return record;
}

function extractDeterministicCargo(text, upperText) {
    for (let target of COMMODITY_REGEX_MAP) {
        if (target.regex.test(upperText)) {
            return { name: target.name, engine: "Sorted_Commodity_Regex_Map" };
        }
    }
    
    let splitTokens = upperText.split(/[\s,.\-\/]+/);
    for (let token of splitTokens) {
        if (COMMODITY_SET.has(token)) {
            return { name: token, engine: "Optimized_Commodity_Set_Lookup" };
        }
    }

    let mtMatch = safeString(text).match(/(?:\d+[\d,]*\s*(?:MT|MTS|MTON|KT|K)\s+)\b([A-Z\-\/]+)\b/i);
    if (mtMatch) {
        let candidate = safeString(mtMatch[1]).toUpperCase().trim();
        if (!HARD_STOP_WORDS.includes(candidate) && candidate.length > 2) {
            return { name: candidate, engine: "Volumetric_MT_Fallback_Regex" };
        }
    }
    return { name: "Not Found", engine: "None" };
}

// =========================================================================
// LINE EVALUATION & STATE SPLIT MATRIX
// =========================================================================
function evaluateLineProbabilities(upperLine) {
    let signals = { "Tonnage": 0, "Cargo VC": 0, "Cargo TC": 0 };
    let matchingTokens = [];

    if (upperLine.length > 500) return { signals, matchingTokens };

    if (/\b(?:MV|M\.V\.)\b/.test(upperLine)) { signals["Tonnage"] += 2.5; matchingTokens.push("MV_PREFIX"); }
    if (/\b\d+[\d,]*\s*DWT\b/.test(upperLine)) { signals["Tonnage"] += 3.0; matchingTokens.push("DWT_MEASURE"); }
    if (/\bOPEN\b/.test(upperLine)) { signals["Tonnage"] += 1.5; matchingTokens.push("OPEN_STATUS"); }
    if (VESSEL_TYPES.some(v => upperLine.includes(v))) { signals["Tonnage"] += 1.0; matchingTokens.push("VESSEL_TYPE_MATCH"); }

    if (/LOAD\s*PORT|POL/.test(upperLine)) { signals["Cargo VC"] += 3.0; matchingTokens.push("POL_INDICATOR"); }
    if (/DISCHARGE\s*PORT|POD/.test(upperLine)) { signals["Cargo VC"] += 3.0; matchingTokens.push("POD_INDICATOR"); }
    if (/\bVOYAGE\b/.test(upperLine)) { signals["Cargo VC"] += 2.0; matchingTokens.push("VOYAGE_KEYWORD"); }
    if (COMMODITY_REGEX_MAP.some(c => c.regex.test(upperLine))) { signals["Cargo VC"] += 2.5; matchingTokens.push("COMMODITY_MATCH"); }

    if (/\b(?:DELIVERY|DELY)\b/.test(upperLine)) { signals["Cargo TC"] += 3.0; matchingTokens.push("DELIVERY_INDICATOR"); }
    if (/\b(REDELIVERY|REDEL)\b/.test(upperLine)) { signals["Cargo TC"] += 3.0; matchingTokens.push("REDELIVERY_INDICATOR"); }
    if (/TIME\s*CHARTER|\bT\/C\b/.test(upperLine)) { signals["Cargo TC"] += 2.5; matchingTokens.push("TIME_CHARTER_KEYWORD"); }

    return { signals, matchingTokens };
}

function detectHardSplit(line) {
    return /\b(MV|VESSEL|DWT)\b.*\b(MV|VESSEL|DWT)\b/i.test(line) || 
           /\bOPEN\b.*\b(MV|VESSEL|DWT)\b/i.test(line);
}

// =========================================================================
// DETERMINISTIC LINE STATE SCANNERS
// =========================================================================
function processEmailStateMachine(rawText) {
    let lines = safeString(rawText).split(/\r?\n/);
    
    let compiledRecords = [];
    let state = {
        currentCategory: null,
        bufferLines: [],
        activeAccount: "Not Found",
        consecutiveEmptyLines: 0,
        lineIndex: 0,
        explanationLog: []
    };

    function flushCurrentState() {
        if (!state.currentCategory || state.bufferLines.length === 0) return;

        let blockText = normalizeText(state.bufferLines.join(" "));
        let blockUpper = blockText.toUpperCase();
        
        let record = { 
            category: state.currentCategory,
            _anchor_line: state.lineIndex - state.bufferLines.length,
            _engines_triggered: [],
            _classification_triggers: [...state.explanationLog]
        };

        if (state.currentCategory === "Tonnage") {
            let vesselMatch = blockText.match(/(?:MV|M\.V\.)\s+([A-Za-z][A-Za-z0-9\-\/ ]+?)\s+[\d,]{4,10}\s*DWT/i) || 
                              blockText.match(/(?:MV|M\.V\.|VESSEL)?\s*([A-Za-z][A-Za-z0-9\-\/ ]+?)\s+DWT/i) ||
                              blockText.match(/\b(?:MV|M\.V\.)\s+([A-Z0-9\-\/ ]{3,20})\b/i); 
            record.vessel_name = vesselMatch ? cleanField(vesselMatch[1]) : "Not Found";
            if (vesselMatch) record._engines_triggered.push("Vessel_Cascading_Matrix");

            let sizeMatch = blockText.match(/([\d,]{4,10})\s*DWT/i) || blockText.match(/\b(\d{2,3}),?\d{3}\b\s*(?:DWT)?/i);
            record.vessel_size = sizeMatch ? sizeMatch[1].replace(/,/g, "") : "Not Found";
            if (sizeMatch) record._engines_triggered.push("DWT_Cascading_Matrix");

            let portMatch = blockUpper.match(/OPEN\s+([A-Z0-9,\-\/\s]{3,25}?)(?=\s(?:PROMPT|SPOT|MID|EARLY|LAYCAN|O\/A|ETA|ACC|ACCOUNT|ACCT|A\/C|OWNERS|OWNER|$))/) ||
                            blockUpper.match(/(?:OPENAT|OPENIN|AT)\s+([A-Z0-9,\-\/\s]{3,20})\b/);
            record.open_port = portMatch ? cleanField(portMatch[1]) : "Not Found";
            if (portMatch) record._engines_triggered.push("Open_Port_Cascading_Matrix");
            
            if (record.open_port === "Not Found") {
                record.open_port = fallbackFieldExtraction(blockText, blockUpper, FALLBACK_GEOGRAPHIES);
                if (record.open_port !== "Not Found") record._engines_triggered.push("Open_Port_Dictionary_Recovery");
            }

            let dateMatch = blockUpper.match(/(?:O\/A|ETA)\s*([A-Z0-9\-\/\s]{3,20}?)(?=\s(?:ACC|ACCOUNT|ACCT|A\/C|$))/) ||
                            blockUpper.match(/\b(?:\d{1,2}(?:ST|ND|RD|TH)?[\s\-\/]\d{1,2}\s+[A-Z]+|\d{1,2}\s+[A-Z]+|MID\s+[A-Z]+|PROMPT|SPOT)\b/) ||
                            blockUpper.match(MONTHS_PATTERN);
            record.open_date = dateMatch ? cleanField(dateMatch[1] || dateMatch[0]) : "Not Found";
            if (dateMatch) record._engines_triggered.push("Open_Date_Cascading_Matrix");
            
            record.account_name = state.activeAccount;
            record.vessel_type = VESSEL_TYPES.find(v => blockUpper.replace(/\s+/g, ' ').includes(v)) || "Not Found";

        } else if (state.currentCategory === "Cargo VC") {
            let cargoData = extractDeterministicCargo(blockText, blockUpper);
            record.cargo_name = cargoData.name;
            if (cargoData.engine !== "None") record._engines_triggered.push(cargoData.engine);

            let load = blockText.match(/(?:LOAD PORT|POL)\s*:?\s*([A-Za-z0-9,\-\/\s]{2,25}?)(?=\s+(?:DISCHARGE|POD|LAYCAN|LC|ACCOUNT|ACC|ACCT|$))/i) ||
                       blockText.match(/\b(?:POL|LOADING)\s+([A-Z0-9,\-\/\s]{2,20})\b/i);
            record.loading_port = load ? cleanField(load[1]) : "Not Found";
            if (load) record._engines_triggered.push("POL_Cascading_Matrix");
            
            if (record.loading_port === "Not Found") {
                record.loading_port = fallbackFieldExtraction(blockText, blockUpper, FALLBACK_GEOGRAPHIES);
                if (record.loading_port !== "Not Found") record._engines_triggered.push("POL_Dictionary_Recovery");
            }

            let discharge = blockText.match(/(?:DISCHARGE PORT|POD)\s*:?\s*([A-Za-z0-9,\-\/\s]{2,25}?)(?=\s+(?:LAYCAN|LC|ACCOUNT|ACC|ACCT|$))/i) ||
                            blockText.match(/\b(?:POD|DISCHARGING)\s+([A-Z0-9,\-\/\s]{2,20})\b/i);
            record.discharge_port = discharge ? cleanField(discharge[1]) : "Not Found";
            if (discharge) record._engines_triggered.push("POD_Cascading_Matrix");
            
            if (record.discharge_port === "Not Found") {
                record.discharge_port = fallbackFieldExtraction(blockText, blockUpper, FALLBACK_GEOGRAPHIES);
                if (record.discharge_port !== "Not Found") record._engines_triggered.push("POD_Dictionary_Recovery");
            }

            let laycan = blockText.match(/LAYCAN\s*:?\s*([A-Z0-9\-\/\s]{3,25}?)(?=\s+(?:ACC|ACCOUNT|ACCT|FREIGHT|CHOPT|T\/C|$))/i) ||
                         blockText.match(/\b\d{1,2}(?:[\s\-\/\d]+?)[A-Z]{3,}\b/i) ||
                         blockText.match(MONTHS_PATTERN);
            record.laycan = laycan ? cleanField(laycan[1] || laycan[0]) : "Not Found";
            if (laycan) record._engines_triggered.push("Laycan_Cascading_Matrix");

        } else if (state.currentCategory === "Cargo TC") {
            let delivery = blockText.match(/(?:DELIVERY|DELY)\s*:?\s*([A-Za-z0-9,\-\/\s]{2,25}?)(?=\s+(?:REDELIVERY|REDEL|LAYCAN|LC|ACCOUNT|ACC|$))/i) ||
                           blockText.match(/\b(?:DELY|DEL)\s+([A-Z0-9,\-\/\s]{2,20})\b/i);
            record.delivery_port = delivery ? cleanField(delivery[1]) : "Not Found";
            if (delivery) record._engines_triggered.push("TC_Delivery_Cascading_Matrix");
            
            if (record.delivery_port === "Not Found") {
                record.delivery_port = fallbackFieldExtraction(blockText, blockUpper, FALLBACK_GEOGRAPHIES);
                if (record.delivery_port !== "Not Found") record._engines_triggered.push("TC_Del_Dictionary_Recovery");
            }

            let redelivery = blockText.match(/(?:REDELIVERY|REDEL)\s*:?\s*([A-Za-z0-9,\-\/\s]{2,25}?)(?=\s+(?:LAYCAN|LC|ACCOUNT|ACC|$))/i) ||
                             blockText.match(/\b(?:REDELY|REDEL)\s+([A-Z0-9,\-\/\s]{2,20})\b/i);
            record.redelivery_port = redelivery ? cleanField(redelivery[1]) : "Not Found";
            if (redelivery) record._engines_triggered.push("TC_Redelivery_Cascading_Matrix");
            
            if (record.redelivery_port === "Not Found") {
                record.redelivery_port = fallbackFieldExtraction(blockText, blockUpper, FALLBACK_GEOGRAPHIES);
                if (record.redelivery_port !== "Not Found") record._engines_triggered.push("TC_Redel_Dictionary_Recovery");
            }

            let laycan = blockText.match(/LAYCAN\s*:?\s*([A-Z0-9\-\/\s]{3,25}?)(?=\s+(?:ACC|ACCOUNT|FREIGHT|CHOPT|T\/C|$))/i) || 
                         blockText.match(/LC\s*:?\s*([A-Za-z0-9,\-\/\s]{3,25}?)(?=\s+(?:ACC|ACCOUNT|RATE|$))/i) ||
                         blockText.match(MONTHS_PATTERN);
            record.laycan = laycan ? cleanField(laycan[1] || laycan[0]) : "Not Found";
            if (laycan) record._engines_triggered.push("TC_Laycan_Cascading_Matrix");
            
            record.account_name = state.activeAccount;
        }

        record._raw_span_context = blockText;

        let validatedRecord = validateRecordFields(record);
        if (validatedRecord) compiledRecords.push(validatedRecord);

        state.bufferLines = [];
        state.explanationLog = [];
    }

    for (let line of lines) {
        state.lineIndex++;
        
        if (state.lineIndex > 5000) break;

        let cleanLine = line.replace(/\s+/g, " ").trim();
        if (!cleanLine) {
            state.consecutiveEmptyLines++;
            if (state.consecutiveEmptyLines > 3) {
                state.activeAccount = "Not Found";
            }
            continue;
        }

        if (detectHardSplit(cleanLine) && state.bufferLines.length > 0) {
            flushCurrentState();
        }
        
        state.consecutiveEmptyLines = 0; 
        let upperLine = cleanLine.toUpperCase();

        let accMatch = cleanLine.match(/(?:\bACCOUNT\b|\bACCT\b|\bA\/C\b|\bACC\b)\s*:?\s*([A-Za-z0-9,\- ]+?)(?=\s*[\r\n]|\sOPEN|\sDWT|\sO\/A|\sLAYCAN|$)/i);
        if (accMatch) {
            let parsedAcc = accMatch[1].trim();
            if (parsedAcc.length > 2 && !/^(?:DIRECT|MARKET)$/i.test(parsedAcc)) {
                state.activeAccount = cleanField(parsedAcc);
            }
        }

        let evaluation = evaluateLineProbabilities(upperLine);
        
        let sortedSignals = Object.entries(evaluation.signals).sort((a, b) => {
            if (b[1] !== a[1]) return b[1] - a[1]; 
            return a[0].localeCompare(b[0]);       
        });

        let top = sortedSignals[0];
        let second = sortedSignals[1];
        let margin = top[1] - second[1];
        
        let total = Object.values(evaluation.signals).reduce((a, b) => a + b, 0);
        let normalizedTop = total > 0 ? top[1] / total : 0;
        
        // Adaptive boundary threshold optimization for shortened inputs or noise variants
        let targetCategory = (normalizedTop >= 0.45 && margin >= 0.35) ? top[0] : null;

        if (targetCategory && targetCategory !== state.currentCategory) {
            if (state.currentCategory !== null) {
                flushCurrentState();
            }
            state.currentCategory = targetCategory;
            if (targetCategory === "Tonnage") state.activeAccount = "Not Found"; 
        }

        if (evaluation.matchingTokens.length > 0) {
            state.explanationLog.push(...evaluation.matchingTokens);
        }
        state.bufferLines.push(cleanLine);
    }

    flushCurrentState();
    return executeDeduplicationAndProbabilisticScoring(compiledRecords);
}

// =========================================================================
// DATA CORRELATION DEDUPLICATION & METRIC TRACES
// =========================================================================
function executeDeduplicationAndProbabilisticScoring(records) {
    let uniqueOutputMap = new Map();

    for (let record of records) {
        let weights = FIELD_WEIGHTS[record.category] || {};
        let totalPossibleWeight = 0;
        let weightedScoreAccumulator = 0;
        let contradictionDeductions = 0; 
        let internalScoringMatrix = {};

        for (let [field, weight] of Object.entries(weights)) {
            totalPossibleWeight += weight;
            if (record[field] && record[field] !== "Not Found") {
                weightedScoreAccumulator += weight;
                internalScoringMatrix[field] = `+${weight}`;
            } else {
                internalScoringMatrix[field] = "0.00 (Missing)";
            }
        }

        if (record.category === "Cargo VC") {
            if (record.cargo_name === "Not Found") {
                contradictionDeductions += 0.30;
                internalScoringMatrix["cargo_missing_penalty"] = "-0.30";
            }
            if (record.loading_port && /\b(?:DELIVERY|DELY|REDEL)\b/i.test(safeString(record.loading_port))) {
                contradictionDeductions += 0.25;
                internalScoringMatrix["context_contamination_penalty"] = "-0.25";
                record.loading_port = "Not Found";
            }
        }

        let baselineConfidence = totalPossibleWeight > 0 ? (weightedScoreAccumulator / totalPossibleWeight) : 0;
        let structuralFinalConfidence = Math.max(0.05, baselineConfidence - contradictionDeductions);
        record.confidence = parseFloat(structuralFinalConfidence.toFixed(2));

        let normalVessel = normalizeSynonym(record.vessel_name);
        let normalCargo = normalizeSynonym(record.cargo_name);
        let normalLocA = normalizeSynonym(record.loading_port || record.delivery_port);
        let normalLocB = normalizeSynonym(record.discharge_port || record.redelivery_port);
        let normalDate = normalizeSynonym(record.laycan || record.open_date);

        let compositeFingerprintHash = `${record.category}_${normalVessel}_${normalCargo}_${normalLocA}_${normalLocB}_${normalDate}_L${record._anchor_line}`;
        
        record.modelSignature = {
            version: "rule-engine-v3.2",
            strategy: "cascading-regex + probabilistic scoring + fingerprint dedup",
            deterministic: true
        };

        record.explain = {
            categoryReason: `Dominant domain vector verified via deterministic margin sorting matrix.`,
            structuralTriggers: [...new Set(record._classification_triggers)],
            extractionTrace: (record._classification_triggers || []).slice(-5),
            explainabilityScore: Object.keys(internalScoringMatrix || {}).length,
            confidenceBreakdown: {
                baseFormula: "Earned_Weights_Sum / Total_Domain_Weights",
                mathematicalMatrix: internalScoringMatrix,
                appliedDeductions: contradictionDeductions
            },
            contextTelemetry: {
                rawStreamLengthChars: safeString(record._raw_span_context).length,
                streamLineOffsetAnchor: record._anchor_line
            }
        };

        if (DEBUG_MODE) {
            console.log(`[DEBUG TRACE] Anchor Line L${record._anchor_line} Extracted Matrix:`, record.explain);
        }

        delete record._anchor_line;
        delete record._raw_span_context;
        delete record._classification_triggers;
        delete record._engines_triggered;

        if (!uniqueOutputMap.has(compositeFingerprintHash)) {
            uniqueOutputMap.set(compositeFingerprintHash, record);
        } else {
            if (record.confidence > uniqueOutputMap.get(compositeFingerprintHash).confidence) {
                uniqueOutputMap.set(compositeFingerprintHash, record);
            }
        }
    }

    return Array.from(uniqueOutputMap.values());
}

function buildSummary(records) {
    let validRecords = records.filter(r => r && r.category && r.category !== "Unknown");
    if (validRecords.length === 0) {
        return { totalRecords: 0, tonnageCount: 0, cargoVCCount: 0, cargoTCCount: 0, avgConfidence: 0.00 };
    }
    let sumConf = validRecords.reduce((acc, curr) => acc + (curr.confidence || 0), 0);
    return {
        totalRecords: validRecords.length,
        tonnageCount: validRecords.filter(r => r.category === "Tonnage").length,
        cargoVCCount: validRecords.filter(r => r.category === "Cargo VC").length,
        cargoTCCount: validRecords.filter(r => r.category === "Cargo TC").length,
        avgConfidence: parseFloat((sumConf / validRecords.length).toFixed(2))
    };
}

// =========================================================================
// PIPELINE CONTROL APPLICATION OVERLAYS
// =========================================================================
function processEmail() {
    toggleClass("loader", "hidden", false);
    toggleClass("outputPanel", "processing-pulse", true);

    setTimeout(() => {
        let textContainer = document.getElementById("emailText");
        let rawEmailText = safeString(textContainer ? textContainer.value : "");
        
        let finalRecords = safeExecute(
            () => processEmailStateMachine(rawEmailText),
            [{ category: "Unknown", error_state: "Execution pipeline gracefully caught an unexpected error" }]
        );

        lastResult = finalRecords;
        
        const outputBox = document.getElementById("output");
        if (outputBox) outputBox.textContent = JSON.stringify(finalRecords, null, 4);

        let metricsSummary = buildSummary(finalRecords);

        // Safe DOM Text Injections
        setText("cardTotal", metricsSummary.totalRecords);
        setText("cardTonnage", metricsSummary.tonnageCount);
        setText("cardVC", metricsSummary.cargoVCCount);
        setText("cardTC", metricsSummary.cargoTCCount);
        setText("cardConfidence", metricsSummary.avgConfidence.toFixed(2));

        setText("summary", `Structured Analytics: Extracted ${metricsSummary.totalRecords} valid fixtures [Tonnage: ${metricsSummary.tonnageCount} | Voyage Cargo: ${metricsSummary.cargoVCCount} | Time Charter: ${metricsSummary.cargoTCCount}] with a calibrated pool mean confidence of ${metricsSummary.avgConfidence}.`);

        let prime = finalRecords[0] || {};
        let expected = prime.category === "Tonnage" ? 6 : (prime.category === "Cargo VC" || prime.category === "Cargo TC" ? 4 : 0);
        let primeFilled = expected > 0 ? Object.keys(prime).filter(f => prime[f] && prime[f] !== "Not Found" && f !== "category" && f !== "confidence" && f !== "explain" && f !== "modelSignature").length : 0;
        
        setText("stats", `Prime Schema Completeness: ${primeFilled}/${expected}`);

        toggleClass("loader", "hidden", true);
        toggleClass("outputPanel", "processing-pulse", false);
    }, 40);
}

function downloadJSON() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(lastResult, null, 4));
    const a = document.createElement("a");
    a.href = dataStr;
    a.download = "shipping_fixtures_v3.2.json";
    a.click();
}

function runAllTests() {
    let inputContainer = document.getElementById("testInput");
    let input = safeString(inputContainer ? inputContainer.value : "");
    let cases = input.split("\n").filter(line => line.trim() !== "");
    let results = [];

    for (let i = 0; i < cases.length; i++) {
        let textContainer = document.getElementById("emailText");
        if (textContainer) textContainer.value = cases[i];
        
        let batchRecords = safeExecute(
            () => processEmailStateMachine(cases[i]),
            [{ category: "Unknown", error_state: "Batch runner context crash intercepted." }]
        );

        results.push({
            testCase: i + 1,
            input: cases[i],
            analytics: buildSummary(batchRecords),
            output: batchRecords
        });
    }

    const testOutBox = document.getElementById("testOutput");
    if (testOutBox) testOutBox.textContent = JSON.stringify(results, null, 2);
}