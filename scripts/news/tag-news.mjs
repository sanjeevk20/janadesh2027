// Tags each news story with states, constituencies, parties and a topic, then publishes
// public/data/news.json for the site.
//
// Two stages:
//   1. Gazetteer: deterministic place matching against the boundary/results names.
//   2. Claude (only when credentials are available): reads the story, returns structured
//      tags, and its constituency names are checked against the gazetteer. Names that
//      don't resolve to a real seat are rejected and recorded, never shown as tags.
// Without credentials, stage 2 is replaced by keyword rules and items are marked
// `tagger: "rules"`, so the site always has something to show.
import { readFile, writeFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { loadGazetteer, matchPlaces, cleanName } from './gazetteer.mjs';
import { similarity } from '../lib.mjs';

const STORE = 'data/news/items.json';
const OUT = 'public/data/news.json';
// Bump when tagging logic changes so existing items are re-tagged.
const TAGGER_VERSION = 3;
const MODEL = 'claude-opus-5-5';
const PUBLISH_DAYS = 180;
const RESOLVE_THRESHOLD = 0.85;

const STATE_IDS = ['UP', 'PB', 'UK', 'GA', 'MN', 'GJ', 'HP'];
const TOPICS = ['schedule', 'alliances', 'candidates', 'campaign', 'polls', 'defections', 'governance', 'security', 'legal', 'other'];

// Fallback tagging when Claude isn't available.
const PARTY_PATTERNS = [
  ['BJP', /\bBJP\b|Bharatiya Janata/i],
  ['INC', /\bCongress\b|\bINC\b/i],
  ['SP', /\bSP\b|Samajwadi/i],
  ['AAP', /\bAAP\b|Aam Aadmi/i],
  ['BSP', /\bBSP\b|Bahujan Samaj/i],
  ['SAD', /\bSAD\b|Akali/i],
  ['RLD', /\bRLD\b|Rashtriya Lok Dal/i],
  ['NISHAD', /Nishad Party/i],
  ['NPP', /\bNPP\b|National People's Party/i],
  ['NPF', /\bNPF\b|Naga People/i],
  ['MGP', /\bMGP\b|Gomantak/i],
];

const TOPIC_RULES = [
  ['alliances', /alliance|seat[- ]sharing|\bNDA\b|\bINDIA bloc\b|ally|allies/i],
  ['schedule', /schedule|poll dates?|phase|election commission|\bECI\b|term (ends|expires)/i],
  ['polls', /opinion polls?|exit polls?|pre-poll survey/i],
  ['defections', /joins?|defect|quits?|switch(es|ed)? (sides|party)/i],
  ['candidates', /candidate|ticket|nominat/i],
  ['security', /terror|unrest|violence|security|clash|ISI\b/i],
  ['legal', /court|petition|\bFIR\b|case filed/i],
  ['campaign', /rally|campaign|yatra|roadshow|launch(es|ed)? (a )?(new )?party|claims?/i],
];

const TagSchema = z.object({
  relevant: z.boolean().describe('True if the story is about politics or elections in one of the listed states.'),
  states: z.array(z.enum(STATE_IDS)).describe('States the story is about.'),
  constituencies: z
    .array(z.object({ state: z.enum(STATE_IDS), name: z.string() }))
    .describe('Assembly constituencies explicitly named in the story, spelled as in the story. Empty if none are named.'),
  parties: z.array(z.string()).describe('Parties involved, as common abbreviations (BJP, SP, INC, AAP, ...).'),
  topic: z.enum(TOPICS),
  summary: z.string().describe('One neutral sentence, at most 30 words.'),
  claims: z
    .array(
      z.object({
        text: z.string(),
        kind: z.enum(['fact', 'allegation', 'projection', 'opinion']),
        checkable: z.boolean().describe('True if it could be checked against an official source.'),
      }),
    )
    .describe('Up to 3 key claims made in the story.'),
});

const SYSTEM = `You tag Indian political news for an election tracker covering the 2027 assembly elections in Uttar Pradesh (UP), Punjab (PB), Uttarakhand (UK), Goa (GA), Manipur (MN), Gujarat (GJ) and Himachal Pradesh (HP).

Work only from the story text you are given; you only see a headline and a short summary, so do not add facts from memory. List a constituency only when the text names it; a district or city that is not named as a seat is not a constituency. Candidate places found by a gazetteer are listed with the story as hints and may be wrong (for example, a town that shares a seat's name). Classify each claim by how it is presented in the story: a reported official decision is a fact, an accusation is an allegation, a forecast or seat target is a projection.`;

const client = await makeClient();
const gazetteer = await loadGazetteer();
const items = JSON.parse(await readFile(STORE, 'utf8'));

let tagged = 0;
let llmCalls = 0;
let rejected = 0;
for (const item of items) {
  if (item.tags?.version === TAGGER_VERSION && (item.tags.tagger === 'claude' || !client)) continue;
  const text = [item.title, item.summary].filter(Boolean).join('. ');
  const gaz = matchPlaces(gazetteer, text);

  let llm = null;
  if (client) {
    try {
      llm = await tagWithClaude(item, gaz);
      llmCalls++;
    } catch (err) {
      console.warn(`WARN ${item.id}: Claude tagging failed (${err.message}); using rules`);
    }
  }
  item.tags = merge(text, gaz, llm);
  rejected += item.tags.rejected.length;
  tagged++;
}

await writeFile(STORE, JSON.stringify(items, null, 2) + '\n');
await publish(items);
console.log(
  `Tagged ${tagged} item(s) (${llmCalls} with Claude${client ? '' : ': no credentials, rules only'}); ` +
    `${rejected} unverifiable constituency tag(s) rejected.`,
);

async function makeClient() {
  // The SDK also resolves ANTHROPIC_AUTH_TOKEN and `ant auth login` profiles; only skip Claude
  // when nothing is configured at all.
  if (process.env.NEWS_TAGGER === 'rules') return null;
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_PROFILE) return null;
  return new Anthropic();
}

async function tagWithClaude(item, gaz) {
  const hints = gaz.places.length
    ? gaz.places.map((p) => `- ${p.kind} "${p.display}" in ${p.state} (${p.confidence}: ${p.reason})`).join('\n')
    : '- none';
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: betaZodOutputFormat(TagSchema) },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Headline: ${item.title}\nPublisher: ${item.source ?? 'unknown'}\nPublished: ${item.published ?? 'unknown'}\nSummary: ${item.summary ?? '(none)'}\n\nGazetteer candidates:\n${hints}`,
      },
    ],
  });
  if (response.stop_reason === 'refusal') throw new Error('request declined');
  if (!response.parsed_output) throw new Error(`no parsed output (stop_reason ${response.stop_reason})`);
  return response.parsed_output;
}

// Resolves a constituency name from Claude to a gazetteer seat in the same state.
function resolveAc(state, name) {
  const n = cleanName(name);
  let best = null;
  let bestScore = 0;
  for (const e of gazetteer) {
    if (e.kind !== 'ac' || e.state !== state) continue;
    const score = e.name === n ? 1 : similarity(e.name.replace(/ /g, ''), n.replace(/ /g, ''));
    if (score > bestScore) [best, bestScore] = [e, score];
  }
  return bestScore >= RESOLVE_THRESHOLD ? best : null;
}

function merge(text, gaz, llm) {
  const places = new Map();
  const add = (e, confidence, via) => {
    const key = `${e.state}|${e.kind}|${e.ac ?? e.name}`;
    const prev = places.get(key);
    if (prev) {
      prev.via = [...new Set([...prev.via, via])];
      prev.confidence = 'high';
    } else {
      places.set(key, { kind: e.kind, state: e.state, name: e.display, ac: e.ac, acs: e.acs, confidence, via: [via] });
    }
  };

  // Low-confidence gazetteer hits are kept only if Claude independently names the seat.
  for (const p of gaz.places) if (p.confidence !== 'low') add(p, p.confidence, 'gazetteer');

  const rejectedNames = [];
  if (llm) {
    for (const c of llm.constituencies) {
      const e = resolveAc(c.state, c.name);
      if (e) add({ ...e }, 'medium', 'claude');
      else rejectedNames.push(`${c.name} (${c.state})`);
    }
  }

  const states = new Set([...gaz.states, ...(llm?.states ?? []), ...[...places.values()].map((p) => p.state)]);
  return {
    version: TAGGER_VERSION,
    tagger: llm ? 'claude' : 'rules',
    relevant: llm ? llm.relevant : states.size > 0,
    states: [...states].filter((s) => STATE_IDS.includes(s)),
    places: [...places.values()],
    parties: llm ? llm.parties : partiesByRule(text),
    topic: llm ? llm.topic : topicByRule(text),
    summary: llm?.summary ?? null,
    claims: llm?.claims ?? [],
    rejected: rejectedNames,
  };
}

function partiesByRule(text) {
  return PARTY_PATTERNS.filter(([, re]) => re.test(text)).map(([p]) => p);
}

function topicByRule(text) {
  return TOPIC_RULES.find(([, re]) => re.test(text))?.[0] ?? 'other';
}

async function publish(all) {
  const cutoff = Date.now() - PUBLISH_DAYS * 86_400_000;
  const dateOf = (i) => Date.parse(i.published ?? i.collectedAt);
  const published = all
    .filter((i) => i.tags?.relevant && dateOf(i) >= cutoff)
    // Newest first; stories without a publish date go last rather than taking their collection date.
    .sort((a, b) => (b.published ? Date.parse(b.published) : 0) - (a.published ? Date.parse(a.published) : 0))
    .map(({ id, url, title, source, published, collectedAt, collectedBy, tags }) => ({
      id,
      url,
      title,
      source,
      published,
      collectedAt,
      collectedBy,
      tagger: tags.tagger,
      states: tags.states,
      places: tags.places.map(({ kind, state, name, ac, acs, confidence, via }) => ({ kind, state, name, ac, acs, confidence, via })),
      parties: tags.parties,
      topic: tags.topic,
      summary: tags.summary,
      claims: tags.claims,
    }));
  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), items: published }));
}
