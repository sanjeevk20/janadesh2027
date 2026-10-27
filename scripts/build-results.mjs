// Builds per-constituency 2022 results and checks that they join cleanly onto the
// boundary shapes (same constituency number, matching name).
//
// Input:  data/raw/results/2022Assembly-<STATE>.csv  (run `npm run data:fetch` first)
//         public/data/boundaries/<STATE>.geojson     (run build-boundaries first)
//         data/states.json, data/parties.json
// Output: public/data/results/2022-<STATE>.json
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { RESULTS_SOURCE } from './fetch-results.mjs';

const RAW = path.resolve('data/raw/results');
const OUT = path.resolve('public/data/results');
const TOP_CANDIDATES = 5;
// Names whose normalised similarity falls below this are reported as join mismatches.
const NAME_SIMILARITY_THRESHOLD = 0.75;

const { states } = JSON.parse(await readFile('data/states.json', 'utf8'));
const { parties } = JSON.parse(await readFile('data/parties.json', 'utf8'));
await mkdir(OUT, { recursive: true });

for (const state of states) {
  const csvPath = path.join(RAW, `2022Assembly-${state.id}.csv`);
  if (!(await exists(csvPath))) {
    console.log(`SKIP ${state.id} ${state.name}: no 2022 results file (${path.relative(process.cwd(), csvPath)})`);
    continue;
  }

  const rows = parseCsv(await readFile(csvPath, 'utf8'));
  const byAc = new Map();
  for (const r of rows) {
    const no = Number(r.constituency_no);
    if (!byAc.has(no)) byAc.set(no, { no, name: titleCase(r.constituency), candidates: [] });
    byAc.get(no).candidates.push({
      name: titleCase(r.candidate),
      party: partyAbbr(r.party),
      votes: Number(r.evm_votes) + Number(r.postal_votes),
    });
  }

  const seats = {};
  const tally = new Map();
  let stateVotes = 0;
  for (const ac of [...byAc.values()].sort((a, b) => a.no - b.no)) {
    const total = ac.candidates.reduce((n, c) => n + c.votes, 0);
    const ranked = ac.candidates.filter((c) => c.party !== 'NOTA').sort((a, b) => b.votes - a.votes);
    const nota = ac.candidates.find((c) => c.party === 'NOTA')?.votes ?? 0;
    const [winner, runnerUp] = ranked;
    const share = (v) => round((v / total) * 100, 2);

    seats[ac.no] = {
      no: ac.no,
      name: ac.name,
      totalVotes: total,
      winner: { ...winner, share: share(winner.votes) },
      runnerUp: runnerUp ? { ...runnerUp, share: share(runnerUp.votes) } : null,
      margin: winner.votes - (runnerUp?.votes ?? 0),
      marginPct: share(winner.votes - (runnerUp?.votes ?? 0)),
      nota,
      candidates: ranked.slice(0, TOP_CANDIDATES).map((c) => ({ ...c, share: share(c.votes) })),
      contestants: ranked.length,
    };

    stateVotes += total;
    for (const c of ac.candidates) {
      const t = tally.get(c.party) ?? { party: c.party, seats: 0, votes: 0 };
      t.votes += c.votes;
      tally.set(c.party, t);
    }
    tally.get(winner.party).seats += 1;
  }

  const summary = [...tally.values()]
    .map((t) => ({ ...t, voteShare: round((t.votes / stateVotes) * 100, 2) }))
    .sort((a, b) => b.seats - a.seats || b.votes - a.votes);

  const join = await checkJoin(state, seats);
  const output = {
    state: state.id,
    year: 2022,
    source: RESULTS_SOURCE,
    totalVotes: stateVotes,
    summary,
    join,
    seats,
  };
  await writeFile(path.join(OUT, `2022-${state.id}.json`), JSON.stringify(output));

  const top = summary.filter((s) => s.seats).map((s) => `${s.party} ${s.seats}`).join(', ');
  const joinNote = join.issues.length ? `${join.issues.length} join issue(s)` : 'joins cleanly';
  console.log(`OK   ${state.id} ${state.name}: ${Object.keys(seats).length}/${state.seats} seats · ${top} · ${joinNote}`);
}

// Compares each result's constituency number and name with the boundary shape of the same number.
async function checkJoin(state, seats) {
  const geo = JSON.parse(await readFile(path.resolve(`public/data/boundaries/${state.id}.geojson`), 'utf8'));
  const shapesByNo = new Map();
  for (const f of geo.features) {
    const list = shapesByNo.get(f.properties.ac_no) ?? [];
    list.push(f.properties.ac_name);
    shapesByNo.set(f.properties.ac_no, list);
  }

  const noShape = [];
  const nameMismatch = [];
  for (const s of Object.values(seats)) {
    const shapeNames = shapesByNo.get(s.no);
    if (!shapeNames) {
      noShape.push(s.no);
      continue;
    }
    const best = Math.max(...shapeNames.map((n) => similarity(normalise(n), normalise(s.name))));
    if (best < NAME_SIMILARITY_THRESHOLD) {
      nameMismatch.push({ no: s.no, results: s.name, boundary: shapeNames.filter(Boolean).join(' / ') || null });
    }
  }

  const issues = [];
  const missingResults = state.seats - Object.keys(seats).length;
  if (missingResults) {
    issues.push({
      severity: 'error',
      code: 'RESULTS_INCOMPLETE',
      message: `Results cover ${Object.keys(seats).length} of ${state.seats} seats.`,
    });
  }
  if (noShape.length) {
    issues.push({
      severity: 'error',
      code: 'RESULT_WITHOUT_SHAPE',
      message: `${noShape.length} seat result(s) have no boundary shape to attach to.`,
      values: noShape,
    });
  }
  if (nameMismatch.length) {
    issues.push({
      severity: 'warning',
      code: 'NAME_MISMATCH',
      message: `${nameMismatch.length} seat(s) have a different name in the results than in the boundary data, so the shape may not be the right constituency.`,
      values: nameMismatch.map((m) => m.no),
      examples: nameMismatch.slice(0, 8),
    });
  }
  return { issues };
}

function normalise(name) {
  return String(name ?? '')
    .toUpperCase()
    .replace(/\(.*?\)/g, '')
    .replace(/[^A-Z]/g, '');
}

// Levenshtein-based similarity in [0, 1].
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

function partyAbbr(name) {
  return parties[name]?.abbr ?? name;
}

function titleCase(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/(^|[\s.(-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// Minimal RFC 4180 parser: handles quoted fields with commas and escaped quotes.
function parseCsv(text) {
  const records = [];
  let field = '';
  let record = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      field = '';
      if (record.some((v) => v !== '')) records.push(record);
      record = [];
    } else field += ch;
  }
  if (field || record.length) {
    record.push(field);
    records.push(record);
  }
  const [header, ...rows] = records;
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i]?.trim() ?? ''])));
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
