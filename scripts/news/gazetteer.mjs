// Place-name gazetteer for the 2027 election states, built from the boundary data and the
// 2022 results, plus a matcher that finds those places in news text.
//
// Matching is deliberately conservative: a false constituency tag on a news story is worse
// than a missing one, so ambiguous names are only accepted with supporting context.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { exists, titleCase, RESERVATION_TAG } from '../lib.mjs';

// Words that appear in constituency names but are too generic to identify a place alone.
const GENERIC = new Set([
  'SADAR', 'NAGAR', 'RURAL', 'CANTT', 'CANTONMENT', 'NORTH', 'SOUTH', 'EAST', 'WEST', 'CENTRAL',
  'CITY', 'DEHAT', 'URBAN', 'GRAMIN', 'BAZAR', 'GANJ', 'PUR',
]);
// Common English words that are also constituency names in these states.
const STOPWORDS = new Set(['COLONY', 'MALL', 'PORT', 'BAY', 'CAMP', 'SECTOR', 'MAIN']);
const MIN_NAME_LENGTH = 4;
// Short forms used in headlines. ("UP" is left out: it collides with the English word.)
const STATE_ALIASES = {
  HP: ['HIMACHAL'],
  UK: ['UTTARANCHAL'],
};
// Words near an AC name that signal the text means the assembly seat, not the town.
const SEAT_CONTEXT = /\b(seat|constituency|assembly|mla|vidhan sabha|segment|bypoll|by-election)\b/i;

export async function loadGazetteer() {
  const { states } = JSON.parse(await readFile('data/states.json', 'utf8'));
  const entries = [];

  for (const state of states) {
    const geo = JSON.parse(await readFile(path.resolve(`public/data/boundaries/${state.id}.geojson`), 'utf8'));
    const resultsPath = path.resolve(`public/data/results/2022-${state.id}.json`);
    const results = (await exists(resultsPath)) ? JSON.parse(await readFile(resultsPath, 'utf8')).seats : {};

    const districts = new Map();
    for (const f of geo.features) {
      const p = f.properties;
      if (p.quality === 'unidentified') continue;
      // Results names are usually the cleaner spelling; keep both as aliases.
      const names = new Set([cleanName(p.ac_name), cleanName(results[p.ac_no]?.name)].filter(Boolean));
      for (const name of names) {
        entries.push({ kind: 'ac', state: state.id, name, display: results[p.ac_no]?.name ?? titleCase(name), ac: p.ac_no });
      }
      const district = cleanName(p.district);
      if (district) {
        if (!districts.has(district)) districts.set(district, []);
        districts.get(district).push(p.ac_no);
      }
    }
    for (const [name, acs] of districts) {
      entries.push({ kind: 'district', state: state.id, name, display: titleCase(name), acs: [...new Set(acs)] });
    }
    for (const name of [state.name, ...(STATE_ALIASES[state.id] ?? [])]) {
      entries.push({ kind: 'state', state: state.id, name: cleanName(name), display: state.name });
    }
  }

  // Names used in more than one state can't be resolved without the state in the text.
  const statesByName = new Map();
  for (const e of entries) {
    if (!statesByName.has(e.name)) statesByName.set(e.name, new Set());
    statesByName.get(e.name).add(e.state);
  }
  for (const e of entries) e.multiState = statesByName.get(e.name).size > 1;

  return entries.filter((e) => e.kind === 'state' || isDistinctive(e.name));
}

export function cleanName(name) {
  if (!name) return '';
  return String(name)
    .toUpperCase()
    .replace(RESERVATION_TAG, ' ')
    .replace(/\*/g, ' ')
    .replace(/[^A-Z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDistinctive(name) {
  if (name.length < MIN_NAME_LENGTH) return false;
  const words = name.split(' ');
  if (words.every((w) => GENERIC.has(w))) return false;
  if (words.length === 1 && STOPWORDS.has(name)) return false;
  return true;
}

// Returns the places mentioned in `text`, each with a confidence and the reason for it.
export function matchPlaces(gazetteer, text) {
  const upper = ` ${cleanName(text)} `;
  const statesMentioned = new Set(
    gazetteer.filter((e) => e.kind === 'state' && upper.includes(` ${e.name} `)).map((e) => e.state),
  );

  const hits = [];
  for (const e of gazetteer) {
    if (e.kind === 'state' || !upper.includes(` ${e.name} `)) continue;
    let confidence = 'high';
    let reason = `${e.kind} name matched`;
    if (e.multiState && !statesMentioned.has(e.state)) {
      confidence = 'low';
      reason = `name exists in several states; ${e.state} not mentioned`;
    } else if (e.kind === 'ac' && !SEAT_CONTEXT.test(text) && gazetteer.some((d) => d.kind === 'district' && d.name === e.name)) {
      // "Sangrur" alone usually means the town/district, not the assembly seat.
      confidence = 'medium';
      reason = 'name is also a district; no seat context';
    }
    hits.push({ ...e, confidence, reason });
  }

  // Keep one hit per place; prefer the more confident one.
  const rank = { high: 3, medium: 2, low: 1 };
  const best = new Map();
  for (const h of hits) {
    const key = `${h.state}|${h.kind}|${h.ac ?? h.name}`;
    if (!best.has(key) || rank[h.confidence] > rank[best.get(key).confidence]) best.set(key, h);
  }
  return { states: [...statesMentioned], places: [...best.values()] };
}
