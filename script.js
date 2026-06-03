let lastResult = []; 
let debugReport = [];

// ---------------- SAFE CLEANING ----------------
function normalizeText(text) {
    return (text || "")
        .replace(/[@#*]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function cleanField(text) {
    return (text || "")
        .replace(/BULK CARRIER|AVAILABLE|URGENT|FOR PROMPT FIXING|MV|M\.V\./gi, "")
        .replace(/O\/A|OPEN/gi, "")
        .replace(/\s+/g, " ")
        .trim();
}

// ---------------- CONFIDENCE ENGINE ----------------
function scoreResult(result, expectedFields) {
    let filled = 0;
    let issues = [];

    for (let f of expectedFields) {
        if (!result[f] || result[f] === "Not Found") {
            issues.push(f);
        } else {
            filled++;
        }
    }

    return {
        score: expectedFields.length > 0 ? filled / expectedFields.length : 0,
        missing: issues
    };
}

// ---------------- FALLBACK REPAIR ----------------
function fallbackRepair(text, result) {
    let upper = text.toUpperCase();

    if (!result.vessel_name) {
        let v = text.match(/\b(?:MV|M\.V\.)\s+([A-Za-z][A-Za-z0-9\-\/ ]+?)(?=\s+\d)/i);
        if (v) result.vessel_name = cleanField(v[1]);
    }

    if (!result.vessel_size) {
        let s = text.match(/([\d,]{4,10})\s*DWT/i);
        if (s) result.vessel_size = s[1].replace(/,/g, "").trim();
    }

    if (!result.open_port) {
        let p = upper.match(/OPEN\s+([A-Z0-9,\-\/\s]{3,})/);
        if (p) result.open_port = cleanField(p[1]);
    }

    if (!result.open_date) {
        let d = upper.match(/(?:\d{1,2}(?:ST|ND|RD|TH)?[\s\-\/]\d{1,2}\s+[A-Z]+|\d{1,2}\s+[A-Z]+|MID\s+[A-Z]+|PROMPT|SPOT)/i);
        if (d) result.open_date = d[0];
    }

    return result;
}

function classifyRecordBlock(upperText) {
    let scores = { "Tonnage": 0, "Cargo VC": 0, "Cargo TC": 0 };

    if (/\d+[\d,]*\s*DWT|\b(?:SUPRAMAX|PANAMAX|KAMSARMAX|CAPE|HANDYSIZE|ULTRAMAX|AFRAMAX|VLCC)\b/i.test(upperText)) scores["Tonnage"] += 3;
    if (/\bOPEN\s+[A-Z]{3,}/i.test(upperText)) scores["Tonnage"] += 2;
    
    if (/LOAD\s*PORT|POL|DISCHARGE\s*PORT|POD/i.test(upperText)) scores["Cargo VC"] += 4;
    if (/\bVOYAGE\b/i.test(upperText)) scores["Cargo VC"] += 2;
    if (/\b(?:MTS?|MT|KT|K)\b(?:\s+[A-Z0-9,\-\/]+){0,10}\s+(?:COAL|CEMENT|GRAIN|ORE|STEEL|WHEAT|PETCOKE|FERTILIZER|CLINKER|SALT|SUGAR|BAUXITE|AGGREGATES|WOODCHIPS|COKE)/i.test(upperText)) scores["Cargo VC"] += 3;

    if (/DELIVERY|DELY/i.test(upperText)) scores["Cargo TC"] += 3;
    if (/REDELIVERY|REDEL/i.test(upperText)) scores["Cargo TC"] += 4;
    if (/TIME\s*CHARTER|\bT\/C\b/i.test(upperText)) scores["Cargo TC"] += 3;

    let sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    if (sorted[0][1] === 0) return "Unknown";
    return sorted[0][0];
}

// ---------------- MAIN PROCESS ----------------
function processEmail() {
    const loader = document.getElementById("loader");
    const output = document.getElementById("output");
    const summaryBox = document.getElementById("summary");
    const statsBox = document.getElementById("stats");

    if (loader) loader.classList.remove("hidden");

    let rawEmailText = document.getElementById("emailText").value || "";
    
    let rawChunks = rawEmailText.split(/(?=\b(?:MV|M\.V\.)\b|\b(?:MTS?|MT|KT|K)\b(?:\s+[A-Za-z0-9,\-\/]+){0,10}\s+(?:COAL|CEMENT|GRAIN|ORE|STEEL|WHEAT|PETCOKE|FERTILIZER|CLINKER|SALT|SUGAR|BAUXITE|AGGREGATES|WOODCHIPS|COKE)\b|\b(?:DELIVERY|DELY)\b|\b(?:ACCOUNT|ACCT|A\/C|ACC|OWNERS|OWNER|FOR|CHRTRS)\b)/i);
    
    let finalRecords = [];
    let activeAccountContext = "Not Found"; 

    // COMPREHENSIVE MULTI-RECORD EVALUATION LOOP
    for (let chunk of rawChunks) {
        let chunkText = normalizeText(chunk);
        if (!chunkText) continue;
        
        let chunkUpper = chunkText.toUpperCase();

        let accMatch = chunk.match(/(?:\bACCOUNT\b|\bACCT\b|\bA\/C\b|\bACC\b|\bOWNERS\b|\bOWNER\b|\bFOR\b|\bCHRTRS\b)\s*:?\s*([A-Za-z0-9,\- ]+?)(?=\s*[\r\n]|\sOPEN|\sDWT|\sO\/A|\sLAYCAN|\sLC|\sDELIVERY|\sDELY|\sREDELIVERY|\sREDEL|\sPOL|\sPOD|\sDISCHARGE|\sBULK|\sTANKER|$)/i);
        if (accMatch) {
            let parsedAcc = accMatch[1].trim();
            if (parsedAcc.length > 2 && !/^(?:DIRECT|MARKET)$/i.test(parsedAcc)) { 
                activeAccountContext = parsedAcc;
            }
        }

        let category = classifyRecordBlock(chunkUpper);
        if (category === "Unknown") continue; 

        let result = { category: category };
        let expectedFields = [];

        // ---------------- TONNAGE PARSING ----------------
        if (category === "Tonnage") {
            expectedFields = ["vessel_name", "vessel_size", "open_port", "open_date", "account_name", "vessel_type"];

            let vesselMatch = chunkText.match(/(?:MV|M\.V\.)\s+([A-Za-z][A-Za-z0-9\-\/ ]+?)\s+[\d,]{4,10}\s*DWT/i) || 
                              chunkText.match(/(?:MV|M\.V\.|VESSEL)?\s*([A-Za-z][A-Za-z0-9\-\/ ]+?)\s+DWT/i);
            if (vesselMatch) result.vessel_name = cleanField(vesselMatch[1]);

            let sizeMatch = chunkText.match(/([\d,]{4,10})\s*DWT/i);
            if (sizeMatch) result.vessel_size = sizeMatch[1].replace(/,/g, "");

            let portMatch = chunkUpper.match(/OPEN\s+([A-Z0-9,\-\/\s]{3,}?)(?=\sPROMPT|\sSPOT|\sMID|\sEARLY|\sLYCN|\sLAYCAN|\sO\/A|\sETA|\sACC|\bACCOUNT\b|\bACCT\b|\s\d|$)/);
            if (portMatch) result.open_port = cleanField(portMatch[1]);

            let dateMatch = chunkUpper.match(/(?:O\/A|ETA)\s*([A-Z0-9\-\/\s]{3,20}?)(?=\sACC|\bACCOUNT\b|\bACCT\b|\bBULK\b|\bTANKER\b|$)/) ||
                            chunkUpper.match(/\b(?:\d{1,2}(?:ST|ND|RD|TH)?[\s\-\/]\d{1,2}\s+[A-Z]+|\d{1,2}\s+[A-Z]+|MID\s+[A-Z]+|PROMPT|SPOT)\b/);
            if (dateMatch) result.open_date = cleanField(dateMatch[1] || dateMatch[0]);

            result.account_name = activeAccountContext;

            const vesselTypes = [
                "BULK CARRIER", "TANKER", "CONTAINER", "GENERAL CARGO", "MPP", "TWEEN DECKER",
                "HANDYSIZE", "SUPRAMAX", "ULTRAMAX", "PANAMAX", "KAMSARMAX", "CAPE", "CAPESIZE",
                "MR", "LR1", "LR2", "VLCC", "AFRAMAX"
            ];
            let normalizedUpper = chunkUpper.replace(/\s+/g, ' ');
            result.vessel_type = vesselTypes.find(v => normalizedUpper.includes(v)) || "Not Found";

            if (!result.vessel_name) {
                let fb = chunkText.match(/\b([A-Za-z][A-Za-z0-9\-\/]{2,}(?:\s+[A-Za-z0-9\-\/]{2,}){1,3})\b/);
                if (fb) result.vessel_name = cleanField(fb[1]);
            }
        }

        // ---------------- VOYAGE CHARTER PARSING ----------------
        else if (category === "Cargo VC") {
            expectedFields = ["cargo_name", "loading_port", "discharge_port", "laycan"];

            let cargoMatch = chunkText.match(/(?:\d+[\d,]*\s*(?:MT|MTS|MTON|KT|K)\s+)?\b([A-Z][A-Z\s\-\/]{2,30}?)(?=\s+(LOAD|POL|DISCHARGE|LAYCAN))/i) ||
                             chunkText.match(/(?:MTS?|MT|KT|K)\s+([A-Za-z0-9,\-\/\s]+?)(?=\sLOAD PORT|\sPOL|\sDISCHARGE|\sLAYCAN|$)/i);
            
            if (cargoMatch) {
                result.cargo_name = cargoMatch[1].trim();
            } else {
                const globalCommodities = ["COAL", "ORE", "WHEAT", "STEEL", "PETCOKE", "FERTILIZER", "CLINKER", "SALT", "SUGAR", "BAUXITE", "AGGREGATES", "WOODCHIPS", "PET COKE", "IRON ORE FINES"];
                result.cargo_name = globalCommodities.find(c => chunkUpper.includes(c)) || "Not Found";
            }

            let load = chunkText.match(/LOAD PORT\s*:?\s*([A-Za-z0-9,\-\/\s]+?)(?=\sDISCHARGE|\sLAYCAN|$)/i) || 
                       chunkText.match(/POL\s*:?\s*([A-Za-z0-9,\-\/\s]+?)(?=\sDISCHARGE|\sLAYCAN|$)/i);
            if (load) result.loading_port = load[1].trim();

            let discharge = chunkText.match(/DISCHARGE PORT\s*:?\s*([A-Za-z0-9,\-\/\s]+?)(?=\sLAYCAN|$)/i) || 
                            chunkText.match(/POD\s*:?\s*([A-Za-z0-9,\-\/\s]+?)(?=\sLAYCAN|$)/i);
            if (discharge) result.discharge_port = discharge[1].trim();

            let laycan = chunkText.match(/LAYCAN\s*:?\s*([A-Z0-9\-\/\s]{3,20}?)(?=\s+(ACC|ACCOUNT|FREIGHT|CHOPT|T\/C|TIME|$))/i) ||
                         chunkText.match(/\b\d{1,2}(?:[\s\-\/\d]+?)[A-Z]{3,}\b/i);
            if (laycan) result.laycan = (laycan[1] || laycan[0]).trim();
        }

        // ---------------- TIME CHARTER PARSING ----------------
        else if (category === "Cargo TC") {
            expectedFields = ["delivery_port", "redelivery_port", "laycan", "account_name"];

            result.account_name = activeAccountContext;

            let delivery = chunkText.match(/DELIVERY\s*:?\s*([A-Za-z0-9,\-\/\s]+?)(?=\sREDELIVERY|\sREDEL|\sLAYCAN|\sLC|\sACC|\bACCOUNT\b|$)/i) || 
                           chunkText.match(/DELY\s*:?\s*([A-Za-z0-9,\-\/\s]+?)(?=\sREDELIVERY|\sREDEL|\sLAYCAN|\sLC|\sACC|\bACCOUNT\b|$)/i);
            if (delivery) result.delivery_port = delivery[1].trim();

            let redelivery = chunkText.match(/REDELIVERY\s*:?\s*([A-Za-z0-9,\-\/\s]+?)(?=\sLAYCAN|\sLC|\sACC|\bACCOUNT\b|$)/i) || 
                             chunkText.match(/REDEL\s*:?\s*([A-Za-z0-9,\-\/\s]+?)(?=\sLAYCAN|\sLC|\sACC|\bACCOUNT\b|$)/i);
            if (redelivery) result.redelivery_port = redelivery[1].trim();

            let laycan = chunkText.match(/LAYCAN\s*:?\s*([A-Z0-9\-\/\s]{3,20}?)(?=\s+(ACC|ACCOUNT|FREIGHT|CHOPT|T\/C|TIME|$))/i) || 
                         chunkText.match(/LC\s*:?\s*([A-Za-z0-9,\-\/\s]+?)(?=\sACC|\bACCOUNT\b|\sRATE|\sDURATION|$)/i);
            if (laycan) result.laycan = laycan[1].trim();
        }

        if (expectedFields.length > 0) {
            let scoreObj = scoreResult(result, expectedFields);
            let loopConfidence = scoreObj.score;

            if (loopConfidence < 0.65 && category === "Tonnage") {
                result = fallbackRepair(chunkText, result);
                loopConfidence = scoreResult(result, expectedFields).score;
            }
            result.confidence = parseFloat(loopConfidence.toFixed(2));
        }

        finalRecords.push(result);
    }

    if (finalRecords.length === 0) {
        finalRecords.push({ category: "Unknown" });
    }

    // ---------------- OUTPUT RENDERING ----------------
    lastResult = finalRecords;
    if (output) output.textContent = JSON.stringify(finalRecords, null, 4);

    let summaryText = `Extracted ${finalRecords.length} records successfully. `;
    summaryText += finalRecords.map((r, i) => {
        if (r.category === "Tonnage") return `[#${i+1}: Tonnage - ${r.vessel_name || "Unknown"}]`;
        if (r.category === "Cargo VC") return `[#${i+1}: Voyage Cargo - ${r.cargo_name || "Unknown"}]`;
        if (r.category === "Cargo TC") return `[#${i+1}: Time Charter Delivery - ${r.delivery_port || "Unknown"}]`;
        return `[#${i+1}: Unrecognized Layout]`;
    }).join(" ");
    if (summaryBox) summaryBox.textContent = summaryText;

    let prime = finalRecords[0];
    let expected = prime.category === "Tonnage" ? 6 : (prime.category === "Cargo VC" || prime.category === "Cargo TC" ? 4 : 0);
    let primeFilled = expected > 0 ? Object.keys(prime).filter(f => prime[f] && prime[f] !== "Not Found" && f !== "category" && f !== "confidence").length : 0;
    if (statsBox) statsBox.textContent = `Global Records: ${finalRecords.length} | Prime Schema Completeness: ${primeFilled}/${expected} | Score: ${(prime.confidence || 0).toFixed(2)}`;

    setTimeout(() => {
        if (loader) loader.classList.add("hidden");
    }, 300);
}

// ---------------- DOWNLOAD ----------------
function downloadJSON() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(lastResult, null, 4));
    const a = document.createElement("a");
    a.href = dataStr;
    a.download = "shipping_fixtures.json";
    a.click();
}

// ---------------- FIXED BATCH TESTING ENGINE ----------------
function runAllTests() {
    let input = document.getElementById("testInput").value;
    let cases = input.split("\n").filter(line => line.trim() !== "");
    let results = [];

    for (let i = 0; i < cases.length; i++) {
        // 1. Inject sample data into the source text field
        document.getElementById("emailText").value = cases[i];

        // 2. Execute synchronous structural extraction
        processEmail();

        // 3. FIXED ISSUE 1: Force an absolute deep-copy to shield output arrays from race-condition overwrites
        results.push({
            testCase: i + 1,
            input: cases[i],
            output: JSON.parse(JSON.stringify(lastResult))
        });
    }

    // 4. Print clean isolated array segments straight to UI
    document.getElementById("testOutput").textContent = JSON.stringify(results, null, 2);
}