// Polls the RSS feeds in data/news-feeds.json and appends new stories to data/news/items.json.
// Stories are deduplicated by URL and by normalised title (the same story often appears in
// several state feeds). Tagging happens separately in tag-news.mjs.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { exists } from '../lib.mjs';

const STORE = 'data/news/items.json';
const { feeds } = JSON.parse(await readFile('data/news-feeds.json', 'utf8'));
const items = (await exists(STORE)) ? JSON.parse(await readFile(STORE, 'utf8')) : [];

const seenUrls = new Set(items.map((i) => i.url));
const seenTitles = new Set(items.map((i) => titleKey(i.title)));
const collectedAt = new Date().toISOString();
let added = 0;
let failed = 0;

for (const feed of feeds) {
  let xml;
  try {
    const res = await fetch(feed.url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } catch (err) {
    failed++;
    console.warn(`FAIL ${feed.id}: ${err.message}`);
    continue;
  }

  let feedAdded = 0;
  for (const entry of parseRss(xml)) {
    if (!entry.url || !entry.title) continue;
    const key = titleKey(entry.title);
    if (seenUrls.has(entry.url) || seenTitles.has(key)) continue;
    seenUrls.add(entry.url);
    seenTitles.add(key);
    items.push({
      id: createHash('sha1').update(entry.url).digest('hex').slice(0, 12),
      url: entry.url,
      title: entry.title,
      source: entry.source,
      published: entry.published,
      summary: entry.summary,
      collectedAt,
      collectedBy: `rss:${feed.id}`,
      tags: null,
    });
    feedAdded++;
  }
  added += feedAdded;
  console.log(`OK   ${feed.id}: ${feedAdded} new`);
}

await writeFile(STORE, JSON.stringify(items, null, 2) + '\n');
console.log(`\n${added} new stories (${items.length} total)${failed ? `; ${failed} feed(s) failed` : ''}`);
if (failed === feeds.length) process.exitCode = 1;

// Google News titles end in " - Publisher"; strip it so the same story from two feeds matches.
function titleKey(title) {
  return String(title)
    .replace(/\s+-\s+[^-]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Minimal RSS 2.0 reader: enough for <item> title/link/pubDate/source/description.
function parseRss(xml) {
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
    return m ? decode(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')).trim() : null;
  };
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(([, block]) => {
    const source = tag(block, 'source');
    let title = tag(block, 'title') ?? '';
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const date = tag(block, 'pubDate');
    return {
      title,
      url: tag(block, 'link'),
      source,
      published: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null,
      summary: stripHtml(tag(block, 'description') ?? '').slice(0, 500) || null,
    };
  });
}

function stripHtml(s) {
  return decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decode(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
