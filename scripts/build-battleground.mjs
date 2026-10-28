// Builds the inputs for the battleground view: each seat's 2022 result regrouped into the
// analyst's 2027 blocs (a "notional" result), and the 2022→2024 swing for each bloc.
// The projection itself runs in the browser (src/battleground.ts) so analysts can change
// scenarios live.
//
// Input:  data/analyst/{blocs,scenarios,ratings}.json  (analyst-owned)
//         data/raw/results/2022Assembly-<STATE>.csv
//         public/data/ls2024/<STATE>.json               (build-ls2024)
// Output: public/data/battleground/<STATE>.json
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { exists, parseCsv, round, titleCase } from './lib.mjs';

const OUT = path.resolve('public/data/battleground');
const OTHERS = 'OTH';

const { states } = JSON.parse(await readFile('data/states.json', 'utf8'));
const { parties } = JSON.parse(await readFile('data/parties.json', 'utf8'));
const blocsFile = JSON.parse(await readFile('data/analyst/blocs.json', 'utf8'));
const scenariosFile = JSON.parse(await readFile('data/analyst/scenarios.json', 'utf8'));
const ratingsFile = JSON.parse(await readFile('data/analyst/ratings.json', 'utf8'));
const abbr = (name) => parties[name]?.abbr ?? name;

await mkdir(OUT, { recursive: true });

for (const state of states) {
  const config = blocsFile.states[state.id];
  const csvPath = path.resolve(`data/raw/results/2022Assembly-${state.id}.csv`);
  if (!config || !(await exists(csvPath))) {
    console.log(`SKIP ${state.id} ${state.name}: ${config ? 'no 2022 results' : 'no blocs in data/analyst/blocs.json'}`);
    continue;
  }
  const blocOf = new Map(config.blocs.flatMap((b) => b.parties.map((p) => [p, b.id])));
  const blocIds = config.blocs.map((b) => b.id);
  checkAnalystInputs(state, config, blocIds);

  const ls = JSON.parse(await readFile(path.resolve(`public/data/ls2024/${state.id}.json`), 'utf8'));
  const seats = buildSeats(parseCsv(await readFile(csvPath, 'utf8')), blocOf, blocIds, ls.acToPc);
  const { pcSwing, stateSwing, pcsUsed } = buildSwing(seats, ls, blocOf, blocIds);

  const output = {
    state: state.id,
    confirmed: config.confirmed === true,
    note: config.note ?? null,
    blocs: config.blocs,
    seats,
    pcSwing,
    stateSwing,
    pcsUsed,
    scenarios: scenariosFile.states[state.id] ?? [],
    ratings: ratingsFile.states[state.id] ?? {},
  };
  await writeFile(path.join(OUT, `${state.id}.json`), JSON.stringify(output));

  const held = {};
  for (const s of Object.values(seats)) held[s.holder] = (held[s.holder] ?? 0) + 1;
  const swingText = Object.entries(stateSwing).map(([b, v]) => `${b} ${v > 0 ? '+' : ''}${v}`).join(', ');
  console.log(
    `OK   ${state.id} ${state.name}: ${Object.keys(seats).length} seats · notional 2022 ${fmt(held)} · ` +
      `2024 swing ${swingText} (${pcsUsed}/${Object.keys(ls.pcs).length} PCs)${config.confirmed ? '' : ' · blocs PROVISIONAL'}`,
  );
}

// Per seat: 2022 vote share of each bloc, the strongest candidate outside the blocs (a strong
// independent can still win), and which bloc notionally held the seat.
function buildSeats(rows, blocOf, blocIds, acToPc) {
  const byAc = new Map();
  for (const r of rows) {
    const no = Number(r.constituency_no);
    if (!byAc.has(no)) byAc.set(no, { name: titleCase(r.constituency), cands: [] });
    byAc.get(no).cands.push({ name: titleCase(r.candidate), party: abbr(r.party), votes: Number(r.evm_votes) + Number(r.postal_votes) });
  }
  const seats = {};
  for (const [no, { name, cands }] of [...byAc].sort((a, b) => a[0] - b[0])) {
    const total = cands.reduce((n, c) => n + c.votes, 0);
    const pct = (v) => round((v / total) * 100, 2);
    const shares = Object.fromEntries(blocIds.map((b) => [b, 0]));
    let other = null;
    for (const c of cands) {
      const b = blocOf.get(c.party);
      if (b) shares[b] += c.votes;
      else if (c.party !== 'NOTA' && (!other || c.votes > other.votes)) other = c;
    }
    for (const b of blocIds) shares[b] = pct(shares[b]);
    const winner = cands.filter((c) => c.party !== 'NOTA').sort((a, b) => b.votes - a.votes)[0];
    seats[no] = {
      name,
      pc: acToPc[no] ?? null,
      shares,
      other: other ? { name: other.name, party: other.party, share: pct(other.votes) } : null,
      // The bloc that notionally held the seat in 2022, under 2027 alignments.
      holder: blocOf.get(winner.party) ?? OTHERS,
      winner2022: { name: winner.name, party: winner.party },
    };
  }
  return seats;
}

// Bloc swing per Lok Sabha seat: 2024 bloc share minus the 2022 bloc share of its assembly
// seats combined. Seats in PCs without a usable swing (uncontested, or missing boundary data)
// fall back to the statewide swing, which is computed over the usable PCs only.
function buildSwing(seats, ls, blocOf, blocIds) {
  const pcSwing = {};
  const totals22 = Object.fromEntries(blocIds.map((b) => [b, 0]));
  const totals24 = Object.fromEntries(blocIds.map((b) => [b, 0]));
  let weight = 0;
  let pcsUsed = 0;

  for (const pc of Object.values(ls.pcs)) {
    if (pc.uncontested || pc.swingIncomplete || !pc.acs.length) continue;
    const acSeats = pc.acs.map((ac) => seats[ac]).filter(Boolean);
    if (acSeats.length !== pc.acs.length) continue;

    // 2022 shares are per seat; weight them equally (seat electorates are similar within a PC).
    const share22 = Object.fromEntries(
      blocIds.map((b) => [b, acSeats.reduce((n, s) => n + s.shares[b], 0) / acSeats.length]),
    );
    const share24 = Object.fromEntries(blocIds.map((b) => [b, 0]));
    for (const [party, sh] of Object.entries(pc.shares2024 ?? {})) {
      const b = blocOf.get(party);
      if (b) share24[b] += sh;
    }
    pcSwing[pc.no] = Object.fromEntries(blocIds.map((b) => [b, round(share24[b] - share22[b], 2)]));

    for (const b of blocIds) {
      totals22[b] += share22[b] * pc.totalVotes;
      totals24[b] += share24[b] * pc.totalVotes;
    }
    weight += pc.totalVotes;
    pcsUsed++;
  }
  const stateSwing = Object.fromEntries(
    blocIds.map((b) => [b, weight ? round((totals24[b] - totals22[b]) / weight, 2) : 0]),
  );
  return { pcSwing, stateSwing, pcsUsed };
}

// Fail the build on analyst inputs that reference blocs or ratings that don't exist, so a typo
// can't silently change a projection.
function checkAnalystInputs(state, config, blocIds) {
  const problems = [];
  const seen = new Set();
  for (const b of config.blocs) {
    for (const p of b.parties) {
      if (seen.has(p)) problems.push(`party ${p} is in more than one bloc`);
      seen.add(p);
    }
  }
  for (const sc of scenariosFile.states[state.id] ?? []) {
    for (const b of Object.keys(sc.swing ?? {})) {
      if (!blocIds.includes(b)) problems.push(`scenario "${sc.name}" uses unknown bloc ${b}`);
    }
  }
  for (const [ac, r] of Object.entries(ratingsFile.states[state.id] ?? {})) {
    if (!['safe', 'likely', 'lean', 'tossup'].includes(r.rating)) problems.push(`rating for seat ${ac} is "${r.rating}"`);
    if (r.rating !== 'tossup' && !blocIds.includes(r.bloc)) problems.push(`rating for seat ${ac} needs a valid bloc`);
    if (!(Number(ac) >= 1 && Number(ac) <= state.seats)) problems.push(`rating for unknown seat ${ac}`);
  }
  if (problems.length) {
    throw new Error(`Analyst inputs for ${state.id} are invalid:\n  - ${problems.join('\n  - ')}`);
  }
}

function fmt(counts) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
}
