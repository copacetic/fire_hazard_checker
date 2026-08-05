import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";

const here = path.dirname(fileURLToPath(import.meta.url));
const appUrl = "file://" + path.join(here, "index.html");

// ---- canned responses (verbatim shapes from live API verification) ----
const ESRI_HIT = (addr, lon, lat) => ({ candidates: [{ address: addr, location: { x: lon, y: lat }, score: 100 }] });
const ESRI_MISS = { candidates: [] };
const NOMINATIM_HIT = [{ lat: "34.1830", lon: "-118.2470", display_name: "1210, East Chevy Chase Drive, Glendale, Los Angeles County, California, 91205, United States" }];

const FHSZ_VH = { objectIdFieldName: "OBJECTID", features: [{ attributes: { OBJECTID: 20919, SRA: "LRA", FHSZ: 3, FHSZ_Description: "Very High", FHSZ_6Class: "LRA Very High" } }] };
const LRA25_HIGH = { features: [{ attributes: { OBJECTID: 4691, SRA: "LRA", FHSZ: 2, FHSZ_Description: "High" } }] }; // verbatim Phase 4 @ Tyburn St
const FHSZ_EMPTY = { objectIdFieldName: "OBJECTID", features: [] };
const FHSZ_NEAR = { features: [{ attributes: { FHSZ: 3, FHSZ_6Class: "LRA Very High" } }, { attributes: { FHSZ: 2, FHSZ_6Class: "LRA High" } }] };
const NRI_OK = { features: [{ attributes: { WFIR_RISKS: 97.916592344190363, WFIR_RISKR: "Relatively High", TRACTFIPS: "06037302002" } }] };
const NRI_NORATING = { features: [{ attributes: { WFIR_RISKS: 0, WFIR_RISKR: "No Rating", TRACTFIPS: "06037303102" } }] }; // verbatim shape @ Tyburn tract
const NONWILD = { features: [{ attributes: { OBJECTID: 1, SRA: "LRA", FHSZ: -3, FHSZ_Description: "NonWildland" } }] }; // verbatim Phase 4 @ Altadena flats
const FIRES_OK = { features: [
  { attributes: { FIRE_NAME: "EATON", YEAR_: 2025, GIS_ACRES: 14056.26, ALARM_DATE: 1736294400000 } },
  { attributes: { FIRE_NAME: "EATON", YEAR_: 2025, GIS_ACRES: 14056.26, ALARM_DATE: 1736294400000 } }, // dup on purpose (dedup test)
  { attributes: { FIRE_NAME: "BOBCAT", YEAR_: 2020, GIS_ACRES: 115796.0, ALARM_DATE: 1599436800000 } },
  { attributes: { FIRE_NAME: "LA TUNA", YEAR_: 2017, GIS_ACRES: 7194.0, ALARM_DATE: 1504310400000 } }
]};
const FIRES_EMPTY = { features: [] };

function json(route, body) { return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }); }

async function setupRoutes(page, scenario) {
  await page.route("**/geocode.arcgis.com/**", route => {
    if (scenario === "fallback") return json(route, ESRI_MISS);
    if (scenario === "vh") return json(route, ESRI_HIT("3211 E Chevy Chase Dr, Glendale, California, 91206", -118.2470, 34.1830));
    if (scenario === "lracity") return json(route, ESRI_HIT("2968 Tyburn St, Los Angeles, California, 90039", -118.26164, 34.11268));
    return json(route, ESRI_HIT("613 E Broadway, Glendale, California, 91206", -118.2551, 34.1425));
  });
  await page.route("**/utility.arcgis.com/**", route => {
    const isDistance = route.request().url().includes("distance=");
    if (scenario === "lracity" && !isDistance) return json(route, LRA25_HIGH);
    if (scenario === "nonwild") return json(route, NONWILD); // point AND rings return only NonWildland
    return json(route, FHSZ_EMPTY);
  });
  await page.route("**/nominatim.openstreetmap.org/**", route => json(route, NOMINATIM_HIT));
  await page.route("**/fhsz24_1/FeatureServer/0/query**", route => {
    const url = route.request().url();
    const isDistance = url.includes("distance=");
    if (scenario === "lracity" || scenario === "nonwild") return json(route, FHSZ_EMPTY);
    if (scenario === "vh" || scenario === "fallback") return json(route, FHSZ_VH);
    // downtown: point query empty; 250m ring empty; 1000m ring finds zones
    if (!isDistance) return json(route, FHSZ_EMPTY);
    if (url.includes("distance=250")) return json(route, FHSZ_EMPTY);
    return json(route, FHSZ_NEAR);
  });
  await page.route("**/National_Risk_Index_Census_Tracts/**", route =>
    json(route, scenario === "downtown" ? NRI_NORATING : NRI_OK));
  await page.route("**/California_Historic_Fire_Perimeters/**", route =>
    json(route, scenario === "downtown" ? FIRES_EMPTY : FIRES_OK));
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || "" });
}

const browser = await chromium.launch();

for (const [scenario, addr, colorScheme] of [
  ["vh", "3211 E Chevy Chase Dr, Glendale, CA", "light"],
  ["downtown", "613 E Broadway, Glendale, CA 91206", "dark"],
  ["fallback", "1210 E Chevy Chase Dr, Glendale, CA", "light"],
  ["lracity", "2968 Tyburn St, Los Angeles, CA 90039", "light"],
  ["nonwild", "600 W Palm St, Altadena, CA 91001", "light"]
]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1400 }, colorScheme });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text()); });
  await setupRoutes(page, scenario);
  await page.goto(appUrl);
  await page.fill("#addr", addr);
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  await page.waitForTimeout(900);

  const verdict = await page.textContent("#verdict-card");
  const firesVisible = await page.isVisible("#fires-card");
  const carrierCount = await page.locator(".carrier").count();
  const quoteLinks = await page.locator(".carrier a.go").count();
  const meterWidth = await page.$eval("#meterfill", el => el.style.width);

  if (scenario === "vh") {
    check("VH: verdict says Very High", verdict.includes("Very High Fire Hazard Severity Zone"));
    check("VH: LRA zone tile shown", verdict.includes("LRA Very High") && verdict.includes("Local Responsibility Area"));
    check("VH: NRI tile 98/100", verdict.includes("98") && verdict.includes("Relatively High"));
    check("VH: fires deduped to 3 & table visible", firesVisible && verdict.includes("3") , "");
    const fireRows = await page.locator("table.fires tbody tr").count();
    check("VH: fire table has 3 rows (dedup worked)", fireRows === 3, "rows=" + fireRows);
    check("VH: meter at 96%", meterWidth === "96%", meterWidth);
    check("VH: matched address shown", verdict.includes("3211 E Chevy Chase Dr"));
    await page.screenshot({ path: path.join(here, "shot-veryhigh-light.png"), fullPage: true });
  }
  if (scenario === "downtown") {
    check("DT: verdict says not in zone", verdict.includes("Not in a designated Fire Hazard Severity Zone"));
    check("DT: nearest-zone tile with ~1 km", verdict.includes("Nearest hazard zone") && verdict.includes("~1 km"), verdict.slice(0, 200));
    check("DT: fires card hidden when none", !firesVisible);
    check("DT: meter at 12%", meterWidth === "12%", meterWidth);
    await page.screenshot({ path: path.join(here, "shot-downtown-dark.png"), fullPage: true });
  }
  if (scenario === "fallback") {
    check("FB: Nominatim fallback used (OSM label)", verdict.includes("East Chevy Chase Drive"));
    check("FB: still resolves Very High", verdict.includes("Very High Fire Hazard Severity Zone"));
  }
  if (scenario === "nonwild") {
    check("NW: NonWildland (-3) is NOT treated as a hazard zone", verdict.includes("Not in a designated Fire Hazard Severity Zone"), verdict.slice(0, 200));
    check("NW: NonWildland never displayed as zone", !verdict.includes("NonWildland"));
    check("NW: rings ignore NonWildland (no nearest tile)", !verdict.includes("Nearest hazard zone"));
  }
  if (scenario === "vh") {
    const cfLink = await page.locator('a[href*="mapviewer/index.html?webmap=54200fc"]').getAttribute("href");
    check("LINKS: CAL FIRE map centered at address", cfLink && cfLink.includes("center=-118.247,34.183"), String(cfLink));
    const gLink = await page.locator('a[href*="google.com/maps"]').getAttribute("href");
    check("LINKS: Google Maps pin at point", gLink === "https://www.google.com/maps?q=34.183,-118.247", String(gLink));
    const fLink = await page.locator('a[href*="hazards.fema.gov/nri/report"]').getAttribute("href");
    check("LINKS: FEMA tract report uses TRACTFIPS", fLink && fLink.includes("dataIDs=T06037302002"), String(fLink));
    check("LINKS: copy-address button present", await page.locator("#copyaddr").count() === 1);
  }
  if (scenario === "downtown") {
    check("DT: unrated FEMA tract shows No rating (not 0/100)", verdict.includes("No rating") && !verdict.includes("0/100"));
  }
  if (scenario === "lracity") {
    check("LRA25: phase layer rescues missing LA City zone (High)", verdict.includes("High Fire Hazard Severity Zone") && !verdict.includes("Very High Fire Hazard Severity Zone"), verdict.slice(0, 300));
    check("LRA25: zone tile shows LRA High", verdict.includes("LRA High") && verdict.includes("Local Responsibility Area"));
    check("LRA25: meter at 68%", meterWidth === "68%", meterWidth);
    check("LRA25: Tyburn address shown", verdict.includes("2968 Tyburn St"));
  }
  check(scenario + ": carriers rendered (14)", carrierCount === 14, "count=" + carrierCount);
  check(scenario + ": quote links present (13)", quoteLinks === 13, "links=" + quoteLinks);
  check(scenario + ": no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// error-path test: geocoders reachable but no match
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  await page.route("**/geocode.arcgis.com/**", r => json(r, ESRI_MISS));
  await page.route("**/nominatim.openstreetmap.org/**", r => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto(appUrl);
  await page.fill("#addr", "zzzz nowhere");
  await page.click("#go");
  await page.waitForSelector("#err", { state: "visible", timeout: 10000 });
  const err = await page.textContent("#err");
  check("ERR: friendly geocode error", err.includes("Couldn’t find that address"), err);
  await ctx.close();
}

// blocked-network test: both geocoders die at network level (extension/VPN blocking)
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  await page.route("**/geocode.arcgis.com/**", r => r.abort("failed"));
  await page.route("**/nominatim.openstreetmap.org/**", r => r.abort("failed"));
  await page.goto(appUrl);
  await page.fill("#addr", "2968 Tyburn St, Los Angeles, CA 90039");
  await page.click("#go");
  await page.waitForSelector("#err", { state: "visible", timeout: 15000 });
  const err = await page.textContent("#err");
  check("BLOCKED: explains extension/VPN blocking", err.includes("blocking the data requests"), err);
  await ctx.close();
}

// ===================== Phase 1: Schools tab (stubbed) =====================
// VERBATIM responses captured live Aug 2026 from the NCES EDGE services.
// School_Districts_Current is a single composite layer (0); a unified district
// returns one feature. Public_School_Locations_Current is a point layer queried
// by radius (returnGeometry=true → distance computed client-side). It has NO
// school-level field and NO CA CDS code; NCESSCH/LEAID are the ids.
const NCES_DIST_LAUSD = { features: [{ attributes: { OBJECTID: 3168, STATEFP: "06", ELSDLEA: " ", SCSDLEA: " ", UNSDLEA: "22710", SDADMLEA: " ", GEOID: "0622710", NAME: "Los Angeles Unified School District", LSAD: "00", LOGRADE: "KG", HIGRADE: "12", MTFCC: "G5420", SDTYP: " ", FUNCSTAT: "E", GEO_YEAR: "2025", SCHOOLYEAR: "2024-2025" } }] }; // verbatim @ Tyburn St
const NCES_SCHOOLS_OK = { features: [ // verbatim @ Tyburn St (3 of 9; Alliance is a charter — different LEAID)
  { attributes: { OBJECTID: 11221, NCESSCH: "062271003103", LEAID: "0622710", NAME: "Ivanhoe Elementary", STREET: "2828 Herkimer St.", CITY: "Los Angeles", LAT: 34.108987, LON: -118.26708, SCHOOLYEAR: "2024-2025" }, geometry: { x: -118.26707999976938, y: 34.10898699993568 } },
  { attributes: { OBJECTID: 10993, NCESSCH: "062271002828", LEAID: "0622710", NAME: "Atwater Avenue Elementary", STREET: "3271 Silver Lake Blvd.", CITY: "Los Angeles", LAT: 34.114677, LON: -118.254097, SCHOOLYEAR: "2024-2025" }, geometry: { x: -118.25409700005922, y: 34.114677000300595 } },
  { attributes: { OBJECTID: 6684, NCESSCH: "060169012342", LEAID: "0601690", NAME: "Alliance Leichtman-Levine Family Foundation Env Sci High", STREET: "2930 Fletcher Dr.", CITY: "Los Angeles", LAT: 34.113259, LON: -118.246685, SCHOOLYEAR: "2024-2025" }, geometry: { x: -118.24668499969924, y: 34.11325900056551 } }
]};
const NCES_SCHOOLS_EMPTY = { features: [] };

// ===== Phase 1b: assigned schools (verbatim responses, live-captured Aug 2026) =====
// LAUSD boundary layers (maps.lacity.org LAUSD_Schools MapServer 4/5/6) carry
// only keycodes; names come from keycode tables on services5.arcgis.com.
const LAUSD_BND_ES = { features: [{ attributes: { OBJECTID: 351, TBLMICRO_E: 10638, EKEY_5: 10638, KEY_: 638, TOOLTIP: "", NLA_URL: "" } }] }; // verbatim MapServer/4 @ Tyburn
const LAUSD_BND_MS = { features: [{ attributes: { OBJECTID: 132, TBLMICRO_M: 20522, MKEY_5: 20522, KEY_: 522, TOOLTIP: "", NLA_URL: "" } }] };
const LAUSD_BND_HS = { features: [{ attributes: { OBJECTID: 7, TBLMICRO_H: 30024, HKEY_5: 30024, KEY_: 24, TOOLTIP: "", NLA_URL: "" } }] };
// Keycode tables: DTS row first is the real server order — the app must sort the
// full-range school first. Schemas genuinely differ: ES table has int CDS (null
// for the DTS center) + LEVEL_; MS/HS tables have string CDS + LEVEL.
const LAUSD_KEY_ES = { objectIdFieldName: "FID", features: [
  { attributes: { OBJECTID: 54, SCHOOL_ID: 2297, NAME: "Atwater Ave El DTS", LO_GRD: 0, HI_GRD: 2, CONFIG: "K- 2", LEVEL_: "E", CDS: null, CCC: 1223302, SCH_YR: "2019-20", EKEY_5: 10638, KEY_: 638, FID: 4 } },
  { attributes: { OBJECTID: 30, SCHOOL_ID: 2233, NAME: "Atwater Ave El", LO_GRD: 0, HI_GRD: 6, CONFIG: "K- 6", LEVEL_: "E", CDS: 6015895, CCC: 1223301, SCH_YR: "2019-20", EKEY_5: 10638, KEY_: 638, FID: 130 } }
]};
const LAUSD_KEY_MS = { objectIdFieldName: "FID", features: [
  { attributes: { OBJECTID: 147, SCHOOL_ID: "8189", NAME: "Irving MS MME Mag", LO_GRD: 7, HI_GRD: 8, CONFIG: "6- 8", LEVEL: "M", CDS: "6058077", CCC: "1818901", SCH_YR: "2019-20", MKEY_5: 20522, KEY_: 522, FID: 198 } }
]};
const LAUSD_KEY_HS = { objectIdFieldName: "FID", features: [
  { attributes: { OBJECTID: 156, SCHOOL_ID: "8750", NAME: "Marshall SH", LO_GRD: 9, HI_GRD: 12, CONFIG: "9-12", LEVEL: "H", CDS: "1935568", CCC: "1875001", SCH_YR: "2019-20", HKEY_5: 30024, KEY_: 24, FID: 103 } }
]};
// CA Dashboard ratings fixture — REAL entries extracted from the baked
// dashboard-ratings.json (2025 files). Injected via window.FIRE_CHECKER_DATA
// because file:// pages can't fetch local JSON (production fetches it).
// Note: the Ivanhoe stub's ncessch is deliberately absent from n — its row
// must show no pills (honest gap).
const DASH_FIX = {
  generated: "2026-08-05", colors: "1=Red 2=Orange 3=Yellow 4=Green 5=Blue",
  years: { ela: "2025", math: "2025", chr: "2025", su: "2025", gr: "2025", cc: "2025" },
  n: { "062271002828": "19647336015895", "061524001935": "19645686013726", "061524001946": "19645686057723", "061524001933": "19645681934082" },
  r: {
    "19647331935568": { ela: 3, math: 3, su: 5, gr: 5, cc: 4 },
    "19647336015895": { ela: 5, math: 4, chr: 1, su: 5 },
    "19645686013726": { ela: 2, math: 4, chr: 4, su: 3 },
    "19645686057723": { ela: 3, math: 4, chr: 3, su: 4 },
    "19645681934082": { ela: 3, math: 3, su: 2, gr: 3, cc: 3 }
  }
};
async function injectDash(page) {
  await page.addInitScript(d => { window.FIRE_CHECKER_DATA = d; }, DASH_FIX);
}

async function lausdAssignedRoutes(page) {
  await page.route("**/maps.lacity.org/**", r => {
    const u = r.request().url();
    if (u.includes("/MapServer/4/")) return json(r, LAUSD_BND_ES);
    if (u.includes("/MapServer/5/")) return json(r, LAUSD_BND_MS);
    if (u.includes("/MapServer/6/")) return json(r, LAUSD_BND_HS);
    return json(r, { features: [] });
  });
  await page.route("**/services5.arcgis.com/**", r => {
    const u = r.request().url();
    if (u.includes("Elementary_Schools")) return json(r, LAUSD_KEY_ES);
    if (u.includes("Middle_Schools")) return json(r, LAUSD_KEY_MS);
    if (u.includes("High_Schools")) return json(r, LAUSD_KEY_HS);
    return json(r, { features: [] });
  });
}
// SABS 2015-16 @ 1007 Matilija Rd (GUSD) — verbatim, INCLUDING the two
// openEnroll=1 district-wide preschool polygons the app must filter out.
const SABS_GUSD = { displayFieldName: "SrcName", features: [
  { attributes: { SrcName: "Hoover HS", ncessch: "061524001933", schnam: "Herbert Hoover High", leaid: "0615240", gslo: "09", gshi: "12", defacto: "0", stAbbrev: "CA", openEnroll: "0", level: "3", MultiBdy: "0", Shape_Length: 30327.910945802996, Shape_Area: 36254930.833869763, OBJECTID: 6416, Shape_Leng: 30327.910945799998 } },
  { attributes: { SrcName: "Mark Keppel", ncessch: "061524001935", schnam: "Mark Keppel Elementary", leaid: "0615240", gslo: "KG", gshi: "05", defacto: "0", stAbbrev: "CA", openEnroll: "0", level: "1", MultiBdy: "0", Shape_Length: 19952.646973701329, Shape_Area: 20369497.344092254, OBJECTID: 6418, Shape_Leng: 19952.646973700001 } },
  { attributes: { SrcName: "Toll MS", ncessch: "061524001946", schnam: "Eleanor J. Toll Middle", leaid: "0615240", gslo: "06", gshi: "08", defacto: "0", stAbbrev: "CA", openEnroll: "0", level: "2", MultiBdy: "0", Shape_Length: 28142.835472877399, Shape_Area: 34014497.657412931, OBJECTID: 6428, Shape_Leng: 28142.835472899998 } },
  { attributes: { SrcName: " ", ncessch: "061524012596", schnam: "Cloud Preschool", leaid: "0615240", gslo: "N", gshi: "N", defacto: "0", stAbbrev: "CA", openEnroll: "1", level: "N", MultiBdy: "0", Shape_Length: 71499.174041415332, Shape_Area: 143222521.4135589, OBJECTID: 6433, Shape_Leng: 71499.174041399994 } },
  { attributes: { SrcName: " ", ncessch: "061524013437", schnam: "Pacific Avenue - Early Bird Preschool", leaid: "0615240", gslo: "N", gshi: "N", defacto: "0", stAbbrev: "CA", openEnroll: "1", level: "N", MultiBdy: "0", Shape_Length: 71499.174041415332, Shape_Area: 143222521.4135589, OBJECTID: 6434, Shape_Leng: 71499.174041399994 } }
]};
const NCES_DIST_GUSD = { features: [{ attributes: { OBJECTID: 3170, STATEFP: "06", ELSDLEA: " ", SCSDLEA: " ", UNSDLEA: "15240", SDADMLEA: " ", GEOID: "0615240", NAME: "Glendale Unified School District", LSAD: "00", LOGRADE: "KG", HIGRADE: "12", MTFCC: "G5420", SDTYP: " ", FUNCSTAT: "E", ALAND: 97177015, AWATER: 363797, INTPTLAT: "+34.2038347", INTPTLON: "-118.2517672", GEO_YEAR: "2025", SCHOOLYEAR: "2024-2025" } }] }; // verbatim @ Matilija Rd

// ===== Phase 2: Air & Traffic stubs (verbatim, live-captured Aug 2026) =====
// SHN returns each carriageway separately (NB+SB) — the app must dedupe to one "I-5".
const SHN_I5 = { features: [
  { attributes: { OBJECTID: 1593, Route: 5, RteSuffix: "", RouteS: "5", PMRouteID: "LA.005...R", County: "LA", District: 7, PMPrefix: "", bPM: 16.906, ePM: 43.101, PMSuffix: "", bPMc: "16.906", ePMc: "43.101", bOdometer: 133.303, eOdometer: 159.498, AlignCode: "Right", RouteType: "Interstate", Direction: "NB", Shape__Length: 51036.867237296035 } },
  { attributes: { OBJECTID: 1394, Route: 5, RteSuffix: "", RouteS: "5", PMRouteID: "LA.005...L", County: "LA", District: 7, PMPrefix: "", bPM: 16.901, ePM: 43.101, PMSuffix: "", bPMc: "16.901", ePMc: "43.101", bOdometer: 133.27, eOdometer: 159.47, AlignCode: "Left", RouteType: "Interstate", Direction: "SB", Shape__Length: 50939.830705264605 } }
]}; // verbatim SHN_Lines 500m ring @ Tyburn
const SHN_EMPTY = { features: [] };
// AADT fields are ALL strings, and the station duplicates per carriageway (dedupe test)
const AADT_I5 = { features: [
  { attributes: { OBJECTID: 12072, DISTRICT: "7", RTE: "5", RTE_SFX: null, CNTY: "LA", PM_PFX: null, PM: "23.655", PM_SFX: null, DESCRIPTION: "LOS ANGELES, GLENDALE BOULEVARD", BACK_PEAK_HOUR: "14200", BACK_PEAK_MADT: "230000", BACK_AADT: "219000", AHEAD_PEAK_HOUR: "13700", AHEAD_PEAK_MADT: "220000", AHEAD_AADT: "210000" } },
  { attributes: { OBJECTID: 12073, DISTRICT: "7", RTE: "5", RTE_SFX: null, CNTY: "LA", PM_PFX: null, PM: "23.655", PM_SFX: null, DESCRIPTION: "LOS ANGELES, GLENDALE BOULEVARD", BACK_PEAK_HOUR: "14200", BACK_PEAK_MADT: "230000", BACK_AADT: "219000", AHEAD_PEAK_HOUR: "13700", AHEAD_PEAK_MADT: "220000", AHEAD_AADT: "210000" } }
]}; // verbatim Traffic_AADT 500m ring @ Tyburn
const CES_P1 = { features: [{ attributes: { Tract: 6037187101, CIscore: 35.34779344, CIscoreP: 68.06606152, PM2_5: 11.96632968, Traffic_Pctl: 90.9625, Diesel_PM_Pctl: 88.52520224, PM2_5_Pctl: 76.65214686, Ozone_Pctl: 64.72930927, Asthma_Pctl: 50.18693918, County: "Los Angeles", ApproxLoc: "Los Angeles", Population: 3438 } }] }; // verbatim CES4/8 @ Tyburn (PM2_5 raw re-captured)
const CES_P2 = { features: [{ attributes: { Tract: 6037301300, CIscore: 26.48268089, CIscoreP: 51.91628845, PM2_5: 11.73519514, Traffic_Pctl: 7.6625, Diesel_PM_Pctl: 14.57373989, PM2_5_Pctl: 67.39265713, Ozone_Pctl: 76.93839452, Asthma_Pctl: 21.29860419, County: "Los Angeles", ApproxLoc: "Glendale", Population: 1894 } }] }; // verbatim CES4/8 @ Matilija Rd (PM2_5 raw re-captured)
// Multi-location response is a bare ARRAY in request order; only entries after
// the first carry location_id. Verbatim @ Tyburn + Downtown LA + Santa Monica
// + Van Nuys (identical values are real — one uniform-basin hour).
const OPENMETEO_OK = [
  { latitude: 34.1, longitude: -118.3, generationtime_ms: 0.37729740142822266, utc_offset_seconds: -25200, timezone: "America/Los_Angeles", timezone_abbreviation: "GMT-7", elevation: 117.0, current_units: { time: "iso8601", interval: "seconds", us_aqi: "USAQI", pm2_5: "μg/m³", pm10: "μg/m³", ozone: "μg/m³", nitrogen_dioxide: "μg/m³" }, current: { time: "2026-08-05T14:00", interval: 3600, us_aqi: 67, pm2_5: 19.2, pm10: 23.9, ozone: 124.0, nitrogen_dioxide: 6.6 } },
  { latitude: 34.0, longitude: -118.2, generationtime_ms: 0.12218952178955078, utc_offset_seconds: -25200, timezone: "America/Los_Angeles", timezone_abbreviation: "GMT-7", elevation: 80.0, location_id: 1, current_units: { time: "iso8601", interval: "seconds", us_aqi: "USAQI", pm2_5: "μg/m³", pm10: "μg/m³", ozone: "μg/m³", nitrogen_dioxide: "μg/m³" }, current: { time: "2026-08-05T14:00", interval: 3600, us_aqi: 67, pm2_5: 19.2, pm10: 23.9, ozone: 124.0, nitrogen_dioxide: 6.6 } },
  { latitude: 34.0, longitude: -118.5, generationtime_ms: 0.09953975677490234, utc_offset_seconds: -25200, timezone: "America/Los_Angeles", timezone_abbreviation: "GMT-7", elevation: 35.0, location_id: 2, current_units: { time: "iso8601", interval: "seconds", us_aqi: "USAQI", pm2_5: "μg/m³", pm10: "μg/m³", ozone: "μg/m³", nitrogen_dioxide: "μg/m³" }, current: { time: "2026-08-05T14:00", interval: 3600, us_aqi: 67, pm2_5: 19.2, pm10: 23.9, ozone: 124.0, nitrogen_dioxide: 6.6 } },
  { latitude: 34.200005, longitude: -118.399994, generationtime_ms: 0.09274482727050781, utc_offset_seconds: -25200, timezone: "America/Los_Angeles", timezone_abbreviation: "GMT-7", elevation: 220.0, location_id: 3, current_units: { time: "iso8601", interval: "seconds", us_aqi: "USAQI", pm2_5: "μg/m³", pm10: "μg/m³", ozone: "μg/m³", nitrogen_dioxide: "μg/m³" }, current: { time: "2026-08-05T14:00", interval: 3600, us_aqi: 67, pm2_5: 19.2, pm10: 23.9, ozone: 124.0, nitrogen_dioxide: 6.6 } }
]; // verbatim multi-location capture
// ===== Phase 3: Getting Around stubs (verbatim, live-captured Aug 2026) =====
// The canonical EPA layer serves the CURRENT release (12.67 at Tyburn); the
// AGOL mirror still hosts the older 2010-vintage index (15.167, field D4a).
const EPA_WALK_P1 = { features: [{ attributes: { GEOID10: "060371871011", GEOID20: "060371871011", CSA_Name: "Los Angeles-Long Beach, CA", CBSA_Name: "Los Angeles-Long Beach-Anaheim, CA", TotPop: 1041, NatWalkInd: 12.666666666666668, D4A: 710.78999999999996, D3B: 80.033354266506564, D5AR: 438302, D5BR: 264822, D2A_Ranked: 12, D2B_Ranked: 12, D3B_Ranked: 12, D4A_Ranked: 14 } }] }; // verbatim @ Tyburn
const EPA_WALK_P2 = { features: [{ attributes: { GEOID10: "060373013002", NatWalkInd: 6.4999999999999991, D4A: -99999, TotPop: 1254 } }] }; // verbatim values @ Matilija (D4A -99999 = no transit)
const EPA_MIRROR_P1 = { features: [{ attributes: { NatWalkInd: 15.167, D4a: 537.845186794, GEOID10: "060371871011" } }] }; // verbatim mirror @ Tyburn
const METRO_P1 = { features: [
  { attributes: { OBJECTID: 1316, stop_id: 2209, stop_name: "Glendale / Riverside" }, geometry: { x: -118.26490599999994, y: 34.11124500000005 } },
  { attributes: { OBJECTID: 1312, stop_id: 2205, stop_name: "Glendale / Glenhurst" }, geometry: { x: -118.26234499999998, y: 34.11630700000006 } },
  { attributes: { OBJECTID: 6494, stop_id: 10746, stop_name: "Glendale / Glenfeliz" }, geometry: { x: -118.26296999999994, y: 34.11629400000004 } }
]}; // verbatim @ Tyburn 800m (3 of 17)
const METRO_GLENOAKS = { exceededTransferLimit: true, features: [
  { attributes: { stop_id: 7680, stop_name: "Glenoaks / Sonora" }, geometry: { x: -118.28546499999999, y: 34.168412000000046 } },
  { attributes: { stop_id: 7673, stop_name: "Glenoaks / Grandview" }, geometry: { x: -118.28110699999996, y: 34.16523200000006 } },
  { attributes: { stop_id: 16019, stop_name: "Glenoaks / Sonora" }, geometry: { x: -118.28574799999996, y: 34.16793000000007 } }
]}; // verbatim @ Matilija 1600m — duplicate stop name on purpose (dedupe test)
const METRO_EMPTY = { features: [] };
// LA City bikeways: third feature is Retire='X' (superseded) and must be filtered
const BIKE_P1 = { features: [
  { attributes: { OBJECTID: 30, ASSETID: 531, SECT_ID: "2362300", ST_NAME: "GRIFFITH PARK BL", ST_FROM: "LOS FELIZ BL", ST_TO: "WOOD TE", Class: 2, Bikeway: "Lane", Retire: " ", FY: "FY05/06", Year_: 2005, CD: "4", Network: "Backbone", Region: "North Central", Shape__Length: 37.26854295212677 } },
  { attributes: { OBJECTID: 31, ASSETID: 547, SECT_ID: "2362800", ST_NAME: "GRIFFITH PARK BL", ST_FROM: "MONON ST", ST_TO: "ST GEORGE ST", Class: 2, Bikeway: "Lane", Retire: " ", FY: "FY05/06", Year_: 2005, CD: "4", Network: "Backbone", Region: "North Central", Shape__Length: 421.1920378845558 } },
  { attributes: { OBJECTID: 32, ASSETID: 5579, SECT_ID: "2363100", ST_NAME: "GRIFFITH PARK BL", ST_FROM: "ANGUS ST", ST_TO: "TRACY ST", Class: 2, Bikeway: "Buffer Bike Lane", Retire: "X", RetireType: "BIKE LANE", Upgraded_From: "BL TO BBL", Project_Type: "UPGRADE", FY: "FY20/21", Year_: 2020, CD: "4", Shape__Length: 826.0038879114669 } }
]}; // verbatim @ Tyburn (3 of 72)
const BIKE_P2_COUNTY = { features: [
  { attributes: { FID: 608, FID_bikewa: 1444, county: "Los Angeles", class: 3, name: " ", GEOID10: "06037", Caltrans_D: 7, MPOs: "SCAG", miles: 1.0783275591, ct_ver: 0, Shape__Length: 2104.4876667481735 } },
  { attributes: { FID: 878, FID_bikewa: 1700, county: "Los Angeles", class: 3, name: " ", GEOID10: "06037", Caltrans_D: 7, MPOs: "SCAG", miles: 2.00221323872, ct_ver: 0, Shape__Length: 3897.2278165769676 } }
]}; // verbatim Metro countywide layer @ Matilija (trimmed fields to those used)
async function moveRoutes(page, opts = {}) {
  await page.route("**/geodata.epa.gov/**", r => opts.epaDown ? r.abort("failed") : json(r, opts.walk || EPA_WALK_P1));
  await page.route("**/National_Walkability_Index/**", r => json(r, EPA_MIRROR_P1));
  await page.route("**/LACMTAstopsDEC24_view/**", r => {
    const u = r.request().url();
    if (opts.metroFar) return json(r, u.includes("distance=800") ? METRO_EMPTY : METRO_GLENOAKS);
    return json(r, METRO_P1);
  });
  await page.route("**/LA_City_Bikeways/**", r => json(r, opts.cityBikes || BIKE_P1));
  await page.route("**/RmCCgQtiZLDCtblq/**", r => opts.countyDown ? r.abort("failed") : json(r, opts.countyBikes || { features: [] }));
}

// Noise (Phase 6) stubs — verbatim NTAD rail features near Tyburn (main line =
// Metrolink Valley Sub with Amtrak trackage rights) + the verbatim Burbank
// airport contour feature (used to exercise the in-contour code path)
const RAIL_P1 = { features: [
  { attributes: { OBJECTID: 35674, RROWNER1: "SCAX", TRKRGHTS1: null, SUBDIV: null, PASSNGR: null, NET: "S", MILES: 1.458236407979817 } },
  { attributes: { OBJECTID: 36600, RROWNER1: "SCAX", TRKRGHTS1: null, SUBDIV: null, PASSNGR: null, NET: "O", MILES: 0.3590222248143609 } },
  { attributes: { OBJECTID: 269168, RROWNER1: "SCAX", TRKRGHTS1: "AMTK", SUBDIV: "VALLEY (SCAX)", PASSNGR: "B", NET: "M", MILES: 0.39706182230547454 } },
  { attributes: { OBJECTID: 269994, RROWNER1: "SCAX", TRKRGHTS1: "AMTK", SUBDIV: "VALLEY (SCAX)", PASSNGR: "B", NET: "M", MILES: 0.5637763283212474 } }
]};
// AGOL layer verbatim (70 CNEL ring @ -118.359,34.199) + the old county
// server's verbatim 65 feature (identical schema) listed FIRST — the app must
// pick the max CLASS when a point sits in several ring bands
const AIRPORT_BUR = { features: [
  { attributes: { OBJECTID: 5291, CLASS: "65", AIRPORT_NAME: "Burbank", DATE_RECEIVED: "2/4/2025", SOURCE: "Quarterly Noise Monitoring at Bob Hope Airport - 4th Quarter - 2024" } },
  { attributes: { OBJECTID: 11, CLASS: "70", AIRPORT_NAME: "Burbank", DATE_RECEIVED: "5/1/2012", SOURCE: "Quarterly Noise Monitoring at Bob Hope Airport - 4th Quarter - 2011", Shape__Area: 1923149.41015625, Shape__Length: 12272.843337544153 } }
]};
async function airRoutes(page, opts = {}) {
  await page.route("**/caltrans-gis.dot.ca.gov/**", r => {
    const u = r.request().url();
    if (u.includes("Traffic_AADT")) return json(r, opts.noHighway ? SHN_EMPTY : AADT_I5);
    if (u.includes("SHN_Lines")) {
      if (opts.noHighway) return json(r, SHN_EMPTY);
      // 200m ring misses, 500m ring hits — mirrors the live Tyburn behavior
      return json(r, u.includes("distance=200") ? SHN_EMPTY : SHN_I5);
    }
    return json(r, SHN_EMPTY);
  });
  await page.route("**/CES4/FeatureServer/**", r => json(r, opts.ces || CES_P1));
  await page.route("**/air-quality-api.open-meteo.com/**", r => json(r, OPENMETEO_OK));
  await page.route("**/xOi1kZaI0eWDREZv/**", r => json(r, opts.rail !== undefined ? opts.rail : RAIL_P1));
  await page.route("**/eGIS_Transportation_Hosted_Layers/**", r => json(r, opts.airport !== undefined ? opts.airport : { features: [] }));
}
// ===== Phase 5: People stubs (verbatim, live-captured Aug 2026) =====
const ACS_INC_P1 = { features: [{ attributes: { GEOID: "06037187101", NAME: "Census Tract 1871.01", B19049_001E: 91829, B19049_001M: 24115 } }] };
const ACS_EDU_P1 = { features: [{ attributes: { GEOID: "06037187101", NAME: "Census Tract 1871.01", B15002_001E: 2502, B15002_calc_numGEBAE: 1144, B15002_calc_pctGEBAE: 45.7 } }] };
const ACS_HOU_P1 = { features: [{ attributes: { GEOID: "06037187101", NAME: "Census Tract 1871.01", B25003_001E: 1262, B25003_002E: 504, B25003_calc_pctOwnE: 39.9, B25077_001E: 1217100 } }] };
const ACS_INC_P2 = { features: [{ attributes: { GEOID: "06037301300", NAME: "Census Tract 3013", B19049_001E: 201357, B19049_001M: 41308 } }] };
const ACS_EDU_P2 = { features: [{ attributes: { GEOID: "06037301300", NAME: "Census Tract 3013", B15002_001E: 1390, B15002_calc_numGEBAE: 1036, B15002_calc_pctGEBAE: 74.5 } }] };
const ACS_HOU_P2 = { features: [{ attributes: { GEOID: "06037301300", NAME: "Census Tract 3013", B25003_001E: 642, B25003_002E: 630, B25003_calc_pctOwnE: 98.1, B25077_001E: 1709200 } }] };
const ACS_RACE_P1 = { features: [{ attributes: { GEOID: "06037187101", NAME: "Census Tract 1871.01", B03002_001E: 3026, B03002_calc_pctHispLatE: 39.4, B03002_calc_pctNHWhiteE: 34.6, B03002_calc_pctBlackE: 0, B03002_calc_pctAsianE: 19.4, B03002_calc_pct2OrMoreE: 6.4, B03002_calc_pctOtherE: 0.2, B03002_calc_pctAIANE: 0, B03002_calc_pctNHOPIE: 0 } }] }; // verbatim @ Tyburn
const ACS_RACE_P2 = { features: [{ attributes: { GEOID: "06037301300", NAME: "Census Tract 3013", B03002_001E: 2061, B03002_calc_pctHispLatE: 7.3, B03002_calc_pctNHWhiteE: 83.9, B03002_calc_pctBlackE: 0.5, B03002_calc_pctAsianE: 5.1, B03002_calc_pct2OrMoreE: 3.2, B03002_calc_pctOtherE: 0, B03002_calc_pctAIANE: 0, B03002_calc_pctNHOPIE: 0 } }] }; // verbatim @ Matilija
const ACS_AGE_P1 = { features: [{ attributes: { GEOID: "06037187101", NAME: "Census Tract 1871.01", B01001_001E: 3026, B01002_001E: 40.7, B01002_001M: 2.1 } }] }; // verbatim @ Tyburn
const ACS_AGE_P2 = { features: [{ attributes: { GEOID: "06037301300", NAME: "Census Tract 3013", B01001_001E: 2061, B01002_001E: 45.1, B01002_001M: 3.8 } }] }; // verbatim @ Matilija
async function peopleRoutes(page, opts = {}) {
  await page.route("**/P3ePLMYs2RVChkJx/**", r => {
    const u = r.request().url();
    if (u.includes("Median_Household_Income")) return (opts.incomeDown || opts.allDown) ? r.abort("failed") : json(r, opts.income || ACS_INC_P1);
    if (u.includes("Educational_Attainment")) return opts.allDown ? r.abort("failed") : json(r, opts.edu || ACS_EDU_P1);
    if (u.includes("Housing_Units_Occupancy")) return opts.allDown ? r.abort("failed") : json(r, opts.housing || ACS_HOU_P1);
    if (u.includes("Race_and_Hispanic_Origin")) return opts.allDown ? r.abort("failed") : json(r, opts.race || ACS_RACE_P1);
    if (u.includes("Median_Age")) return opts.allDown ? r.abort("failed") : json(r, opts.age || ACS_AGE_P1);
    return json(r, { features: [] });
  });
}

async function schoolsBaseRoutes(page) {
  // enough fire-side routes to render #result so the tab bar appears
  await page.route("**/geocode.arcgis.com/**", r => json(r, ESRI_HIT("2968 Tyburn St, Los Angeles, California, 90039", -118.26164, 34.11268)));
  await page.route("**/nominatim.openstreetmap.org/**", r => json(r, NOMINATIM_HIT));
  await page.route("**/utility.arcgis.com/**", r => json(r, r.request().url().includes("distance=") ? FHSZ_EMPTY : LRA25_HIGH));
  await page.route("**/fhsz24_1/FeatureServer/0/query**", r => json(r, FHSZ_EMPTY));
  await page.route("**/National_Risk_Index_Census_Tracts/**", r => json(r, NRI_NORATING));
  await page.route("**/California_Historic_Fire_Perimeters/**", r => json(r, FIRES_EMPTY));
}

// -- happy path: LAUSD district + nearby schools --
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1600 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text()); });
  await schoolsBaseRoutes(page);
  await page.route("**/School_Districts_Current/FeatureServer/**", r => json(r, NCES_DIST_LAUSD));
  await page.route("**/Public_School_Locations_Current/FeatureServer/**", r => json(r, NCES_SCHOOLS_OK));
  await lausdAssignedRoutes(page);
  await injectDash(page);
  await page.route("**/SABS_1516/**", r => json(r, { features: [] })); // LAUSD must NOT hit SABS — empty stub makes that failure visible
  await page.goto(appUrl);
  await page.fill("#addr", "2968 Tyburn St, Los Angeles, CA 90039");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });

  // tab defaults: Fire visible, Schools hidden and empty until opened
  check("SCH: Schools tab present", await page.locator('.tab[data-tab="schools"]').count() === 1);
  check("SCH: Fire tab active by default", await page.locator('.tab[data-tab="fire"]').evaluate(el => el.classList.contains("active")));
  check("SCH: schools panel hidden until opened", await page.locator("#tab-schools").isHidden());
  check("SCH: schools lazy (no content before click)", (await page.textContent("#tab-schools")).trim() === "");

  await page.click('.tab[data-tab="schools"]');
  await page.waitForSelector("#tab-schools .schoolrow", { timeout: 10000 });
  await page.waitForTimeout(200);
  const sch = await page.textContent("#tab-schools");

  check("SCH: fire panel now hidden", await page.locator("#tab-fire").isHidden());
  check("ARIA: aria-selected tracks the active tab", (await page.locator('.tab[data-tab="schools"]').getAttribute("aria-selected")) === "true" && (await page.locator('.tab[data-tab="fire"]').getAttribute("aria-selected")) === "false");
  check("SCH: district name shown (LA Unified)", sch.includes("Los Angeles Unified"));
  check("SCH: district grades & vintage shown", sch.includes("KG–12") && sch.includes("2024-2025"));
  check("SCH: nearby schools listed", sch.includes("Atwater Avenue Elementary") && sch.includes("Ivanhoe Elementary"));
  const firstRow = await page.textContent("#tab-schools .schoollist:not(#asglist) .schoolrow:first-child");
  check("SCH: nearest school sorted first (Ivanhoe ~640m)", firstRow.includes("Ivanhoe"), firstRow);
  check("SCH: three nearby schools rendered", await page.locator("#tab-schools .schoollist:not(#asglist) .schoolrow").count() === 3);
  check("SCH: distance rendered", /\d+\s?m|\d\.\d\s?km/.test(sch), sch.slice(0, 120));
  check("SCH: street address shown", sch.includes("3271 Silver Lake Blvd."));
  check("SCH: district school tagged with district name", (await page.locator("#tab-schools .schoollist:not(#asglist) .stag:not(.other)").count()) === 2 && sch.includes("Los Angeles Unified"));
  check("SCH: charter tagged as charter/other (Alliance)", (await page.textContent("#tab-schools .schoolrow:has-text('Alliance')")).includes("charter / other district"));
  check("SCH: LAUSD Resident School Identifier link", (await page.locator(`#tab-schools a[href="https://rsi.lausd.net/ResidentSchoolIdentifier/"]`).count()) === 2, "inline + links card; bare rsi.lausd.net root 404s");
  check("SCH: GreatSchools verify link present", (await page.locator('#tab-schools a[href*="greatschools.org"]').count()) >= 1);
  check("SCH: NCES per-school profile link uses NCESSCH", (await page.locator('#tab-schools a[href*="school_detail.asp?Search=1&ID=062271002828"]').count()) === 1);
  check("SCH: NCES district finder link present", (await page.locator('#tab-schools a[href*="nces.ed.gov/ccd/schoolmap"]').count()) === 1);
  const gsHref = await page.locator('#tab-schools .schoollist:not(#asglist) .schoolrow:first-child a[href*="greatschools.org"]').getAttribute("href");
  check("GS-FIX: search query drops the state token (trailing CA 404s)", gsHref.includes("search.page?q=Ivanhoe%20Elementary%20Los%20Angeles") && !/%20CA$/.test(gsHref), String(gsHref));

  // -- assigned schools (LAUSD 2019-20 boundaries + keycode join) --
  check("ASG: assigned section present", sch.includes("Assigned public schools"));
  const firstAsg = await page.textContent("#asglist .schoolrow:first-child");
  check("ASG: Elementary = Atwater Ave El (K–6) sorted before DTS", firstAsg.includes("Atwater Ave El") && firstAsg.includes("K–6") && !firstAsg.includes("DTS"), firstAsg);
  check("ASG: shared-boundary center (DTS) also listed", sch.includes("Atwater Ave El DTS"));
  check("ASG: Middle = Irving MS", sch.includes("Irving MS MME Mag"));
  check("ASG: High = Marshall SH", sch.includes("Marshall SH"));
  check("ASG: level tags on all 4 rows", (await page.locator("#asglist .stag").count()) === 4);
  check("ASG: CA Dashboard link from CDS (Atwater 19647336015895)", (await page.locator('#asglist a[href="https://www.caschooldashboard.org/reports/19647336015895"]').count()) === 1);
  check("ASG: CDE profile link from CDS (Marshall 19647331935568)", (await page.locator('#asglist a[href*="SchoolDirectory/details?cdscode=19647331935568"]').count()) === 1);
  check("ASG: DTS center (null CDS) gets no Dashboard link", (await page.locator('#asglist .schoolrow:has-text("DTS") a[href*="caschooldashboard"]').count()) === 0);
  check("ASG: 2019-20 vintage disclaimed", sch.includes("2019-20"));

  // -- inline official CA Dashboard rating pills (baked data) --
  const marshallRow = await page.textContent('#asglist .schoolrow:has-text("Marshall SH")');
  check("DASH: assigned Marshall shows plain-language n/5 pills", marshallRow.includes("Graduation 5/5") && marshallRow.includes("English 3/5"), marshallRow);
  const atwaterNearby = await page.textContent('#tab-schools .schoollist:not(#asglist) .schoolrow:has-text("Atwater Avenue")');
  check("DASH: nearby school pills via NCES→CDS map (English 5/5, Absences 1/5)", atwaterNearby.includes("English 5/5") && atwaterNearby.includes("Absences 1/5"), atwaterNearby);
  check("DASH: no Dashboard jargon in pill labels", !sch.includes("ELA") && !sch.includes("Absenteeism"), "labels must be plain language");
  check("DASH: hover explains each pill in full sentences", (await page.locator('#asglist .dpill').first().getAttribute("title") || "").includes("the state rates this"));
  check("DASH: school without a published rating gets no pills (Ivanhoe)", (await page.locator('#tab-schools .schoolrow:has-text("Ivanhoe") .dpill').count()) === 0);
  check("DASH: pills legend explains 1–5 higher-is-better", sch.includes("CA School Dashboard 2025") && sch.includes("higher is better"));
  await page.screenshot({ path: path.join(here, "shot-schools.png"), fullPage: true });

  // switching back to Fire still works and content intact
  await page.click('.tab[data-tab="fire"]');
  check("SCH: Fire tab restores verdict", (await page.textContent("#tab-fire")).includes("High Fire Hazard Severity Zone"));
  check("SCH: fire carriers still 14", await page.locator(".carrier").count() === 14);
  check("SCH: no JS errors (happy path)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// -- degraded path: district service fails, no nearby schools → honest labels --
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1200 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text()); });
  await schoolsBaseRoutes(page);
  await page.route("**/School_Districts_Current/FeatureServer/**", r => r.abort("failed"));
  await page.route("**/Public_School_Locations_Current/FeatureServer/**", r => json(r, NCES_SCHOOLS_EMPTY));
  await page.route("**/SABS_1516/**", r => r.abort("failed")); // unknown district → SABS path, which also fails
  await page.goto(appUrl);
  await page.fill("#addr", "2968 Tyburn St, Los Angeles, CA 90039");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  await page.click('.tab[data-tab="schools"]');
  await page.waitForSelector("#tab-schools .card", { timeout: 10000 });
  await page.waitForTimeout(300);
  const sch = await page.textContent("#tab-schools");
  check("SCH-ERR: district failure labeled honestly (not blank/0)", sch.includes("Couldn’t load") || sch.includes("Not determined"), sch.slice(0, 160));
  check("SCH-ERR: assigned failure labeled honestly", sch.includes("Couldn’t load attendance-boundary data"), sch.slice(0, 300));
  check("SCH-ERR: no schools stated plainly", sch.includes("No public schools found"), sch.slice(0, 200));
  check("SCH-ERR: finder link-outs still shown", (await page.locator("#tab-schools a[href*=\"nces.ed.gov\"]").count()) === 1 && (await page.locator("#tab-schools a[href*=\"caschooldashboard.org\"]").count()) >= 1);
  check("SCH-ERR: no JS errors (degraded path)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// -- GUSD (non-LAUSD) assigned schools via SABS 2015-16 --
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1600 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text()); });
  await page.route("**/geocode.arcgis.com/**", r => json(r, ESRI_HIT("1007 Matilija Rd, Glendale, California, 91208", -118.27626, 34.177624)));
  await page.route("**/nominatim.openstreetmap.org/**", r => json(r, NOMINATIM_HIT));
  await page.route("**/utility.arcgis.com/**", r => json(r, FHSZ_EMPTY));
  await page.route("**/fhsz24_1/FeatureServer/0/query**", r => json(r, r.request().url().includes("distance=") ? FHSZ_NEAR : FHSZ_EMPTY));
  await page.route("**/National_Risk_Index_Census_Tracts/**", r => json(r, NRI_OK));
  await page.route("**/California_Historic_Fire_Perimeters/**", r => json(r, FIRES_EMPTY));
  await page.route("**/School_Districts_Current/FeatureServer/**", r => json(r, NCES_DIST_GUSD));
  await page.route("**/Public_School_Locations_Current/FeatureServer/**", r => json(r, NCES_SCHOOLS_EMPTY));
  await page.route("**/SABS_1516/**", r => json(r, SABS_GUSD));
  // GUSD must never touch the LAUSD layers — abort makes any such call a visible failure
  await page.route("**/maps.lacity.org/**", r => r.abort("failed"));
  await page.route("**/services5.arcgis.com/**", r => r.abort("failed"));
  await injectDash(page);
  await page.goto(appUrl);
  await page.fill("#addr", "1007 Matilija Rd, Glendale, CA 91208");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  await page.click('.tab[data-tab="schools"]');
  await page.waitForSelector("#asglist .schoolrow", { timeout: 10000 });
  await page.waitForTimeout(200);
  const sch = await page.textContent("#tab-schools");
  check("GUSD: district shown", sch.includes("Glendale Unified School District"));
  check("GUSD: assigned Keppel elementary", sch.includes("Mark Keppel Elementary"));
  check("GUSD: assigned Toll middle", sch.includes("Eleanor J. Toll Middle"));
  check("GUSD: assigned Hoover high", sch.includes("Herbert Hoover High"));
  const firstAsg = await page.textContent("#asglist .schoolrow:first-child");
  check("GUSD: levels ordered elementary first", firstAsg.includes("Mark Keppel"), firstAsg);
  check("GUSD: grades normalized (K–5 / 6–8 / 9–12)", sch.includes("K–5") && sch.includes("6–8") && sch.includes("9–12"));
  check("GUSD: open-enrollment preschool polygons filtered out", !sch.includes("Preschool"));
  check("GUSD: SABS 2015-16 vintage disclaimed", sch.includes("2015-16"));
  check("GUSD: NCES per-school profile link (Keppel)", (await page.locator('#asglist a[href*="school_detail.asp?Search=1&ID=061524001935"]').count()) === 1);
  check("GUSD: level tags rendered (3)", (await page.locator("#asglist .stag").count()) === 3);
  check("GUSD: no LAUSD RSI link for non-LAUSD district", (await page.locator('#tab-schools a[href*="rsi.lausd.net"]').count()) === 0);
  const keppelRow = await page.textContent('#asglist .schoolrow:has-text("Keppel")');
  check("GUSD-DASH: SABS school pills via NCES→CDS map (Keppel English 2/5, Math 4/5)", keppelRow.includes("English 2/5") && keppelRow.includes("Math 4/5"), keppelRow);
  check("GUSD: no JS errors", errors.length === 0, errors.join(" | "));
  await page.screenshot({ path: path.join(here, "shot-schools-gusd.png"), fullPage: true });
  await ctx.close();
}

// -- SABS returns nothing (district never surveyed) → honest no-boundary message --
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1200 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text()); });
  await page.route("**/geocode.arcgis.com/**", r => json(r, ESRI_HIT("1007 Matilija Rd, Glendale, California, 91208", -118.27626, 34.177624)));
  await page.route("**/nominatim.openstreetmap.org/**", r => json(r, NOMINATIM_HIT));
  await page.route("**/utility.arcgis.com/**", r => json(r, FHSZ_EMPTY));
  await page.route("**/fhsz24_1/FeatureServer/0/query**", r => json(r, FHSZ_EMPTY));
  await page.route("**/National_Risk_Index_Census_Tracts/**", r => json(r, NRI_OK));
  await page.route("**/California_Historic_Fire_Perimeters/**", r => json(r, FIRES_EMPTY));
  await page.route("**/School_Districts_Current/FeatureServer/**", r => json(r, NCES_DIST_GUSD));
  await page.route("**/Public_School_Locations_Current/FeatureServer/**", r => json(r, NCES_SCHOOLS_EMPTY));
  await page.route("**/SABS_1516/**", r => json(r, { features: [] }));
  await page.goto(appUrl);
  await page.fill("#addr", "1007 Matilija Rd, Glendale, CA 91208");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  await page.click('.tab[data-tab="schools"]');
  await page.waitForSelector("#tab-schools .card", { timeout: 10000 });
  await page.waitForTimeout(300);
  const sch = await page.textContent("#tab-schools");
  check("SABS-EMPTY: honest no-boundary message", sch.includes("No attendance boundary contains this address"), sch.slice(0, 300));
  check("SABS-EMPTY: district + finder links still shown", sch.includes("Glendale Unified") && (await page.locator('#tab-schools a[href*="nces.ed.gov/ccd/schoolmap"]').count()) === 1);
  check("SABS-EMPTY: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// -- LAUSD partial failure: ES keycode table loads, MS/HS tables die → per-level honesty --
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1600 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text()); });
  await schoolsBaseRoutes(page);
  await page.route("**/School_Districts_Current/FeatureServer/**", r => json(r, NCES_DIST_LAUSD));
  await page.route("**/Public_School_Locations_Current/FeatureServer/**", r => json(r, NCES_SCHOOLS_EMPTY));
  await page.route("**/maps.lacity.org/**", r => {
    const u = r.request().url();
    if (u.includes("/MapServer/4/")) return json(r, LAUSD_BND_ES);
    if (u.includes("/MapServer/5/")) return json(r, LAUSD_BND_MS);
    if (u.includes("/MapServer/6/")) return json(r, LAUSD_BND_HS);
    return json(r, { features: [] });
  });
  await page.route("**/services5.arcgis.com/**", r =>
    r.request().url().includes("Elementary_Schools") ? json(r, LAUSD_KEY_ES) : r.abort("failed"));
  await page.goto(appUrl);
  await page.fill("#addr", "2968 Tyburn St, Los Angeles, CA 90039");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  await page.click('.tab[data-tab="schools"]');
  await page.waitForSelector("#asglist .schoolrow", { timeout: 10000 });
  await page.waitForTimeout(200);
  const sch = await page.textContent("#tab-schools");
  check("ASG-PART: loaded level still shown (Atwater)", sch.includes("Atwater Ave El"));
  check("ASG-PART: failed levels labeled Couldn’t load (2)", (sch.match(/Couldn’t load/g) || []).length >= 2, sch.slice(0, 400));
  check("ASG-PART: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// ===================== Phase 2: Air & Traffic tab (stubbed) =====================
// -- happy path @ Tyburn: I-5 at 500m, 219k AADT, CES P1, live AQI --
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1600 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text()); });
  await schoolsBaseRoutes(page);
  await airRoutes(page);
  await page.goto(appUrl);
  await page.fill("#addr", "2968 Tyburn St, Los Angeles, CA 90039");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  check("AIR: tab present", await page.locator('.tab[data-tab="air"]').count() === 1);
  check("AIR: panel lazy (no content before click)", (await page.textContent("#tab-air")).trim() === "");
  await page.click('.tab[data-tab="air"]');
  await page.waitForSelector("#tab-air .tile", { timeout: 10000 });
  await page.waitForTimeout(200);
  const air = await page.textContent("#tab-air");
  const hwTileTxt = await page.textContent('#tab-air .tile:has-text("Nearest state highway")');
  check("AIR: I-5 named exactly once in freeway tile (NB/SB deduped)", (hwTileTxt.match(/I-5/g) || []).length === 1, hwTileTxt);
  check("AIR: noise card cross-references the freeway", air.includes("also a noise source"));
  check("AIR: freeway distance ring shown (~500 m)", air.includes("within ~500 m"));
  check("AIR: CARB 500-ft advisory with handbook link", air.includes("500 ft") && (await page.locator('#tab-air a[href*="Land%20Use%20Handbook_0.pdf"]').count()) === 2, "warnbox + sources card");
  check("AIR: AADT 219,000 veh/day (string parsed, max of back/ahead)", air.includes("219,000") && air.includes("veh/day"));
  check("AIR: AADT station deduped to one description", (air.match(/GLENDALE BOULEVARD/g) || []).length === 1);
  check("AIR: CES overall 68th percentile", air.includes("68th"));
  check("AIR: CES traffic 91st percentile", air.includes("91st"));
  check("AIR: CES diesel 89th percentile", air.includes("89th"));
  check("AIR: plain verdict names the drivers", air.includes("higher than 68%") && air.includes("vehicle traffic (worse than 91% of tracts)"), air.slice(0, 500));
  check("AIR: percentile tiles carry plain-English tiers", air.includes("Among CA’s highest") && air.includes("High for CA"));
  check("AIR: absolute PM2.5 health comparison", air.includes("12.0 µg/m³") && air.includes("EPA health standard") && air.includes("2.4× the WHO guideline"), air.slice(0, 900));
  check("AIR: long-term burden leads, live AQI demoted to snapshot", air.indexOf("Long-term air pollution burden") >= 0 && air.indexOf("Long-term air pollution burden") < air.indexOf("Air quality right now (snapshot)"));
  check("AIR: CES tract id zero-padded + vintage shown", air.includes("06037187101") && air.includes("CalEnviroScreen 4.0"));
  check("AIR: AQI 67 with Moderate category label", air.includes("67") && air.includes("Moderate"));
  check("AIR: PM2.5 value with units", air.includes("19.2") && air.includes("µg/m³"));
  check("AIR: LA-wide same-hour AQI comparison inline", air.includes("Across LA this hour") && air.includes("Downtown LA 67") && air.includes("Santa Monica 67") && air.includes("Van Nuys 67"), air.slice(0, 600));
  check("AIR: Open-Meteo CC-BY attribution link", (await page.locator('#tab-air a[href="https://open-meteo.com/"]').count()) === 1);
  check("AIR: AirNow link centered on this address", (await page.locator('#tab-air a[href*="fire.airnow.gov"][href*="lat=34.11268"]').count()) === 1);
  check("AIR: CES official map verify link", (await page.locator('#tab-air a[href*="experience.arcgis.com/experience/11d2f52282a54ceebcac7428e6184203"]').count()) === 1);
  check("AIR: Caltrans Traffic Census verify link", (await page.locator('#tab-air a[href*="dot.ca.gov/programs/traffic-operations/census"]').count()) === 1);
  check("AIR: rail main line warnbox (Metrolink Valley + Amtrak)", air.includes("main line") && air.includes("Metrolink") && air.includes("Valley"), air.slice(-700));
  check("AIR: no airport contour honestly stated", air.includes("Not inside any LA County airport noise contour"));
  check("AIR: national noise map viewer link", (await page.locator('#tab-air a[href="https://maps.dot.gov/BTS/NationalTransportationNoiseMap/"]').count()) === 1);
  check("AIR: no JS errors (happy path)", errors.length === 0, errors.join(" | "));
  await page.screenshot({ path: path.join(here, "shot-air.png"), fullPage: true });
  await ctx.close();
}

// -- quiet address @ Matilija: no highway or station within 1 km, CES P2 --
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1400 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text()); });
  await page.route("**/geocode.arcgis.com/**", r => json(r, ESRI_HIT("1007 Matilija Rd, Glendale, California, 91208", -118.27626, 34.177624)));
  await page.route("**/nominatim.openstreetmap.org/**", r => json(r, NOMINATIM_HIT));
  await page.route("**/utility.arcgis.com/**", r => json(r, FHSZ_EMPTY));
  await page.route("**/fhsz24_1/FeatureServer/0/query**", r => json(r, FHSZ_EMPTY));
  await page.route("**/National_Risk_Index_Census_Tracts/**", r => json(r, NRI_OK));
  await page.route("**/California_Historic_Fire_Perimeters/**", r => json(r, FIRES_EMPTY));
  await airRoutes(page, { noHighway: true, ces: CES_P2, rail: { features: [] }, airport: AIRPORT_BUR });
  await page.goto(appUrl);
  await page.fill("#addr", "1007 Matilija Rd, Glendale, CA 91208");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  await page.click('.tab[data-tab="air"]');
  await page.waitForSelector("#tab-air .tile", { timeout: 10000 });
  await page.waitForTimeout(200);
  const air = await page.textContent("#tab-air");
  check("AIR-P2: no highway AND no station honestly labeled", (air.match(/None within 1 km/g) || []).length === 2, air.slice(0, 300));
  check("AIR-P2: no CARB warnbox when nothing near", !air.includes("500 ft"));
  check("AIR-P2: CES traffic 8th percentile (quiet street)", air.includes("8th"));
  check("AIR-P2: quiet-street tiers read as clean", air.includes("Cleaner than most of CA") && air.includes("higher than 52%"), air.slice(0, 500));
  check("AIR-P2: PM2.5 still above standards even here (11.7)", air.includes("11.7 µg/m³") && air.includes("EPA health standard"));
  check("AIR-P2: CES tract is the Glendale one", air.includes("6037301300") && air.includes("Glendale"));
  check("AIR-P2: no rail within 1 km honest", air.includes("No rail line within 1 km"));
  check("AIR-P2: airport contour renders with MAX ring (Burbank 70 dB CNEL, not 65)", air.includes("Burbank") && air.includes("70") && air.includes("CNEL") && !air.includes("65 dB CNEL"));
  check("AIR-P2: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// -- degraded path: every air service dies → honest labels, links intact --
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1400 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text()); });
  await schoolsBaseRoutes(page);
  await page.route("**/caltrans-gis.dot.ca.gov/**", r => r.abort("failed"));
  await page.route("**/CES4/FeatureServer/**", r => r.abort("failed"));
  await page.route("**/air-quality-api.open-meteo.com/**", r => r.abort("failed"));
  await page.route("**/xOi1kZaI0eWDREZv/**", r => r.abort("failed"));
  await page.route("**/eGIS_Transportation_Hosted_Layers/**", r => r.abort("failed"));
  await page.goto(appUrl);
  await page.fill("#addr", "2968 Tyburn St, Los Angeles, CA 90039");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  await page.click('.tab[data-tab="air"]');
  await page.waitForSelector("#tab-air .card", { timeout: 10000 });
  await page.waitForTimeout(300);
  const air = await page.textContent("#tab-air");
  check("AIR-ERR: highway + AADT tiles say Couldn’t load", (air.match(/Couldn’t load/g) || []).length >= 3, air.slice(0, 400));
  check("AIR-ERR: CES failure points at official map", air.includes("Couldn’t load CalEnviroScreen"));
  check("AIR-ERR: AQ failure points at AirNow", air.includes("check AirNow"));
  check("AIR-ERR: rail + airport noise failures labeled", air.includes("Couldn’t load the federal rail-network layer") && air.includes("Couldn’t load the LA County airport-noise layer"));
  check("AIR-ERR: all five source links still shown", (await page.locator("#tab-air .links a").count()) === 5);
  check("AIR-ERR: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// ===================== Phase 3: Getting Around tab (stubbed) =====================
// -- happy path @ Tyburn: walkable, 3 Metro stops, LA City bikeways --
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1600 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text()); });
  await schoolsBaseRoutes(page);
  await moveRoutes(page);
  await page.goto(appUrl);
  await page.fill("#addr", "2968 Tyburn St, Los Angeles, CA 90039");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  check("MOVE: tab present", await page.locator('.tab[data-tab="move"]').count() === 1);
  check("MOVE: panel lazy (no content before click)", (await page.textContent("#tab-move")).trim() === "");
  await page.click('.tab[data-tab="move"]');
  await page.waitForSelector("#tab-move .tile", { timeout: 10000 });
  await page.waitForTimeout(200);
  const mv = await page.textContent("#tab-move");
  check("MOVE: walk index 12.7 / 20 (current EPA release, not 2010 mirror)", mv.includes("12.7") && mv.includes("/ 20") && mv.includes("current EPA release"), mv.slice(0, 250));
  check("MOVE: walk tier Above-average", mv.includes("Above-average walkable"));
  check("MOVE: block group id shown", mv.includes("060371871011"));
  check("MOVE: 3 Metro stops within 800 m", mv.includes("Metro stops within 800 m") && mv.includes("Dec 2024"));
  check("MOVE: nearest stop Glendale / Riverside ~340 m first", (await page.textContent("#tab-move .schoolrow:first-child")).includes("Glendale / Riverside"), await page.textContent("#tab-move .schoolrow:first-child"));
  check("MOVE: stop distance rendered", /3[3-5]0 m/.test(mv), mv.slice(0, 400));
  check("MOVE: municipal-operator disclaimer (Beeline)", mv.includes("Glendale Beeline"));
  check("MOVE: best-infrastructure tile in plain English", (await page.locator('#tab-move .tile:has-text("Best bike infrastructure") .value').textContent()).includes("Painted bike lane"), mv.slice(0, 400));
  check("MOVE: plain type explains the safety tradeoff", mv.includes("no barrier between you and traffic"));
  check("MOVE: breakdown with street names (Retire='X' row still filtered)", mv.includes("Painted bike lanes ×2") && mv.includes("Griffith Park Bl"));
  check("MOVE: no Caltrans class jargon as the primary label", !mv.includes("Class II bike lane ×"));
  check("MOVE: LA City inventory attributed + segment caveat", mv.includes("LA City DOT inventory") && mv.includes("one street usually spans several"));
  check("MOVE: Walk Score link lowercase slug", (await page.locator('#tab-move a[href="https://www.walkscore.com/score/2968-tyburn-st-los-angeles-california-90039"]').count()) === 1);
  check("MOVE: EPA viewer + Metro links present", (await page.locator('#tab-move a[href*="epa.maps.arcgis.com"]').count()) === 1 && (await page.locator('#tab-move a[href*="metro.net/riding/schedules"]').count()) === 1);
  check("MOVE: no JS errors (happy path)", errors.length === 0, errors.join(" | "));
  await page.screenshot({ path: path.join(here, "shot-move.png"), fullPage: true });
  await ctx.close();
}

// -- quiet address @ Matilija: below-average walk, stops only at 1.6 km, county bikeways --
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1400 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text()); });
  await page.route("**/geocode.arcgis.com/**", r => json(r, ESRI_HIT("1007 Matilija Rd, Glendale, California, 91208", -118.27626, 34.177624)));
  await page.route("**/nominatim.openstreetmap.org/**", r => json(r, NOMINATIM_HIT));
  await page.route("**/utility.arcgis.com/**", r => json(r, FHSZ_EMPTY));
  await page.route("**/fhsz24_1/FeatureServer/0/query**", r => json(r, FHSZ_EMPTY));
  await page.route("**/National_Risk_Index_Census_Tracts/**", r => json(r, NRI_OK));
  await page.route("**/California_Historic_Fire_Perimeters/**", r => json(r, FIRES_EMPTY));
  await moveRoutes(page, { walk: EPA_WALK_P2, metroFar: true, cityBikes: { features: [] }, countyBikes: BIKE_P2_COUNTY });
  await page.goto(appUrl);
  await page.fill("#addr", "1007 Matilija Rd, Glendale, CA 91208");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  await page.click('.tab[data-tab="move"]');
  await page.waitForSelector("#tab-move .tile", { timeout: 10000 });
  await page.waitForTimeout(200);
  const mv = await page.textContent("#tab-move");
  check("MOVE-P2: walk 6.5 Below-average", mv.includes("6.5") && mv.includes("Below-average walkable"));
  check("MOVE-P2: stops widened to 1.6 km with honest note", mv.includes("Metro stops within 1.6 km") && mv.includes("None within 800 m"), mv.slice(0, 400));
  check("MOVE-P2: duplicate stop names deduped in nearest list", (mv.match(/Glenoaks \/ Sonora/g) || []).length === 1);
  check("MOVE-P2: county bikeways read as shared-streets-only", (await page.locator('#tab-move .tile:has-text("Best bike infrastructure") .value').textContent()).includes("Shared streets only") && mv.includes("Shared streets ×2") && mv.includes("countywide inventory"), mv.slice(0, 400));
  check("MOVE-P2: shared-street risk stated plainly", mv.includes("ride in the traffic lane with cars"));
  check("MOVE-P2: capped stop count shown as 3+", (await page.locator('#tab-move .tile:has-text("Metro stops") .value').textContent()).trim() === "3+");
  check("MOVE-P2: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// -- EPA primary down → mirror fallback labeled as older vintage --
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1400 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text()); });
  await schoolsBaseRoutes(page);
  await moveRoutes(page, { epaDown: true });
  await page.goto(appUrl);
  await page.fill("#addr", "2968 Tyburn St, Los Angeles, CA 90039");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  await page.click('.tab[data-tab="move"]');
  await page.waitForSelector("#tab-move .tile", { timeout: 10000 });
  await page.waitForTimeout(200);
  const mv = await page.textContent("#tab-move");
  check("MOVE-MIRROR: falls back to 15.2 with vintage disclaimer", mv.includes("15.2") && mv.includes("2010-vintage"), mv.slice(0, 300));
  check("MOVE-MIRROR: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// -- degraded path: every getting-around service dies --
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1400 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text()); });
  await schoolsBaseRoutes(page);
  await page.route("**/geodata.epa.gov/**", r => r.abort("failed"));
  await page.route("**/National_Walkability_Index/**", r => r.abort("failed"));
  await page.route("**/LACMTAstopsDEC24_view/**", r => r.abort("failed"));
  await page.route("**/LA_City_Bikeways/**", r => r.abort("failed"));
  await page.route("**/RmCCgQtiZLDCtblq/**", r => r.abort("failed"));
  await page.goto(appUrl);
  await page.fill("#addr", "2968 Tyburn St, Los Angeles, CA 90039");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  await page.click('.tab[data-tab="move"]');
  await page.waitForSelector("#tab-move .card", { timeout: 10000 });
  await page.waitForTimeout(300);
  const mv = await page.textContent("#tab-move");
  check("MOVE-ERR: walk, transit and bike failures all labeled", mv.includes("Couldn’t load the EPA walkability service") && mv.includes("Couldn’t load the Metro stops service") && mv.includes("Couldn’t load the bikeway inventories"), mv.slice(0, 400));
  check("MOVE-ERR: all four source links still shown", (await page.locator("#tab-move .links a").count()) === 4);
  check("MOVE-ERR: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// ===================== Phase 5: People tab (stubbed) =====================
// -- happy path @ Tyburn --
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1400 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text()); });
  await schoolsBaseRoutes(page);
  await peopleRoutes(page);
  await page.goto(appUrl);
  await page.fill("#addr", "2968 Tyburn St, Los Angeles, CA 90039");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  check("PPL: tab present + lazy", (await page.locator('.tab[data-tab="people"]').count()) === 1 && (await page.textContent("#tab-people")).trim() === "");
  await page.click('.tab[data-tab="people"]');
  await page.waitForSelector("#tab-people .tile", { timeout: 10000 });
  await page.waitForTimeout(200);
  const pp = await page.textContent("#tab-people");
  check("PPL: median income $91,829 with MOE", pp.includes("$91,829") && pp.includes("$24,115"), pp.slice(0, 300));
  check("PPL: bachelor's 45.7% of 25+", pp.includes("45.7%") && pp.includes("25 and older"));
  check("PPL: owner-occupied 39.9%", pp.includes("39.9%"));
  check("PPL: median home value $1,217,100", pp.includes("$1,217,100"));
  check("PPL: tract name + vintage disclosed", pp.includes("Census Tract 1871.01") && pp.includes("2020-2024"));
  check("PPL: median age with MOE", pp.includes("40.7") && pp.includes("± 2.1 years"));
  check("PPL: tract population", pp.includes("3,026"));
  check("PPL: race breakdown sorted largest-first", (await page.locator("#tab-people .racerow").first().textContent()).includes("Hispanic or Latino") && pp.includes("39.4%"), pp.slice(0, 600));
  check("PPL: race groups under 0.5% hidden (Black 0%)", (await page.locator('#tab-people .racerow:has-text("Black")').count()) === 0);
  check("PPL: non-Hispanic convention explained", pp.includes("non-Hispanic"));
  check("PPL: CensusReporter tract link", (await page.locator('#tab-people a[href="https://censusreporter.org/profiles/14000US06037187101/"]').count()) === 1);
  check("PPL: FCC broadband link with coordinates", (await page.locator('#tab-people a[href*="broadbandmap.fcc.gov/location-summary/fixed"][href*="lat=34.11268"]').count()) === 1);
  check("PPL: no JS errors (happy path)", errors.length === 0, errors.join(" | "));
  await page.screenshot({ path: path.join(here, "shot-people.png"), fullPage: true });
  await ctx.close();
}

// -- Glendale tract @ Matilija --
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1400 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text()); });
  await page.route("**/geocode.arcgis.com/**", r => json(r, ESRI_HIT("1007 Matilija Rd, Glendale, California, 91208", -118.27626, 34.177624)));
  await page.route("**/nominatim.openstreetmap.org/**", r => json(r, NOMINATIM_HIT));
  await page.route("**/utility.arcgis.com/**", r => json(r, FHSZ_EMPTY));
  await page.route("**/fhsz24_1/FeatureServer/0/query**", r => json(r, FHSZ_EMPTY));
  await page.route("**/National_Risk_Index_Census_Tracts/**", r => json(r, NRI_OK));
  await page.route("**/California_Historic_Fire_Perimeters/**", r => json(r, FIRES_EMPTY));
  await peopleRoutes(page, { income: ACS_INC_P2, edu: ACS_EDU_P2, housing: ACS_HOU_P2, race: ACS_RACE_P2, age: ACS_AGE_P2 });
  await page.goto(appUrl);
  await page.fill("#addr", "1007 Matilija Rd, Glendale, CA 91208");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  await page.click('.tab[data-tab="people"]');
  await page.waitForSelector("#tab-people .tile", { timeout: 10000 });
  await page.waitForTimeout(200);
  const pp = await page.textContent("#tab-people");
  check("PPL-P2: income $201,357 / owner 98.1% / value $1,709,200", pp.includes("$201,357") && pp.includes("98.1%") && pp.includes("$1,709,200"), pp.slice(0, 300));
  check("PPL-P2: CensusReporter link for the Glendale tract", (await page.locator('#tab-people a[href="https://censusreporter.org/profiles/14000US06037301300/"]').count()) === 1);
  check("PPL-P2: race breakdown White-led (83.9%) + median age 45.1", (await page.locator("#tab-people .racerow").first().textContent()).includes("White") && pp.includes("83.9%") && pp.includes("45.1"));
  check("PPL-P2: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// -- one service down → per-tile honesty; the rest still render --
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1400 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text()); });
  await schoolsBaseRoutes(page);
  await peopleRoutes(page, { incomeDown: true });
  await page.goto(appUrl);
  await page.fill("#addr", "2968 Tyburn St, Los Angeles, CA 90039");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  await page.click('.tab[data-tab="people"]');
  await page.waitForSelector("#tab-people .tile", { timeout: 10000 });
  await page.waitForTimeout(200);
  const pp = await page.textContent("#tab-people");
  check("PPL-PART: income failure labeled, education intact", pp.includes("Couldn’t load") && pp.includes("45.7%"), pp.slice(0, 300));
  check("PPL-PART: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// -- all census services down --
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1200 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text()); });
  await schoolsBaseRoutes(page);
  await peopleRoutes(page, { allDown: true, incomeDown: true });
  await page.goto(appUrl);
  await page.fill("#addr", "2968 Tyburn St, Los Angeles, CA 90039");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  await page.click('.tab[data-tab="people"]');
  await page.waitForSelector("#tab-people .card", { timeout: 10000 });
  await page.waitForTimeout(300);
  const pp = await page.textContent("#tab-people");
  check("PPL-ERR: total failure labeled honestly", pp.includes("Couldn’t load the census services"), pp.slice(0, 300));
  check("PPL-ERR: FCC link still offered (no tract link without GEOID)", (await page.locator('#tab-people a[href*="broadbandmap.fcc.gov"]').count()) === 1 && (await page.locator('#tab-people a[href*="censusreporter.org"]').count()) === 0);
  check("PPL-ERR: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// ============== review-fix regressions (adversarial code review, Aug 2026) ==============

// -- partial FHSZ outage must NOT read as a confident "not in a zone" --
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1200 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text()); });
  await page.route("**/geocode.arcgis.com/**", r => json(r, ESRI_HIT("2968 Tyburn St, Los Angeles, California, 90039", -118.26164, 34.11268)));
  await page.route("**/nominatim.openstreetmap.org/**", r => json(r, NOMINATIM_HIT));
  await page.route("**/utility.arcgis.com/**", r => r.abort("failed"));   // the four LRA25 phase layers (LA City's only zone source) die
  await page.route("**/fhsz24_1/FeatureServer/0/query**", r => json(r, FHSZ_EMPTY));
  await page.route("**/National_Risk_Index_Census_Tracts/**", r => r.abort("failed"));
  await page.route("**/California_Historic_Fire_Perimeters/**", r => r.abort("failed"));
  await page.goto(appUrl);
  await page.fill("#addr", "2968 Tyburn St, Los Angeles, CA 90039");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  await page.waitForTimeout(400);
  const verdict = await page.textContent("#verdict-card");
  check("PART: no-zone verdict flagged as possibly incomplete", verdict.includes("Not in a designated") && verdict.includes("incomplete"), verdict.slice(0, 400));
  check("PART: NRI failure shows Couldn’t load, not a missing tile", verdict.includes("Couldn’t load") && verdict.includes("National Risk Index service didn’t respond"));
  check("PART: fire-history failure labeled too", verdict.includes("fire-perimeter service didn’t respond"));
  check("PART: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// -- both geocoders erroring (HTTP 5xx) is a service problem, not a bad address --
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  await page.route("**/geocode.arcgis.com/**", r => r.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  await page.route("**/nominatim.openstreetmap.org/**", r => r.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  await page.goto(appUrl);
  await page.fill("#addr", "2968 Tyburn St, Los Angeles, CA 90039");
  await page.click("#go");
  await page.waitForSelector("#err", { state: "visible", timeout: 10000 });
  const err = await page.textContent("#err");
  check("GEO-DOWN: 5xx from both geocoders blames the services, not the address", err.includes("geocoding services returned errors") && !err.includes("Couldn’t find that address"), err);
  await ctx.close();
}

// -- streets ending in "ca" (Seneca) must still get the Glendale, CA suffix --
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  let captured = null;
  await page.route("**/geocode.arcgis.com/**", r => { captured = decodeURIComponent(r.request().url()).replace(/\+/g, " "); return json(r, ESRI_MISS); });
  await page.route("**/nominatim.openstreetmap.org/**", r => json(r, []));
  await page.goto(appUrl);
  await page.fill("#addr", "1200 Seneca St");
  await page.click("#go");
  await page.waitForSelector("#err", { state: "visible", timeout: 10000 });
  check("REGEX: 'Seneca' no longer suppresses the city/state suffix", captured != null && captured.includes("1200 Seneca St, Glendale, CA"), String(captured));
  await ctx.close();
}

// -- top-coded ACS income renders as >$250k, not a double-escaped literal --
{
  // synthetic fixture: the verbatim P1 income row with the value raised to the
  // Census top-code sentinel (250001) to exercise the >$250k branch
  const ACS_INC_TOP = { features: [{ attributes: { GEOID: "06037187101", NAME: "Census Tract 1871.01", B19049_001E: 250001, B19049_001M: null } }] };
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1200 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await schoolsBaseRoutes(page);
  await peopleRoutes(page, { income: ACS_INC_TOP });
  await page.goto(appUrl);
  await page.fill("#addr", "2968 Tyburn St, Los Angeles, CA 90039");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  await page.click('.tab[data-tab="people"]');
  await page.waitForSelector("#tab-people .tile", { timeout: 10000 });
  const pp = await page.textContent("#tab-people");
  check("TOPCODE: renders >$250k, not the double-escaped '&gt;$250k'", pp.includes(">$250k") && !pp.includes("&gt;"), pp.slice(0, 200));
  check("TOPCODE: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// -- empty LA City layer + dead county layer = couldn't load, never a fake "none" --
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1200 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await schoolsBaseRoutes(page);
  await moveRoutes(page, { cityBikes: { features: [] }, countyDown: true });
  await page.goto(appUrl);
  await page.fill("#addr", "2968 Tyburn St, Los Angeles, CA 90039");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  await page.click('.tab[data-tab="move"]');
  await page.waitForSelector("#tab-move .tile", { timeout: 10000 });
  await page.waitForTimeout(200);
  const mv = await page.textContent("#tab-move");
  check("BIKE-FALL: non-covering empty layer can't fabricate 'no bikeways'", mv.includes("Couldn’t load the bikeway inventories") && !mv.includes("No existing bikeway"), mv.slice(0, 400));
  check("BIKE-FALL: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// -- owner-configured keys: Walk Score® inline via JSONP --
{
  // WS_OK follows the Walk Score API's documented response shape; the score
  // values are the live-verified badge numbers for 2968 Tyburn St (79/51/77)
  const WS_OK = { status: 1, walkscore: 79, description: "Very Walkable", updated: "2025-01-01", ws_link: "https://www.walkscore.com/score/2968-tyburn-st-los-angeles-ca-90039", help_link: "https://www.walkscore.com/how-it-works/", snapped_lat: 34.1127, snapped_lon: -118.2616, transit: { score: 51, description: "Good Transit", summary: "" }, bike: { score: 77, description: "Very Bikeable" } };
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1400 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text()); });
  await page.addInitScript(() => { window.FIRE_CHECKER_KEYS = { walkscoreKey: "TESTKEY" }; });
  await schoolsBaseRoutes(page);
  await moveRoutes(page);
  await page.route("**/api.walkscore.com/**", r => {
    const cb = new URL(r.request().url()).searchParams.get("callback");
    return r.fulfill({ contentType: "application/javascript", body: `${cb}(${JSON.stringify(WS_OK)})` });
  });
  await page.goto(appUrl);
  await page.fill("#addr", "2968 Tyburn St, Los Angeles, CA 90039");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  await page.click('.tab[data-tab="move"]');
  await page.waitForSelector("#tab-move .tile", { timeout: 10000 });
  await page.waitForTimeout(300);
  const mv = await page.textContent("#tab-move");
  check("WS: inline Walk/Transit/Bike Scores when key configured", mv.includes("Walk Score®") && mv.includes("79") && mv.includes("51") && mv.includes("77"), mv.slice(0, 500));
  check("WS: score descriptions shown", mv.includes("Very Walkable") && mv.includes("Good Transit"));
  check("WS: attribution links to walkscore.com", (await page.locator('#tab-move a[href="https://www.walkscore.com/score/2968-tyburn-st-los-angeles-ca-90039"]').count()) >= 1);
  check("WS: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// -- stale-search race: a slow tab load from search #1 must never overwrite search #2 --
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1600 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text()); });
  await page.route("**/geocode.arcgis.com/**", r => {
    const u = decodeURIComponent(r.request().url());
    return json(r, u.includes("Tyburn")
      ? ESRI_HIT("2968 Tyburn St, Los Angeles, California, 90039", -118.26164, 34.11268)
      : ESRI_HIT("1007 Matilija Rd, Glendale, California, 91208", -118.27626, 34.177624));
  });
  await page.route("**/nominatim.openstreetmap.org/**", r => json(r, NOMINATIM_HIT));
  await page.route("**/utility.arcgis.com/**", r => json(r, FHSZ_EMPTY));
  await page.route("**/fhsz24_1/FeatureServer/0/query**", r => json(r, FHSZ_EMPTY));
  await page.route("**/National_Risk_Index_Census_Tracts/**", r => json(r, NRI_OK));
  await page.route("**/California_Historic_Fire_Perimeters/**", r => json(r, FIRES_EMPTY));
  // Tyburn's district lookup answers late (after the second search); Matilija's is instant
  await page.route("**/School_Districts_Current/FeatureServer/**", async r => {
    if (r.request().url().includes("-118.26164")) {
      await new Promise(res => setTimeout(res, 2500));
      return json(r, NCES_DIST_LAUSD);
    }
    return json(r, NCES_DIST_GUSD);
  });
  await page.route("**/Public_School_Locations_Current/FeatureServer/**", r => json(r, NCES_SCHOOLS_EMPTY));
  await page.route("**/SABS_1516/**", r => json(r, SABS_GUSD));
  await lausdAssignedRoutes(page);
  await page.goto(appUrl);
  await page.fill("#addr", "2968 Tyburn St, Los Angeles, CA 90039");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  await page.click('.tab[data-tab="schools"]');   // search #1's schools load now hangs on the slow district response
  await page.waitForTimeout(150);
  await page.fill("#addr", "1007 Matilija Rd, Glendale, CA 91208");
  await page.click("#go");                        // search #2 resets the tabs mid-flight
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  await page.click('.tab[data-tab="schools"]');
  await page.waitForSelector("#asglist .schoolrow", { timeout: 10000 });
  await page.waitForTimeout(3200);                // give search #1's zombie promise time to resolve
  const sch = await page.textContent("#tab-schools");
  check("RACE: stale search #1 never overwrites search #2's schools", sch.includes("Glendale Unified") && sch.includes("Matilija") && !sch.includes("Los Angeles Unified"), sch.slice(0, 300));
  check("RACE: no JS errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

await browser.close();

let failed = 0;
for (const r of results) {
  console.log((r.pass ? "PASS" : "FAIL") + "  " + r.name + (r.detail && !r.pass ? "  [" + r.detail + "]" : ""));
  if (!r.pass) failed++;
}
console.log(failed === 0 ? "\nALL " + results.length + " CHECKS PASSED" : "\n" + failed + " FAILED");
process.exit(failed ? 1 : 0);
