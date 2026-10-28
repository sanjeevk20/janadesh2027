// Ingests community news tips submitted through the "Submit a news tip" GitHub issue form.
//
// Moderation: only open issues labelled both `news-tip` and `approved` are ingested; a
// moderator (the analyst) adds `approved` after checking the link. Unapproved tips are never
// read. Each ingested tip is added to data/news/items.json with the moderator-approved state,
// seat and topic, credited to the contributor, then the issue is commented on, labelled
// `published` and closed.
//
// Runs in the Daily news workflow before tagging. Needs GITHUB_TOKEN (issues: write) and
// GITHUB_REPOSITORY (owner/repo), both provided by GitHub Actions.
import { readFile, writeFile } from 'node:fs/promises';
import { cleanName } from './gazetteer.mjs';
import { loadRules, tagByRules, STATE_IDS, TAGGER_VERSION } from './rules.mjs';
import { loadGazetteer } from './gazetteer.mjs';
import { similarity } from '../lib.mjs';

const STORE = 'data/news/items.json';
const SEAT_MATCH_THRESHOLD = 0.85;
const LABELS = {
  'news-tip': { color: '1f5fa8', description: 'Community news tip (awaiting moderation)' },
  approved: { color: '2f855a', description: 'Moderator approved: publish with the next daily refresh' },
  published: { color: '6b6b70', description: 'Published on the site' },
  rejected: { color: 'c0392b', description: 'Not published' },
};
const STATE_NAMES = {
  'Uttar Pradesh': 'UP',
  Punjab: 'PB',
  Uttarakhand: 'UK',
  Goa: 'GA',
  Manipur: 'MN',
  Gujarat: 'GJ',
  'Himachal Pradesh': 'HP',
};
const TOPIC_NAMES = {
  'Schedule & Election Commission': 'schedule',
  Alliances: 'alliances',
  Candidates: 'candidates',
  Campaign: 'campaign',
  'Opinion polls': 'polls',
  'By-polls & local polls': 'other_polls',
  Defections: 'defections',
  Governance: 'governance',
  Security: 'security',
  Legal: 'legal',
  Analysis: 'analysis',
  Other: 'other',
};

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!token || !repo) {
    console.log('SKIP community tips: GITHUB_TOKEN / GITHUB_REPOSITORY not set (runs in GitHub Actions).');
  } else {
    await main();
  }
}

async function main() {
  await ensureLabels();
  const issues = await gh(`/repos/${repo}/issues?state=open&labels=news-tip,approved&per_page=100`);
  if (!issues.length) {
    console.log('No approved community tips.');
    return;
  }

  const items = JSON.parse(await readFile(STORE, 'utf8'));
  const urls = new Set(items.map((i) => normaliseUrl(i.url)));
  const seats = await loadSeats();
  const rules = await loadRules();
  const gazetteer = await loadGazetteer();
  let added = 0;

  for (const issue of issues) {
    const tip = parseTip(issue.body ?? '');
    const problems = validate(tip);
    if (problems.length) {
      // Approved but malformed: tell the moderator, leave it open for them to fix.
      await comment(issue, `Couldn't publish this tip:\n${problems.map((p) => `- ${p}`).join('\n')}\n\nEdit the issue to fix it. A moderator then re-adds the \`approved\` label and it will be published at the next daily refresh.`);
      await gh(`/repos/${repo}/issues/${issue.number}/labels/approved`, { method: 'DELETE' }).catch(() => {});
      continue;
    }

    if (urls.has(normaliseUrl(tip.url))) {
      await close(issue, 'This story is already in the news feed, so nothing new was added. Thanks for sharing it!');
      continue;
    }

    const state = STATE_NAMES[tip.state];
    const seat = tip.constituency ? matchSeat(seats, state, tip.constituency) : null;
    const text = [tip.headline, tip.summary].filter(Boolean).join('. ');
    const ruleTags = tagByRules(rules, gazetteer, tip.headline, text);

    items.push({
      id: `crowd-${issue.number}`,
      url: tip.url,
      title: tip.headline,
      source: new URL(tip.url).hostname.replace(/^www\./, ''),
      // The form doesn't ask for a publish date; use when the tip was submitted.
      published: issue.created_at,
      summary: tip.summary || null,
      collectedAt: new Date().toISOString(),
      collectedBy: `crowd:#${issue.number}`,
      contributor: issue.user?.login ?? null,
      crowdIssue: issue.html_url,
      tags: {
        version: TAGGER_VERSION,
        tagger: 'crowd',
        relevant: true,
        reason: null,
        states: [state],
        places: seat
          ? [{ kind: 'ac', state, name: seat.name, ac: seat.no, confidence: 'high', via: ['crowd'] }]
          : [],
        parties: ruleTags.parties,
        topic: TOPIC_NAMES[tip.topic] ?? 'other',
        summary: tip.summary || null,
        claims: [],
        rejected: [],
      },
    });
    urls.add(normaliseUrl(tip.url));
    added++;

    const seatNote = tip.constituency
      ? seat
        ? ` Tagged to **${seat.name}** (seat #${seat.no}).`
        : ` "${tip.constituency}" didn't match a ${tip.state} seat name, so it's published without a seat tag.`
      : '';
    await close(issue, `Published on Janadesh 2027 as a community tip.${seatNote} Thank you!`);
  }

  await writeFile(STORE, JSON.stringify(items, null, 2) + '\n');
  console.log(`Community tips: ${added} published, ${issues.length - added} closed or returned.`);
}

// Issue forms render each field as "### <label>\n\n<value>".
export function parseTip(body) {
  const fields = {};
  for (const block of body.split(/^### /m).slice(1)) {
    const [label, ...rest] = block.split('\n');
    const value = rest.join('\n').trim();
    fields[label.trim()] = value === '_No response_' ? '' : value;
  }
  return {
    url: fields['Link to the story'] ?? '',
    headline: (fields['Headline'] ?? '').replace(/\s+/g, ' ').trim(),
    state: fields['State'] ?? '',
    constituency: (fields['Assembly constituency (optional)'] ?? '').trim(),
    topic: fields['Topic'] ?? '',
    summary: (fields['One-line summary (optional)'] ?? '').replace(/\s+/g, ' ').trim(),
  };
}

export function validate(tip) {
  const problems = [];
  try {
    const u = new URL(tip.url);
    if (u.protocol !== 'https:') problems.push('The link must start with https://');
  } catch {
    problems.push('The link is not a valid web address.');
  }
  if (!tip.headline) problems.push('The headline is missing.');
  if (tip.headline.length > 300) problems.push('The headline is longer than 300 characters.');
  if (!STATE_NAMES[tip.state]) problems.push(`"${tip.state}" is not one of the seven states.`);
  if (tip.topic && !TOPIC_NAMES[tip.topic]) problems.push(`"${tip.topic}" is not a known topic.`);
  if (tip.summary.length > 500) problems.push('The summary is longer than 500 characters.');
  return problems;
}

// Official seat names from the 2022 results, so every seat (including short names the news
// gazetteer skips) can be matched.
async function loadSeats() {
  const seats = {};
  for (const state of STATE_IDS) {
    const r = JSON.parse(await readFile(`public/data/results/2022-${state}.json`, 'utf8'));
    seats[state] = Object.values(r.seats).map((s) => ({ no: s.no, name: s.name, key: cleanName(s.name).replace(/ /g, '') }));
  }
  return seats;
}

export function matchSeat(seats, state, name) {
  const key = cleanName(name).replace(/ /g, '');
  if (!key) return null;
  let best = null;
  let bestScore = 0;
  for (const s of seats[state] ?? []) {
    const score = s.key === key ? 1 : similarity(s.key, key);
    if (score > bestScore) [best, bestScore] = [s, score];
  }
  return bestScore >= SEAT_MATCH_THRESHOLD ? best : null;
}

function normaliseUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const p of [...u.searchParams.keys()]) if (p.startsWith('utm_')) u.searchParams.delete(p);
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

async function ensureLabels() {
  for (const [name, { color, description }] of Object.entries(LABELS)) {
    await gh(`/repos/${repo}/labels`, { method: 'POST', body: { name, color, description } }).catch((err) => {
      if (!String(err.message).includes('422')) throw err; // 422 = label already exists
    });
  }
}

async function comment(issue, body) {
  await gh(`/repos/${repo}/issues/${issue.number}/comments`, { method: 'POST', body: { body } });
}

async function close(issue, message) {
  await comment(issue, message);
  await gh(`/repos/${repo}/issues/${issue.number}/labels`, { method: 'POST', body: { labels: ['published'] } });
  await gh(`/repos/${repo}/issues/${issue.number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
}

async function gh(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub API ${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
