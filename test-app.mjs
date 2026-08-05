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
// Verbatim-shaped NCES EDGE responses. School_Districts_Current is a composite
// (elementary/secondary/unified layers) queried point-in-polygon; a unified
// district returns one name. Public_School_Locations_Current is a point layer
// queried by radius (returnGeometry=true → distance computed client-side).
const NCES_DIST_LAUSD = { features: [{ attributes: { NAME: "Los Angeles Unified School District", GEOID: "0622710" } }] };
const NCES_SCHOOLS_OK = { features: [
  { attributes: { NAME: "Atwater Avenue Elementary", LEVEL: "Elementary", LCITY: "Los Angeles", ST_SCHID: "CA-1964733-6023459" }, geometry: { x: -118.2625, y: 34.1125 } },
  { attributes: { NAME: "Irving Middle School", LEVEL: "Middle", LCITY: "Los Angeles", ST_SCHID: "CA-1964733-6023460" }, geometry: { x: -118.272, y: 34.117 } },
  { attributes: { NAME: "John Marshall High School", LEVEL: "High", LCITY: "Los Angeles" }, geometry: { x: -118.28, y: 34.108 } }
]};
const NCES_SCHOOLS_EMPTY = { features: [] };

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
  check("SCH: district name shown (LA Unified)", sch.includes("Los Angeles Unified"));
  check("SCH: nearby schools listed", sch.includes("Atwater Avenue Elementary") && sch.includes("John Marshall High"));
  const firstRow = await page.textContent("#tab-schools .schoolrow:first-child");
  check("SCH: nearest school sorted first (Atwater)", firstRow.includes("Atwater"), firstRow);
  check("SCH: three schools rendered", await page.locator("#tab-schools .schoolrow").count() === 3);
  check("SCH: distance rendered", /\d+\s?m|\d\.\d\s?km/.test(sch), sch.slice(0, 120));
  check("SCH: LAUSD Resident School Identifier link", (await page.locator('#tab-schools a[href="https://rsi.lausd.net/"]').count()) === 1);
  check("SCH: GreatSchools verify link present", (await page.locator('#tab-schools a[href*="greatschools.org"]').count()) >= 1);
  check("SCH: CA Dashboard link uses 14-digit CDS", (await page.locator('#tab-schools a[href*="caschooldashboard.org/reports/19647336023459"]').count()) === 1);
  check("SCH: NCES district finder link present", (await page.locator('#tab-schools a[href*="nces.ed.gov"]').count()) === 1);

  // switching back to Fire still works and content intact
  await page.click('.tab[data-tab="fire"]');
  check("SCH: Fire tab restores verdict", (await page.textContent("#tab-fire")).includes("High Fire Hazard Severity Zone"));
  check("SCH: fire carriers still 14", await page.locator(".carrier").count() === 14);
  check("SCH: no JS errors (happy path)", errors.length === 0, errors.join(" | "));
  await page.screenshot({ path: path.join(here, "shot-schools.png"), fullPage: true });
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
  await page.goto(appUrl);
  await page.fill("#addr", "2968 Tyburn St, Los Angeles, CA 90039");
  await page.click("#go");
  await page.waitForSelector("#result", { state: "visible", timeout: 10000 });
  await page.click('.tab[data-tab="schools"]');
  await page.waitForSelector("#tab-schools .card", { timeout: 10000 });
  await page.waitForTimeout(300);
  const sch = await page.textContent("#tab-schools");
  check("SCH-ERR: district failure labeled honestly (not blank/0)", sch.includes("Couldn’t load") || sch.includes("Not determined"), sch.slice(0, 160));
  check("SCH-ERR: no schools stated plainly", sch.includes("No public schools found"), sch.slice(0, 200));
  check("SCH-ERR: finder link-outs still shown", (await page.locator("#tab-schools a[href*=\"nces.ed.gov\"]").count()) === 1 && (await page.locator("#tab-schools a[href*=\"caschooldashboard.org\"]").count()) >= 1);
  check("SCH-ERR: no JS errors (degraded path)", errors.length === 0, errors.join(" | "));
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
