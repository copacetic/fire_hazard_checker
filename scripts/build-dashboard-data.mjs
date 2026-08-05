// Bakes the official California School Dashboard ratings into
// dashboard-ratings.json so the site can render every school's state rating
// inline with zero keys and zero third-party calls at view time.
//
// Sources (all public CDE files, no auth):
//  - School directory (CDS ⇄ NCES id mapping):
//      https://www.cde.ca.gov/schooldirectory/report?rid=dl1&tp=txt
//  - Dashboard research files, one per state indicator:
//      https://www3.cde.ca.gov/researchfiles/cadashboard/{name}download{year}.txt
//    Columns include: cds, rtype (S=school), studentgroup, color
//    (1=Red 2=Orange 3=Yellow 4=Green 5=Blue), reportingyear.
//
// Run: node scripts/build-dashboard-data.mjs   (Node 18+, no dependencies)
// Output: dashboard-ratings.json in the repo root.

import { writeFileSync } from "node:fs";

const YEARS = ["2025", "2024"]; // newest first; falls back per indicator
const INDICATORS = [
  ["ela", "ela"], ["math", "math"], ["chr", "chronic"],
  ["su", "susp"], ["gr", "grad"], ["cc", "cci"], ["el", "elpi"]
];
const DIRECTORY_URL = "https://www.cde.ca.gov/schooldirectory/report?rid=dl1&tp=txt";

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

function parseTable(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length);
  const header = lines[0].split("\t").map(h => h.trim().toLowerCase());
  return { header, rows: lines.slice(1).map(l => l.split("\t")) };
}

// --- NCES id -> CDS code map from the school directory ---
console.error("fetching school directory…");
const dir = parseTable(await fetchText(DIRECTORY_URL));
const dCds = dir.header.indexOf("cdscode");
const dNd = dir.header.indexOf("ncesdist");
const dNs = dir.header.indexOf("ncesschool");
const dStatus = dir.header.indexOf("statustype");
if (dCds < 0 || dNd < 0 || dNs < 0) throw new Error("directory columns changed: " + dir.header.join(","));
const n = {};
for (const row of dir.rows) {
  if (dStatus >= 0 && row[dStatus] !== "Active") continue;
  const nd = (row[dNd] || "").trim(), ns = (row[dNs] || "").trim(), cds = (row[dCds] || "").trim();
  if (!nd || !ns || cds.length !== 14) continue;
  n[nd.padStart(7, "0") + ns.padStart(5, "0")] = cds;
}
console.error(`directory: ${Object.keys(n).length} active schools mapped`);

// --- ratings per indicator ---
const r = {};
const yr = {};
for (const [key, name] of INDICATORS) {
  let text = null, used = null;
  for (const y of YEARS) {
    try {
      text = await fetchText(`https://www3.cde.ca.gov/researchfiles/cadashboard/${name}download${y}.txt`);
      used = y;
      break;
    } catch (e) { /* try older year */ }
  }
  if (!text) { console.error(`WARNING: no file for ${name} in ${YEARS.join("/")} — skipped`); continue; }
  const { header, rows } = parseTable(text);
  const iCds = header.indexOf("cds");
  const iRtype = header.indexOf("rtype");
  const iGroup = header.indexOf("studentgroup");
  const iColor = header.indexOf("color");
  if (iCds < 0 || iRtype < 0 || iGroup < 0 || iColor < 0) throw new Error(`${name}${used} columns changed: ` + header.join(","));
  let kept = 0;
  for (const row of rows) {
    if (row[iRtype] !== "S" || row[iGroup] !== "ALL") continue;
    const color = parseInt(row[iColor], 10);
    if (!(color >= 1 && color <= 5)) continue; // 0/blank = no performance level
    const cds = (row[iCds] || "").trim();
    if (cds.length !== 14) continue;
    (r[cds] || (r[cds] = {}))[key] = color;
    kept++;
  }
  yr[key] = used;
  console.error(`${name}${used}: ${kept} school ratings`);
}

const out = {
  generated: new Date().toISOString().slice(0, 10),
  source: "CA School Dashboard research files (CDE) + CDE school directory",
  colors: "1=Red 2=Orange 3=Yellow 4=Green 5=Blue",
  years: yr,
  n, r
};
writeFileSync(new URL("../dashboard-ratings.json", import.meta.url), JSON.stringify(out));
console.error(`wrote dashboard-ratings.json: ${Object.keys(r).length} rated schools, ${Object.keys(n).length} id mappings`);
