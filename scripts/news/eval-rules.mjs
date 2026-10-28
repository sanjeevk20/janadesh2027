// Measures the keyword tagger against the hand-labelled stories in data/news/eval.json and,
// for comparison, the tags those stories currently have in data/news/items.json.
//
// Usage: npm run news:eval [-- --verbose]
import { readFile } from 'node:fs/promises';
import { loadGazetteer } from './gazetteer.mjs';
import { loadRules, tagByRules } from './rules.mjs';

// eval.json was used while writing the cues (tuning set); eval-holdout.json was not, so its
// scores are the honest estimate. Add new examples to eval.json; keep the holdout untouched.
const SETS = [
  ['tuning', 'data/news/eval.json'],
  ['held-out', 'data/news/eval-holdout.json'],
];
const verbose = process.argv.includes('--verbose');
const stored = new Map(JSON.parse(await readFile('data/news/items.json', 'utf8')).map((i) => [i.id, i.tags]));
const rules = await loadRules();
const gazetteer = await loadGazetteer();

const row = (name, s) =>
  `  ${name.padEnd(18)} relevance ${pct(s.relevance)}   states exact ${pct(s.statesExact)}   ` +
  `state P/R ${pct(s.precision)}/${pct(s.recall)}   topic ${pct(s.topic)}   wrong-state places ${s.wrongPlaces}`;

for (const [setName, file] of SETS) {
  const { items: labelled } = JSON.parse(await readFile(file, 'utf8'));
  const before = labelled.map((l) => [l, stored.get(l.id)]).filter(([, t]) => t?.version < 4);
  const candidate = score(
    labelled.map((l) => {
      const text = [l.title, l.summary].filter(Boolean).join('. ');
      return [l, tagByRules(rules, gazetteer, l.title, text)];
    }),
  );
  console.log(`${setName}: ${labelled.length} stories (${labelled.filter((l) => l.expected.relevant).length} relevant), ${file}`);
  if (before.length === labelled.length) console.log(row('previous tags', score(before)));
  console.log(row('rules (cues file)', candidate));
  if (verbose) for (const m of candidate.misses) console.log(`    miss: ${m}`);
  console.log();
}

function score(pairs) {
  let relevanceOk = 0;
  let statesExact = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let topicOk = 0;
  let topicN = 0;
  let wrongPlaces = 0;
  const misses = [];
  for (const [l, t] of pairs) {
    const e = l.expected;
    const problems = [];
    if (t.relevant === e.relevant) relevanceOk++;
    else problems.push(`relevant=${t.relevant}${t.reason ? ` (${t.reason})` : ''}`);

    if (e.relevant) {
      const got = new Set(t.states);
      const want = new Set(e.states);
      const tpHere = [...got].filter((s) => want.has(s)).length;
      tp += tpHere;
      fp += got.size - tpHere;
      fn += want.size - tpHere;
      if (got.size === want.size && tpHere === want.size) statesExact++;
      else problems.push(`states=${[...got].join(',') || '-'} want ${e.states.join(',')}`);

      topicN++;
      if (e.topics.includes(t.topic)) topicOk++;
      else problems.push(`topic=${t.topic} want ${e.topics.join('|')}`);

      wrongPlaces += t.places.filter((p) => !want.has(p.state)).length;
    }
    if (problems.length) misses.push(`${l.title.slice(0, 80)} — ${problems.join('; ')}`);
  }
  const relevantN = pairs.filter(([l]) => l.expected.relevant).length;
  return {
    relevance: relevanceOk / pairs.length,
    statesExact: statesExact / relevantN,
    precision: tp / (tp + fp || 1),
    recall: tp / (tp + fn || 1),
    topic: topicOk / (topicN || 1),
    wrongPlaces,
    misses,
  };
}

function pct(x) {
  return `${Math.round(x * 100)}%`.padStart(4);
}
