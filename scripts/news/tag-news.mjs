// Tags each news story with states, constituencies, parties and a topic, then publishes
// public/data/news.json for the site.
//
// Two stages:
//   1. Gazetteer: deterministic place matching against the boundary/results names.
//   2. Claude (only when credentials are available): reads the story, returns structured
//      tags, and its constituency names are checked against the gazetteer. Names that
//      don't resolve to a real seat are rejected and recorded, never shown as tags.
// Without credentials, stage 2 is replaced by the keyword rules in rules.mjs (cues in the
// analyst-owned data/analyst/news-cues.json) and items are marked `tagger: "rules"`.
// Either way, places are only kept for states the story is about, and reference pages
// (seat profiles, old results) are archived but not published.
import { readFile, writeFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { loadGazetteer, cleanName } from './gazetteer.mjs';
import { loadRules, tagByRules, STATE_IDS, TOPICS, TAGGER_VERSION } from './rules.mjs';
import { similarity } from '../lib.mjs';

const STORE = 'data/news/items.json';
const OUT = 'public/data/news.json';
const MODEL = 'claude-opus-5-5';
const PUBLISH_DAYS = 180;
const RESOLVE_THRESHOLD = 0.85;

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
const rules = await loadRules();
const items = JSON.parse(await readFile(STORE, 'utf8'));

let tagged = 0;
let llmCalls = 0;
let rejected = 0;
for (const item of items) {
  // Community tips keep their moderator-approved tags.
  if (item.tags?.tagger === 'crowd') continue;
  if (item.tags?.version === TAGGER_VERSION && (item.tags.tagger === 'claude' || !client)) continue;
  const text = [item.title, item.summary].filter(Boolean).join('. ');
  const ruleTags = tagByRules(rules, gazetteer, item.title, text);

  let llm = null;
  if (client && !ruleTags.reason?.startsWith('reference')) {
    try {
      llm = await tagWithClaude(item, ruleTags);
      llmCalls++;
    } catch (err) {
      console.warn(`WARN ${item.id}: Claude tagging failed (${err.message}); using rules`);
    }
  }
  item.tags = merge(ruleTags, llm);
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

async function tagWithClaude(item, ruleTags) {
  const hints = ruleTags.places.length
    ? ruleTags.places.map((p) => `- ${p.kind} "${p.display}" in ${p.state} (${p.confidence}: ${p.reason})`).join('\n')
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

function merge(ruleTags, llm) {
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

  // Rule places are already limited to the story's states and exclude low-confidence hits.
  for (const p of ruleTags.places) add(p, p.confidence, 'gazetteer');

  const rejectedNames = [];
  if (llm) {
    for (const c of llm.constituencies) {
      const e = resolveAc(c.state, c.name);
      if (e) add({ ...e }, 'medium', 'claude');
      else rejectedNames.push(`${c.name} (${c.state})`);
    }
  }

  const states = new Set([...ruleTags.states, ...(llm?.states ?? []), ...[...places.values()].map((p) => p.state)]);
  const reference = ruleTags.reason === 'reference page';
  return {
    version: TAGGER_VERSION,
    tagger: llm ? 'claude' : 'rules',
    relevant: !reference && (llm ? llm.relevant : ruleTags.relevant),
    reason: reference ? 'reference page' : llm ? null : ruleTags.reason,
    states: STATE_IDS.filter((s) => states.has(s)),
    places: [...places.values()],
    parties: llm ? llm.parties : ruleTags.parties,
    topic: llm ? llm.topic : ruleTags.topic,
    summary: llm?.summary ?? null,
    claims: llm?.claims ?? [],
    rejected: rejectedNames,
  };
}

async function publish(all) {
  const cutoff = Date.now() - PUBLISH_DAYS * 86_400_000;
  const dateOf = (i) => Date.parse(i.published ?? i.collectedAt);
  const published = all
    .filter((i) => i.tags?.relevant && dateOf(i) >= cutoff)
    // Newest first; stories without a publish date go last rather than taking their collection date.
    .sort((a, b) => (b.published ? Date.parse(b.published) : 0) - (a.published ? Date.parse(a.published) : 0))
    .map(({ id, url, title, source, published, collectedAt, collectedBy, contributor, crowdIssue, tags }) => ({
      id,
      url,
      title,
      source,
      published,
      collectedAt,
      collectedBy,
      contributor: contributor ?? null,
      crowdIssue: crowdIssue ?? null,
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
