// Builds 2024 Lok Sabha results per parliamentary constituency (PC) and the 2022→2024 swing,
// then maps both onto assembly constituencies (ACs) through the boundary data's PC names.
//
// 2024 results are only published per PC here, not per assembly segment, so swing is
// measured at PC level: 2024 Lok Sabha vote share vs 2022 assembly vote share summed over
// the ACs inside that PC. Every AC in a PC shows the same swing.
//
// Input:  data/raw/ls2024/Elections2024_candidates_votes_changes.csv  (npm run data:fetch)
//         data/raw/results/2022Assembly-<STATE>.csv                    (optional, for swing)
//         public/data/boundaries/<STATE>.geojson                       (build-boundaries)
//         data/states.json, data/parties.json, data/alliances.json, data/repairs.json
// Output: public/data/ls2024/<STATE>.json
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { LS2024_CSV, LS2024_SOURCE } from './fetch-ls2024.mjs';
import { exists, parseCsv, round, similarity, titleCase } from './lib.mjs';

const OUT = path.resolve('public/data/ls2024');
// ECI state codes as they appear in the source (s_u + st_code, no zero padding).
const ECI_CODES = { UP: 'S24', PB: 'S19', UK: 'S28', GA: 'S5', MN: 'S14', GJ: 'S6', HP: 'S8' };
const EXPECTED_PCS = { UP: 80, PB: 13, UK: 5, GA: 2, MN: 2, GJ: 26, HP: 4 };
const PC_NAME_THRESHOLD = 0.75;
const TOP_CANDIDATES = 5;
// Parties shown in a PC's swing table: at least this share (%) in either election.
const SWING_MIN_SHARE = 5;

const { states } = JSON.parse(await readFile('data/states.json', 'utf8'));
const { parties } = JSON.parse(await readFile('data/parties.json', 'utf8'));
const { nda } = JSON.parse(await readFile('data/alliances.json', 'utf8'));
const repairs = JSON.parse(await readFile('data/repairs.json', 'utf8')).acToPc;
const abbr = (name) => parties[name]?.abbr ?? name;

const ls2024 = latestSnapshot(parseCsv(await readFile(path.resolve('data/raw/ls2024', LS2024_CSV), 'utf8')));
await mkdir(OUT, { recursive: true });

for (const state of states) {
  const pcs = buildPcs(ls2024.filter((r) => r.code === ECI_CODES[state.id]));
  const geo = JSON.parse(await readFile(path.resolve(`public/data/boundaries/${state.id}.geojson`), 'utf8'));
  const { acToPc, issues } = mapAcsToPcs(state, geo.features, pcs);

  const assemblyCsv = path.resolve(`data/raw/results/2022Assembly-${state.id}.csv`);
  let ndaState = null;
  if (await exists(assemblyCsv)) {
    const votes2022 = assemblyVotesByAc(parseCsv(await readFile(assemblyCsv, 'utf8')));
    ndaState = addSwing(state, pcs, acToPc, votes2022);
    if (ndaState.excluded.length) {
      issues.push({
        severity: 'warning',
        code: 'SWING_PARTIAL',
        message: `Swing left out for ${ndaState.excluded.length} Lok Sabha seat(s) whose assembly seats are missing from the boundary data: ${ndaState.excluded.join(', ')}. Statewide NDA shares cover the other ${ndaState.pcsCompared}.`,
      });
    }
  }

  const output = {
    state: state.id,
    source: LS2024_SOURCE,
    swingAvailable: ndaState !== null,
    nda: { members: nda[state.id], ...ndaState },
    summary: summarise(pcs),
    join: { issues },
    acToPc,
    pcs: Object.fromEntries(pcs.map((pc) => [pc.no, pc])),
  };
  await writeFile(path.join(OUT, `${state.id}.json`), JSON.stringify(output));

  const tally = output.summary.map((s) => `${s.party} ${s.seats}`).join(', ');
  const swing = ndaState
    ? ` · NDA ${ndaState.share2022}% → ${ndaState.share2024}% (${ndaState.pcsCompared}/${pcs.length} PCs)`
    : ' · no 2022 assembly data for swing';
  console.log(`OK   ${state.id} ${state.name}: ${pcs.length}/${EXPECTED_PCS[state.id]} PCs · ${tally}${swing} · ${issues.length} join issue(s)`);
}

// The source has one row per candidate per scrape; keep each candidate's latest row.
function latestSnapshot(rows) {
  const latest = new Map();
  for (const r of rows) {
    const key = `${r.s_u}${r.st_code}|${r.pc_no}|${r.candidate_name}|${r.party}`;
    const prev = latest.get(key);
    if (!prev || r.timestamp > prev.timestamp) latest.set(key, r);
  }
  return [...latest.values()].map((r) => ({
    code: `${r.s_u}${r.st_code}`,
    pcNo: Number(r.pc_no),
    pcName: titleCase(r.pc_name),
    candidate: titleCase(r.candidate_name),
    party: abbr(r.party),
    // Uncontested seats (Surat 2024) have "-" for votes.
    votes: Number(r.total_votes) || 0,
  }));
}

function buildPcs(rows) {
  const byPc = new Map();
  for (const r of rows) {
    if (!byPc.has(r.pcNo)) byPc.set(r.pcNo, { no: r.pcNo, name: r.pcName, rows: [] });
    byPc.get(r.pcNo).rows.push(r);
  }
  return [...byPc.values()]
    .sort((a, b) => a.no - b.no)
    .map(({ no, name, rows }) => {
      const total = rows.reduce((n, r) => n + r.votes, 0);
      const ranked = rows.filter((r) => r.party !== 'NOTA').sort((a, b) => b.votes - a.votes);
      const uncontested = total === 0;
      const share = (v) => (total ? round((v / total) * 100, 2) : null);
      const cand = (r) => r && { name: r.candidate, party: r.party, votes: r.votes, share: share(r.votes) };
      const [winner, runnerUp] = ranked;
      const partyVotes = {};
      for (const r of rows) partyVotes[r.party] = (partyVotes[r.party] ?? 0) + r.votes;
      return {
        no,
        name,
        uncontested,
        totalVotes: total,
        winner: cand(winner),
        runnerUp: uncontested ? null : cand(runnerUp),
        margin: uncontested ? null : winner.votes - (runnerUp?.votes ?? 0),
        marginPct: uncontested ? null : share(winner.votes - (runnerUp?.votes ?? 0)),
        candidates: uncontested ? [cand(winner)] : ranked.slice(0, TOP_CANDIDATES).map(cand),
        partyVotes,
        acs: [],
      };
    });
}

// Boundary PC names are upper case and sometimes truncated ("FATEHGARH SAHIB (SC"), so match on
// a normalised name: exact beats prefix (so "FATEHPUR" doesn't land on "Fatehpur Sikri"), and
// prefix beats a close edit-distance match.
function mapAcsToPcs(state, features, pcs) {
  const norm = (s) => String(s ?? '').toUpperCase().replace(/\(.*$/, '').replace(/[^A-Z]/g, '');
  const cache = new Map();
  const findPc = (name) => {
    if (cache.has(name)) return cache.get(name);
    const n = norm(name);
    let best = null;
    let bestScore = 0;
    for (const pc of pcs) {
      const p = norm(pc.name);
      const score =
        n && n === p ? 3 : n && p && (n.startsWith(p) || p.startsWith(n)) ? 2 : similarity(n, p);
      if (score > bestScore) [best, bestScore] = [pc, score];
    }
    const match = bestScore >= PC_NAME_THRESHOLD ? best : null;
    cache.set(name, match);
    return match;
  };

  const acToPc = {};
  const unmatched = new Set();
  const stateRepairs = repairs[state.id] ?? {};
  const repaired = [];
  for (const f of features) {
    const { ac_no, ac_name, pc_name, quality } = f.properties;
    if (quality === 'unidentified') continue;
    const repair = stateRepairs[ac_no];
    const pc = findPc(repair ? repair.pc : pc_name);
    if (repair && acToPc[ac_no] === undefined) repaired.push(`${ac_name} (#${ac_no}) → ${repair.pc}`);
    if (!pc) {
      unmatched.add(pc_name || '(blank)');
      continue;
    }
    if (acToPc[ac_no] === undefined) {
      acToPc[ac_no] = pc.no;
      pc.acs.push(ac_no);
    }
  }

  const issues = [];
  if (repaired.length) {
    issues.push({
      severity: 'info',
      code: 'PC_ASSIGNMENT_REPAIRED',
      message: `${repaired.length} assembly seat(s) were tagged with the wrong Lok Sabha seat in the source and have been corrected: ${repaired.join(', ')}.`,
    });
  }
  if (pcs.length !== EXPECTED_PCS[state.id]) {
    issues.push({
      severity: 'error',
      code: 'PC_COUNT_MISMATCH',
      message: `2024 results cover ${pcs.length} of ${EXPECTED_PCS[state.id]} Lok Sabha seats.`,
    });
  }
  if (unmatched.size) {
    issues.push({
      severity: 'warning',
      code: 'PC_NAME_UNMATCHED',
      message: `${unmatched.size} Lok Sabha name(s) in the boundary data could not be matched to 2024 results: ${[...unmatched].join(', ')}.`,
    });
  }
  const empty = pcs.filter((pc) => pc.acs.length === 0);
  if (empty.length) {
    issues.push({
      severity: 'warning',
      code: 'PC_WITHOUT_ACS',
      message: `${empty.length} Lok Sabha seat(s) have no assembly constituencies mapped to them: ${empty.map((p) => p.name).join(', ')}.`,
    });
  }
  return { acToPc, issues };
}

function assemblyVotesByAc(rows) {
  const byAc = new Map();
  for (const r of rows) {
    const no = Number(r.constituency_no);
    const party = abbr(r.party);
    const votes = Number(r.evm_votes) + Number(r.postal_votes);
    const ac = byAc.get(no) ?? {};
    ac[party] = (ac[party] ?? 0) + votes;
    byAc.set(no, ac);
  }
  return byAc;
}

// Adds party and NDA swing to each PC; returns statewide NDA shares over the PCs that can be
// compared like for like.
//
// When some 2022 seats have no boundary shape, they can't be linked to a PC, so the PCs they
// belong to would compare a partial 2022 electorate with a full 2024 one. Those PCs are the
// ones with fewer ACs than the state's typical PC (seats / PCs); they get no swing and are
// left out of the statewide totals. Uncontested PCs (no 2024 votes) are left out too.
function addSwing(state, pcs, acToPc, votes2022) {
  const members = nda[state.id];
  const ndaShare = (partyVotes, year) => {
    const total = Object.values(partyVotes).reduce((a, b) => a + b, 0);
    const v = members[year].reduce((n, p) => n + (partyVotes[p] ?? 0), 0);
    return total ? round((v / total) * 100, 2) : null;
  };

  const unlinked = [...votes2022.keys()].filter((ac) => acToPc[ac] === undefined).length;
  const typicalSize = Math.round(state.seats / pcs.length);

  const state2022 = {};
  const state2024 = {};
  const excluded = [];
  let pcsCompared = 0;
  for (const pc of pcs) {
    if (unlinked && pc.acs.length < typicalSize) {
      pc.swingIncomplete = true;
      excluded.push(`${pc.name} (${pc.acs.length}/${typicalSize})`);
      continue;
    }
    const agg = {};
    for (const ac of pc.acs) {
      for (const [party, v] of Object.entries(votes2022.get(ac) ?? {})) agg[party] = (agg[party] ?? 0) + v;
    }
    if (pc.uncontested || !Object.keys(agg).length) continue;
    for (const [p, v] of Object.entries(agg)) state2022[p] = (state2022[p] ?? 0) + v;
    for (const [p, v] of Object.entries(pc.partyVotes)) state2024[p] = (state2024[p] ?? 0) + v;
    pcsCompared++;

    const total22 = Object.values(agg).reduce((a, b) => a + b, 0);
    const share22 = (p) => round(((agg[p] ?? 0) / total22) * 100, 2);
    const share24 = (p) => round(((pc.partyVotes[p] ?? 0) / pc.totalVotes) * 100, 2);
    const partiesSeen = new Set([...Object.keys(agg), ...Object.keys(pc.partyVotes)]);
    pc.swing = {
      nda2022: ndaShare(agg, '2022'),
      nda2024: ndaShare(pc.partyVotes, '2024'),
      parties: [...partiesSeen]
        .filter((p) => p !== 'NOTA')
        .map((p) => ({ party: p, share2022: share22(p), share2024: share24(p) }))
        .filter((s) => s.share2022 >= SWING_MIN_SHARE || s.share2024 >= SWING_MIN_SHARE)
        .map((s) => ({ ...s, change: round(s.share2024 - s.share2022, 2) }))
        .sort((a, b) => b.share2024 - a.share2024),
    };
    pc.swing.ndaChange = round(pc.swing.nda2024 - pc.swing.nda2022, 2);
  }
  for (const pc of pcs) {
    // Full 2024 shares (parties >= 0.1%) for the battleground build, which regroups them into
    // the analyst's 2027 blocs.
    pc.shares2024 = pc.totalVotes
      ? Object.fromEntries(
          Object.entries(pc.partyVotes)
            .map(([p, v]) => [p, round((v / pc.totalVotes) * 100, 2)])
            .filter(([, sh]) => sh >= 0.1),
        )
      : {};
    delete pc.partyVotes;
  }

  const share2022 = ndaShare(state2022, '2022');
  const share2024 = ndaShare(state2024, '2024');
  return { share2022, share2024, change: round(share2024 - share2022, 2), pcsCompared, excluded };
}

function summarise(pcs) {
  const seats = new Map();
  for (const pc of pcs) if (pc.winner) seats.set(pc.winner.party, (seats.get(pc.winner.party) ?? 0) + 1);
  return [...seats].map(([party, n]) => ({ party, seats: n })).sort((a, b) => b.seats - a.seats);
}
