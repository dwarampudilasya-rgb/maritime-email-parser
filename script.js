let lastResult = {};
let debugReport = {};

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
        let v = text.match(/\b(?:MV|M\.V\.)\s+([A-Z\s]{3,30})/i);
        if (v) {
            result.vessel_name = cleanField(v[1]);
        }
    }

    if (!result.vessel_size) {
        let s = text.match(/\d{4,6}\s*DWT/i);
        if (s) result.vessel_size = s[0].replace("DWT", "").trim();
    }

    if (!result.open_port) {
        let p = upper.match(/OPEN\s+([A-Z\s]{3,})/);
        if (p) result.open_port = cleanField(p[1]);
    }

    if (!result.open_date) {
        let d = upper.match(/\d{1,2}(ST|ND|RD|TH)?\s+[A-Z]+\s+\d{4}/);
        if (d) result.open_date = d[0];
    }

    return result;
}

function classifyEmail(upperText) {
    let scores = {
        Tonnage: 0,
        "Cargo VC": 0,
        "Cargo TC": 0
    };

    if (upperText.includes("DWT")) scores.Tonnage += 3;
    if (upperText.includes("OPEN")) scores.Tonnage += 2;
    if (upperText.includes("O/A")) scores.Tonnage += 2;

    if (upperText.includes("LOAD PORT") || upperText.includes("POL")) scores["Cargo VC"] += 3;
    if (upperText.includes("DISCHARGE PORT") || upperText.includes("POD")) scores["Cargo VC"] += 3;
    if (upperText.includes("VOYAGE")) scores["Cargo VC"] += 2;

    if (upperText.includes("DELIVERY") || upperText.includes("DELY")) scores["Cargo TC"] += 3;
    if (upperText.includes("REDELIVERY") || upperText.includes("REDEL")) scores["Cargo TC"] += 4;
    if (upperText.includes("TIME CHARTER") || upperText.includes("T/C")) scores["Cargo TC"] += 3;

    return Object.entries(scores)
        .sort((a, b) => b[1] - a[1])[0][0];
}

// ---------------- MAIN PROCESS ----------------
function processEmail() {
    const loader = document.getElementById("loader");
    const output = document.getElementById("output");
    const summaryBox = document.getElementById("summary");
    const statsBox = document.getElementById("stats");

    loader.classList.remove("hidden");

    let emailText = document.getElementById("emailText").value || "";
    emailText = normalizeText(emailText);
    let upperText = emailText.toUpperCase();
    let category = classifyEmail(upperText);

    let result = {};
    let expectedFields = [];

    // Account Name tracking: case-insensitive and safe against flattened whitespace string layouts
    let accMatch = emailText.match(/ACC\s+([A-Za-z\s]+?)(?=\sOPEN|\sDWT|\sO\/A|\sLAYCAN|\sDELIVERY|\sREDELIVERY|\sPOL|\sPOD|\sDISCHARGE|$)/i);
    let parsedAccountName = accMatch ? accMatch[1].trim() : "Not Found";

    // ---------------- TONNAGE ----------------
    if (category === "Tonnage") {
        result.category = "Tonnage";
        expectedFields = ["vessel_name", "vessel_size", "open_port", "open_date", "account_name", "vessel_type"];

        let vesselMatch = emailText.match(/(?:MV|M\.V\.|VESSEL)?\s*([A-Za-z][A-Za-z\s]{2,}?)\s+DWT/i);
        if (vesselMatch) result.vessel_name = cleanField(vesselMatch[1]);

        let sizeMatch = emailText.match(/(\d{4,6})\s*DWT/i);
        if (sizeMatch) result.vessel_size = sizeMatch[1];

        let portMatch = upperText.match(/OPEN\s+([A-Z\s]{3,}?)(?=\sO\/A|\sETA|\sACC|\s\d|$)/);
        if (portMatch) result.open_port = cleanField(portMatch[1]);

        let dateMatch = upperText.match(/O\/A\s*([A-Z0-9\s]+?)(?=\sACC|\sBULK|\sTANKER|$)/);
        if (dateMatch) result.open_date = cleanField(dateMatch[1]);

        result.account_name = parsedAccountName;

        const vesselTypes = [
            "BULK CARRIER", "TANKER", "CONTAINER", "GENERAL CARGO", "MPP", "TWEEN DECKER"
        ];
        result.vessel_type = vesselTypes.find(v => upperText.includes(v)) || "Not Found";

        if (!result.vessel_name) {
            let fb = emailText.match(/\b([A-Za-z]{3,}(?:\s+[A-Za-z]{2,}){1,3})\b/);
            if (fb) result.vessel_name = cleanField(fb[1]);
        }
    }

    // ---------------- VC ----------------
    else if (category === "Cargo VC") {
        result.category = "Cargo VC";
        expectedFields = ["cargo_name", "loading_port", "discharge_port", "laycan"];

        // Handles numeric prefix jumps safely (e.g., "MTS 45000 WHEAT" or "45000 MTS WHEAT")
        let cargoMatch = emailText.match(/MTS\s+(?:\d+\s+)?([A-Za-z\s]+?)(?=\sLOAD PORT|\sPOL|\sDISCHARGE|\sLAYCAN|$)/i) || 
                         emailText.match(/(?:\d+\s+)?MTS\s+([A-Za-z\s]+?)(?=\sLOAD PORT|\sPOL|\sDISCHARGE|\sLAYCAN|$)/i);
        result.cargo_name = cargoMatch ? cargoMatch[1].trim() : "Not Found";

        let load = emailText.match(/LOAD PORT\s*:?\s*([A-Za-z\s]+?)(?=\sDISCHARGE|\sLAYCAN|$)/i) || 
                   emailText.match(/POL\s*:?\s*([A-Za-z\s]+?)(?=\sDISCHARGE|\sLAYCAN|$)/i);
        if (load) result.loading_port = load[1].trim();

        let discharge = emailText.match(/DISCHARGE PORT\s*:?\s*([A-Za-z\s]+?)(?=\sLAYCAN|$)/i) || 
                        emailText.match(/POD\s*:?\s*([A-Za-z\s]+?)(?=\sLAYCAN|$)/i);
        if (discharge) result.discharge_port = discharge[1].trim();

        let laycan = emailText.match(/LAYCAN\s*:?\s*([A-Za-z0-9\-\s]+?)(?=\sACC|$)/i);
        if (laycan) result.laycan = laycan[1].trim();
    }

    // ---------------- TC ----------------
    else if (category === "Cargo TC") {
        result.category = "Cargo TC";
        expectedFields = ["delivery_port", "redelivery_port", "laycan", "account_name"];

        result.account_name = parsedAccountName;

        let delivery = emailText.match(/DELIVERY\s*:?\s*([A-Za-z\s]+?)(?=\sREDELIVERY|\sLAYCAN|\sACC|$)/i) || 
                       emailText.match(/DELY\s*:?\s*([A-Za-z\s]+?)(?=\sREDELIVERY|\sLAYCAN|\sACC|$)/i);
        if (delivery) result.delivery_port = delivery[1].trim();

        let redelivery = emailText.match(/REDELIVERY\s*:?\s*([A-Za-z\s]+?)(?=\sLAYCAN|\sACC|$)/i) || 
                         emailText.match(/REDEL\s*:?\s*([A-Za-z\s]+?)(?=\sLAYCAN|\sACC|$)/i);
        if (redelivery) result.redelivery_port = redelivery[1].trim();

        let laycan = emailText.match(/LAYCAN\s*:?\s*([A-Za-z0-9\-\s]+?)(?=\sACC|$)/i) || 
                     emailText.match(/LC\s*:?\s*([A-Za-z0-9\-\s]+?)(?=\sACC|$)/i);
        if (laycan) result.laycan = laycan[1].trim();
    }

    else {
        result.category = "Unknown";
    }

    // ---------------- HYBRID REPAIR ----------------
    let confidence = 1;

    if (expectedFields.length > 0) {
        let score = scoreResult(result, expectedFields);
        confidence = score.score;

        if (confidence < 0.65 && result.category === "Tonnage") {
            result = fallbackRepair(emailText, result);
        }

        debugReport = score;
    }

    lastResult = result;
    output.textContent = JSON.stringify(result, null, 4);

    // ---------------- SUMMARY ----------------
    let summary = "";

    if (result.category === "Tonnage") {
        summary = `Vessel ${result.vessel_name || "Unknown"} (${result.vessel_size || "Unknown"} DWT) will be open at ${result.open_port || "Unknown"} on ${result.open_date || "Unknown"}.`;
    }
    else if (result.category === "Cargo VC") {
        summary = `Cargo ${result.cargo_name || "Unknown"} from ${result.loading_port || "Unknown"} to ${result.discharge_port || "Unknown"} with laycan ${result.laycan || "Unknown"}.`;
    }
    else if (result.category === "Cargo TC") {
        summary = `Time charter delivery at ${result.delivery_port || "Unknown"} and redelivery at ${result.redelivery_port || "Unknown"} during laycan ${result.laycan || "Unknown"}.`;
    }
    else {
        summary = "No shipping-related information detected.";
    }

    summaryBox.textContent = summary;

    // ---------------- STATS ----------------
    let total = expectedFields.length || Object.keys(result).length;
    let filled = expectedFields.filter(f => result[f] && result[f] !== "Not Found").length;

    statsBox.textContent = `Category: ${result.category} | Fields: ${filled}/${total} | Confidence: ${confidence.toFixed(2)}`;

    // ---------------- SAFE LOADER FIX ----------------
    setTimeout(() => {
        loader.classList.add("hidden");
    }, 300);
}

// ---------------- DOWNLOAD ----------------
function downloadJSON() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(lastResult, null, 4));
    const a = document.createElement("a");
    a.href = dataStr;
    a.download = "email_output.json";
    a.click();
}