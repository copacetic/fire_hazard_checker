# Address Research Tool — working conventions

Single-file web app (`index.html`) on GitHub Pages. Enter a CA address →
fire/insurance, schools, air & noise, transit, people, commute tabs.

## Release policy (owner-set, Aug 2026)
- **Develop on the working branch** (`claude/fire-risk-checker-takeover-*`);
  push there freely — branch pushes never trigger a Pages build.
- **Merge to `main` ONLY for a ready release** — when the owner says ship,
  or a milestone is complete and verified. Never merge every small fix:
  GitHub Pages silently skips builds beyond ~10/hour, and each deploy
  churns the CDN cache (10-min max-age).
- Pages builds only from `main`. If a merged release doesn't deploy, check
  the Actions run for `pages build and deployment` (a queued job with
  `runner_id: 0` that gets cancelled = GitHub-side outage, see
  githubstatus.com) — an empty commit to `main` re-triggers.

## Hard rules
1. Single self-contained `index.html`. No build step, no frameworks, no
   runtime deps. (`dashboard-ratings.json` is baked data, refreshed by
   `.github/workflows/refresh-dashboard-data.yml` running
   `scripts/build-dashboard-data.mjs` — not a build step for the page.)
2. Keyless by default. Owner may add client-visible rate-limit keys via the
   `CONFIG` block (public repo — only revocable keys). Never secret keys.
3. Test-first: `npm i playwright@1.56.0 && node test-app.mjs` must pass
   100% before anything merges. PIN playwright@1.56.0 (matches the
   sandbox's preinstalled Chromium 1194). Tests stub ALL network from
   verbatim live-captured JSON; live checks go in throwaway scripts.
   Every bug found becomes a regression check.
4. Verify every endpoint AND every user-facing link with real requests
   before shipping it. Every displayed number gets a verify-at-source link.
5. Honest labeling: failures say "Couldn't load", absent data says "No
   rating"/"Not determined" — never blank, never fake zeros. Partial
   source outages must be disclosed (see fhszLookup `partial`).
6. Plain language in the UI: no agency jargon (see school pills, bikeway
   types, CES tiers). If the owner asks what something means, the answer
   belongs in the page, not the chat.

## Traps learned the hard way (do not relearn)
- Screenshots at 390px width for every UI change; tab bar must WRAP, not
  overflow (hidden tabs are invisible on phones).
- Stale-search race: every lazy tab loader re-checks `geo !== lastGeo`
  after each await.
- GreatSchools search 404s if the query ends in a state token — name +
  city only. rsi.lausd.net root 404s; use /ResidentSchoolIdentifier/.
- glendaleca.gov + broadbandmap.fcc.gov 403 curl by TLS fingerprint but
  work in browsers — never health-check them with curl.
- The sandbox proxy MITMs TLS: browser-only failures can't be reproduced
  with curl; headless Chromium can't reach live hosts at all (stub tests
  only; `context.route`+`context.request.fetch` shim for throwaway live).
- Esri "(Latest)" ACS views update in place each December (vintage note in
  UI). EPA walkability canonical layer ≠ the older AGOL mirror's values.
- ArcGIS quirks: NB/SB carriageway duplicates (dedupe), string-typed
  numbers (Caltrans AADT), `exceededTransferLimit` → show "N+",
  `where=1=1` required on some old MapServers, `-99999` sentinels.
- file:// pages can't fetch local JSON: `window.FIRE_CHECKER_DATA` is the
  test hook for `dashboard-ratings.json`.
