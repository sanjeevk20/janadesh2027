# Janadesh 2027

A constituency-level, map-first view of the **2027 Indian state assembly elections**, built around data you can trust.

Seven states go to the polls in 2027, about **940 assembly seats** in total:

| Round | Expected polls | States |
|---|---|---|
| 1 | Feb–Mar 2027 | Uttar Pradesh (403), Punjab (117), Uttarakhand (70), Goa (40), Manipur (60) |
| 2 | Nov–Dec 2027 | Gujarat (182), Himachal Pradesh (68) |

Poll windows are based on when each assembly's term ends. The Election Commission of India has not announced schedules yet.

![Uttar Pradesh coloured by 2022 winner](docs/screenshot-up-2022.png)

## Features

- **Interactive map** of every constituency in the 7 states, built with MapLibre GL. Hover to see the name and district, click for details.
- **State panel** listing seats, majority mark, governing party, term end and expected poll window.
- **Validation of the boundary data.** Each state's boundaries are checked against its known seat count, and shapes that fail are highlighted in red on the map.
- **2022 results** for every seat in the five Round 1 states (690 seats). Colour the map by **winner**, by **winning margin** (darkest = closest contests, the seats most likely to flip), or by state.
  - State view: seat tally, vote share by party, and the 5 closest contests (click one to jump to it).
  - Seat view: winner, runner-up, margin, and the top 5 candidates with votes and vote share.

### 2022 results coverage

| State | Seats with results | 2022 outcome (derived from the data) |
|---|---|---|
| Uttar Pradesh | 403 / 403 | BJP 255, SP 111, AD(S) 12, RLD 8, SBSP 6, NISHAD 6, INC 2, JDL 2, BSP 1 |
| Punjab | 117 / 117 | AAP 92, INC 18, SAD 3, BJP 2, BSP 1, IND 1 |
| Uttarakhand | 70 / 70 | BJP 47, INC 19, BSP 2, IND 2 |
| Goa | 40 / 40 | BJP 20, INC 11, IND 3, MGP 2, AAP 2, GFP 1, RGP 1 |
| Manipur | 60 / 60 | BJP 32, NPP 7, JD(U) 6, INC 5, NPF 5, IND 3, KPA 2 |
| Gujarat | pending | No open source added yet |
| Himachal Pradesh | pending | No open source added yet |

All five derived tallies match the officially declared 2022 results. Results come from [india-votes-data](https://github.com/thecont1/india-votes-data) (MIT), which is scraped from ECI result pages and pinned to a fixed commit.

**Adding Gujarat or Himachal Pradesh:** put a CSV with the same columns (`constituency_no, constituency, candidate, party, evm_votes, postal_votes`) at `data/raw/results/2022Assembly-GJ.csv` or `-HP.csv`, then run `npm run data:build`.

**Join check:** each result is joined to its boundary shape by seat number. The build then compares the two names and flags pairs that don't match, since that's where a shape may have been attached to the wrong seat. Today it flags one seat: UP #154, "Sawayazpur" in the results against "Sawaijpur" in the boundaries (a spelling variant). Shapes with no valid seat number get no result rather than a guessed one.

### What validation found in the source data

The boundaries come from [DataMeet](https://github.com/datameet/maps/tree/master/assembly-constituencies), which scraped them from ECI polling-station data. The build checks them and reports:

| State | Shapes / seats | Findings |
|---|---|---|
| Uttar Pradesh | 403 / 403 | ✓ clean |
| Punjab | 117 / 117 | ✓ clean |
| Uttarakhand | 70 / 70 | ✓ clean |
| Himachal Pradesh | 68 / 68 | ✓ clean |
| Goa | 41 / 40 | 1 extra unnamed shape with no seat number |
| Manipur | 68 / 60 | All boundaries are pre-delimitation; 6 seat numbers duplicated |
| Gujarat | 172 / 182 | 20 seat numbers have no shape (most of Ahmedabad, 45–56, and Surat, 160–167); 10 unnamed shapes with no seat number |

These need repairing against official ECI delimitation data before results can be attached to them. That repair is the next step for this data.

The full report is in [`public/data/validation.json`](public/data/validation.json).

## Getting started

```bash
npm install
npm run data:fetch   # download boundaries + 2022 results into data/raw/ (gitignored)
npm run data:build   # build per-state GeoJSON, results JSON and validation into public/data/
npm run dev          # http://localhost:5173
```

`npm run build` type-checks and produces a static site in `dist/`. It can be hosted on GitHub Pages, Vercel or Cloudflare Pages.

The map uses the [OpenFreeMap](https://openfreemap.org) Positron basemap. If that can't be reached, it falls back to a plain background so the constituency layers still render.

## Project layout

```
data/states.json             State metadata (seats, terms, poll windows, governing party)
data/parties.json            Party abbreviations and map colours
scripts/fetch-boundaries.mjs Downloads the source shapefile
scripts/build-boundaries.mjs Filters, simplifies and validates boundaries
scripts/fetch-results.mjs    Downloads 2022 candidate-level results (pinned commit)
scripts/build-results.mjs    Per-seat winners, margins, party tallies + boundary join check
public/data/results/         Generated 2022 results per state
public/data/boundaries/      Generated per-state GeoJSON (committed so the site works without a build step)
public/data/validation.json  Generated data-quality report
src/                         Web app (TypeScript + MapLibre GL, built with Vite)
```

## Roadmap

1. ✅ **Foundation**: boundaries, state metadata, validation, map
2. ✅ **2022 results** for Round 1 states; Gujarat and Himachal Pradesh still to be sourced
3. **News intelligence**: weekly news collection, with each story tagged by an LLM to the state, constituency, parties and type of claim
4. **Claim checking**: each claim checked against official sources and given a confidence score, with conflicts flagged
5. **Election season**: phase-wise schedule overlays, candidates, live results, swing compared with 2022

## Data and licenses

- Constituency boundaries © DataMeet, [CC BY 2.5 India](http://creativecommons.org/licenses/by/2.5/in/)
- 2022 results: [india-votes-data](https://github.com/thecont1/india-votes-data) (MIT), from Election Commission of India result pages
- Basemap © OpenFreeMap / OpenMapTiles / OpenStreetMap contributors
