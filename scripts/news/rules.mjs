// Keyword tagger for news stories, used when no AI tagger is configured. All domain knowledge
// (leader names, state nicknames, topic keywords, reference-page patterns) lives in the
// analyst-owned data/analyst/news-cues.json; this file only applies it.
//
// Measured against data/news/eval.json by eval-rules.mjs (`npm run news:eval`).
import { readFile } from 'node:fs/promises';
import { matchPlaces } from './gazetteer.mjs';

export const STATE_IDS = ['UP', 'PB', 'UK', 'GA', 'MN', 'GJ', 'HP'];
export const TOPICS = [
  'schedule',
  'alliances',
  'candidates',
  'campaign',
  'polls',
  'other_polls',
  'defections',
  'governance',
  'security',
  'legal',
  'analysis',
  'other',
];

export async function loadRules(file = 'data/analyst/news-cues.json') {
  const cues = JSON.parse(await readFile(file, 'utf8'));
  const re = (src, flags = 'i') => {
    try {
      return new RegExp(src, flags);
    } catch (err) {
      throw new Error(`Invalid pattern in ${file}: ${src} (${err.message})`);
    }
  };

  const stateCues = Object.entries(cues.stateCues).map(([state, c]) => {
    if (!STATE_IDS.includes(state)) throw new Error(`Unknown state ${state} in ${file}`);
    return [state, [...(c.patterns ?? []).map((p) => re(p)), ...(c.caseSensitive ?? []).map((p) => re(p, ''))]];
  });
  const topicRules = cues.topicRules.rules.map(([topic, pattern]) => {
    if (!TOPICS.includes(topic)) throw new Error(`Unknown topic ${topic} in ${file}`);
    return [topic, re(pattern)];
  });

  return {
    stateCues,
    multiStateCues: (cues.multiStateCues ?? []).map((m) => ({
      pattern: re(m.pattern),
      requires: m.requires ? re(m.requires) : null,
      states: m.states,
    })),
    ambiguous: new Set((cues.ambiguousPlaceNames?.names ?? []).map((n) => n.toUpperCase())),
    reference: (cues.referencePatterns?.patterns ?? []).map((p) => re(p)),
    topicRules,
    parties: [
      ...Object.entries(cues.partyCues ?? {}).map(([p, src]) => [p, re(src)]),
      ...Object.entries(cues.partyCuesCaseSensitive ?? {}).map(([p, src]) => [p, re(src, '')]),
    ],
  };
}

// Tags one story. `title` is matched separately for reference-page patterns; `text` is the
// title plus summary.
export function tagByRules(rules, gazetteer, title, text) {
  const reference = rules.reference.some((r) => r.test(title));

  // States the story is about: names and cues first.
  const gaz = matchPlaces(gazetteer, text);
  const states = new Set(gaz.states);
  for (const [state, patterns] of rules.stateCues) if (patterns.some((p) => p.test(text))) states.add(state);
  for (const m of rules.multiStateCues) {
    if (m.pattern.test(text) && (!m.requires || m.requires.test(text))) m.states.forEach((s) => states.add(s));
  }

  // Places: with a known state, keep only places in it, so a surname like "Anand" in a UP story
  // doesn't tag Gujarat. With no state known, accept places only if they all point to one state
  // and none is an ambiguous name; the place then decides the state.
  let places = gaz.places.filter((p) => p.confidence !== 'low');
  if (states.size) {
    places = places.filter((p) => states.has(p.state));
  } else {
    const placeStates = new Set(places.map((p) => p.state));
    const ambiguous = places.some((p) => rules.ambiguous.has(p.name));
    places = placeStates.size === 1 && !ambiguous ? places : [];
    places.forEach((p) => states.add(p.state));
  }

  const topic = rules.topicRules.find(([, re]) => re.test(text))?.[0] ?? 'other';
  return {
    relevant: !reference && states.size > 0,
    reason: reference ? 'reference page' : states.size ? null : 'no state identified',
    states: STATE_IDS.filter((s) => states.has(s)),
    places,
    parties: rules.parties.filter(([, re]) => re.test(text)).map(([p]) => p),
    topic,
  };
}
