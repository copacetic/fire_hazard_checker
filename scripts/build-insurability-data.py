#!/usr/bin/env python3
"""Bakes ZIP-level home-insurance market data into insurability.json so the
site can show, for any California address, how hard it has become to get
regular insurance in that ZIP — without keys or third-party calls at view time.

Sources (all official, public, no auth):
  1. CA Dept. of Insurance, voluntary-market policy counts by ZIP and year
     (new / renewed / non-renewed), .xlsx linked from
     https://www.insurance.ca.gov/01-consumers/200-wrr/DataAnalysisOnWildfiresAndInsurance.cfm
  2. CA Dept. of Insurance, residential dwelling units insured by the FAIR Plan
     vs the voluntary market, by ZIP (PDF linked from the same page).
  3. California FAIR Plan, residential policies in force by ZIP for the last
     five fiscal years (FY ends Sept 30), PDF linked from
     https://www.cfpnet.com/key-statistics-data/
  4. CA Dept. of Insurance "undermarketed ZIP codes" list — ZIPs where insurers
     using the new rate rules must expand coverage (PDF linked from
     https://www.insurance.ca.gov/01-consumers/180-climate-change/Sustainable-Insurance-Strategy.cfm)

Links are discovered from the index pages each run (filenames change with every
release); any schema surprise raises, so a broken run never commits stale data.

Run: pip install pypdf && python3 scripts/build-insurability-data.py
Output: insurability.json in the repo root.
"""
import io
import json
import os
import re
import sys
import time
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from datetime import date
from pathlib import Path

from pypdf import PdfReader

CDI_DATA_PAGE = "https://www.insurance.ca.gov/01-consumers/200-wrr/DataAnalysisOnWildfiresAndInsurance.cfm"
CDI_SIS_PAGE = "https://www.insurance.ca.gov/01-consumers/180-climate-change/Sustainable-Insurance-Strategy.cfm"
FAIR_STATS_PAGE = "https://www.cfpnet.com/key-statistics-data/"
UA = "Mozilla/5.0 (compatible; address-research-tool data refresh; +https://github.com/copacetic/fire_hazard_checker)"


def fetch(url, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"could not fetch {url}: {last}")


def find_link(page_html, pattern, base):
    m = re.search(r'href="([^"]*' + pattern + r'[^"]*)"', page_html, re.I)
    if not m:
        raise RuntimeError(f"no link matching /{pattern}/ on {base} — page layout changed?")
    href = m.group(1)
    if href.startswith("http"):
        return href
    from urllib.parse import urljoin
    return urljoin(base, href)


def pdf_text(data):
    return "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(data)).pages)


def num(s):
    return int(s.replace(",", ""))


# ---------------------------------------------------------------- 1. policy counts by ZIP
print("CDI data page…", file=sys.stderr)
cdi_html = fetch(CDI_DATA_PAGE).decode("utf-8", "replace")
xlsx_links = re.findall(r'href="([^"]*New-Renew-NonRenew-by-ZIP-(\d{4})-(\d{4})\.xlsx)"', cdi_html, re.I)
if not xlsx_links:
    raise RuntimeError("no New-Renew-NonRenew-by-ZIP xlsx link on the CDI data page")
href, y0, y1 = max(xlsx_links, key=lambda t: int(t[2]))
from urllib.parse import urljoin
policy_url = urljoin(CDI_DATA_PAGE, href)
print(f"policy counts {y0}-{y1}: {policy_url}", file=sys.stderr)

z = zipfile.ZipFile(io.BytesIO(fetch(policy_url)))
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
shared = []
if "xl/sharedStrings.xml" in z.namelist():
    for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
        shared.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))
sheet = [n for n in z.namelist() if n.startswith("xl/worksheets/sheet")][0]
policy = {}  # zip -> year -> (new, renewed, nonrenewed)
header = None
for row in ET.fromstring(z.read(sheet)).iter("{%s}row" % NS["m"]):
    cells = []
    for c in row.findall("m:c", NS):
        v = c.find("m:v", NS)
        val = v.text if v is not None else ""
        if c.get("t") == "s" and val != "":
            val = shared[int(val)]
        cells.append(val.strip())
    if header is None:
        header = [h.lower() for h in cells]
        need = ["zip code", "year", "new", "renewed", "non-renewed"]
        if any(n not in header for n in need):
            raise RuntimeError(f"policy xlsx columns changed: {header}")
        iz, iy, inew, iren, inon = (header.index(n) for n in need)
        continue
    try:
        zc, yr = cells[iz], int(cells[iy])
        n, r, x = int(cells[inew]), int(cells[iren]), int(cells[inon])
    except (ValueError, IndexError):
        continue
    if re.fullmatch(r"\d{5}", zc):
        policy.setdefault(zc, {})[yr] = (n, r, x)
years = sorted({y for d in policy.values() for y in d})
Y_FIRST, Y_LAST = years[0], years[-1]
print(f"policy counts: {len(policy)} ZIPs, years {Y_FIRST}-{Y_LAST}", file=sys.stderr)

# ---------------------------------------------------------------- 2. FAIR Plan share of dwellings by ZIP (CDI)
fair_share_url = find_link(cdi_html, r"FAIR-Plan-vs-Voluntary\.pdf", CDI_DATA_PAGE)
m = re.search(r"Insured-in-(\d{4})", fair_share_url)
FS_YEAR = int(m.group(1)) if m else None
print(f"FAIR share {FS_YEAR}: {fair_share_url}", file=sys.stderr)
share = {}  # zip -> (voluntary units, fair units)
for line in pdf_text(fetch(fair_share_url)).splitlines():
    m = re.search(r"\b(\d{5})\b\s+(.*?)\s+([\d,]+)\s+([\d,]+)\s+([\d.]+)%\s*$", line)
    if m:
        share[m.group(1)] = (num(m.group(3)), num(m.group(4)))
if len(share) < 1000:
    raise RuntimeError(f"FAIR share PDF parsed only {len(share)} ZIPs — layout changed?")
print(f"FAIR share: {len(share)} ZIPs", file=sys.stderr)

# ---------------------------------------------------------------- 3. FAIR Plan policies in force by ZIP (FAIR Plan)
fair_html = fetch(FAIR_STATS_PAGE).decode("utf-8", "replace")
pif_url = find_link(fair_html, r"PIF-Zip-FY\d+-DWE-\d+\.pdf", FAIR_STATS_PAGE)
FY_LAST = 2000 + int(re.search(r"FY(\d+)-DWE", pif_url).group(1))
print(f"FAIR PIF FY{FY_LAST}: {pif_url}", file=sys.stderr)
pif = {}  # zip -> [FY_LAST, FY_LAST-1, ... 5 values]
pif_total = None
for line in pdf_text(fetch(pif_url)).splitlines():
    toks = line.split()
    if not toks or not (re.fullmatch(r"\d{5}", toks[0]) or toks[0] == "Total"):
        continue
    counts = [num(t) for t in toks[1:] if re.fullmatch(r"[\d,]+", t)]
    if len(counts) != 5:
        continue
    if toks[0] == "Total":
        pif_total = counts
    else:
        pif[toks[0]] = counts
if len(pif) < 1000 or not pif_total:
    raise RuntimeError(f"FAIR PIF PDF parsed only {len(pif)} ZIPs (total={pif_total}) — layout changed?")
print(f"FAIR PIF: {len(pif)} ZIPs, statewide {pif_total}", file=sys.stderr)

# ---------------------------------------------------------------- 4. undermarketed ZIPs (CDI)
sis_html = fetch(CDI_SIS_PAGE).decode("utf-8", "replace")
um_url = find_link(sis_html, r"undermarketed-zip-codes-residential[^\"]*\.pdf", CDI_SIS_PAGE)
um_text = pdf_text(fetch(um_url))
i = um_text.upper().find("UNDERMARKETED ZIP CODES")
if i < 0:
    raise RuntimeError("undermarketed PDF has no 'UNDERMARKETED ZIP CODES' section")
body = "\n".join(l for l in um_text[i:].splitlines()
                 if "95814" not in l and "DEPARTMENT OF INSURANCE" not in l.upper())
under = set(re.findall(r"\b9[0-6]\d{3}\b", body))
m = re.search(r"([A-Z][a-z]+ \d{1,2}, \d{4})", um_text)
UM_DATE = m.group(1) if m else None
if len(under) < 100:
    raise RuntimeError(f"undermarketed list parsed only {len(under)} ZIPs — layout changed?")
print(f"undermarketed: {len(under)} ZIPs (list dated {UM_DATE})", file=sys.stderr)

# ---------------------------------------------------------------- assemble
def pctile(values, v):
    """share of values strictly below v (0..1), None if too few comparators"""
    if v is None or len(values) < 50:
        return None
    return round(sum(1 for x in values if x < v) / len(values), 2)


nr_pool, fe_pool = [], []
for zc, yrs in policy.items():
    if Y_LAST in yrs:
        n, r, x = yrs[Y_LAST]
        if r + x >= 500:
            nr_pool.append(x / (r + x))
for zc, (v, f) in share.items():
    if v + f >= 500 and zc in pif:
        fe_pool.append(pif[zc][0] / (v + f))

out_z = {}
for zc in set(policy) | set(share) | set(pif) | under:
    rec = {}
    yrs = policy.get(zc, {})
    if Y_LAST in yrs:
        n, r, x = yrs[Y_LAST]
        if r + x > 0:
            rec["nr"] = round(x / (r + x), 3)
            if r + x >= 500:
                rec["np"] = pctile(nr_pool, x / (r + x))
        rec["n1"] = n
    if Y_FIRST in yrs:
        rec["n0"] = yrs[Y_FIRST][0]
    if zc in share:
        v, f = share[zc]
        rec["v"], rec["f"] = v, f
        if v + f > 0:
            rec["fs"] = round(f / (v + f), 3)
    if zc in pif:
        p = pif[zc]
        rec["p"] = p  # newest fiscal year first
        if zc in share and sum(share[zc]) >= 100:
            fe = p[0] / sum(share[zc])
            rec["fe"] = round(fe, 3)
            if sum(share[zc]) >= 500:
                rec["fp"] = pctile(fe_pool, fe)
    if zc in under:
        rec["um"] = 1
    if rec:
        out_z[zc] = rec

sN = sum(d[Y_LAST][0] for d in policy.values() if Y_LAST in d)
sR = sum(d[Y_LAST][1] for d in policy.values() if Y_LAST in d)
sX = sum(d[Y_LAST][2] for d in policy.values() if Y_LAST in d)
sN0 = sum(d[Y_FIRST][0] for d in policy.values() if Y_FIRST in d)
sV = sum(v for v, f in share.values())
sF = sum(f for v, f in share.values())
state = {
    "nr": round(sX / (sR + sX), 3),
    "n0": sN0, "n1": sN,
    "fs": round(sF / (sV + sF), 3), "v": sV, "f": sF,
    "p": pif_total,
    "fe": round(pif_total[0] / (sV + sF), 3),
    "um": len(under),
}

out = {
    "generated": date.today().isoformat(),
    "about": "ZIP-level California home-insurance market data baked by scripts/build-insurability-data.py. "
             "z[zip]: nr = share of policies not renewed in the latest year, np = share of CA ZIPs (>=500 policies) with a lower nr, "
             "n0/n1 = new policies written in the first/latest year, v/f = dwelling units insured by the voluntary market / FAIR Plan, "
             "fs = f/(v+f), p = FAIR Plan residential policies in force by fiscal year (newest first), "
             "fe = p[0]/(v+f) (rough current FAIR share), fp = share of CA ZIPs with a lower fe, um = 1 if on the CDI undermarketed list.",
    "sources": {
        "policy": {"url": policy_url, "page": CDI_DATA_PAGE, "years": [Y_FIRST, Y_LAST]},
        "fairShare": {"url": fair_share_url, "page": CDI_DATA_PAGE, "year": FS_YEAR},
        "fairPIF": {"url": pif_url, "page": FAIR_STATS_PAGE, "fiscalYears": [FY_LAST - i for i in range(5)], "note": "FAIR Plan fiscal years end Sept 30"},
        "undermarketed": {"url": um_url, "page": CDI_SIS_PAGE, "date": UM_DATE},
    },
    "state": state,
    "z": out_z,
}
Path(__file__).resolve().parent.parent.joinpath("insurability.json").write_text(json.dumps(out, separators=(",", ":")))
print(f"wrote insurability.json: {len(out_z)} ZIPs; state {state}", file=sys.stderr)
