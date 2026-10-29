// The news archive, split into one file per month so no single file grows without bound:
//
//   data/news/archive/2026-10.json, 2026-09.json, ...
//
// A story lives in the month it was published (or collected, if the publish date is unknown);
// that never changes, so a story never moves between files. Each file is a JSON array with one
// story per line, which keeps files compact and daily git diffs readable.
//
// All news scripts read and write the archive through loadItems() / saveItems().
import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { exists } from '../lib.mjs';

const DIR = 'data/news/archive';
// Single-file archive used before the split; migrated on the first save.
const LEGACY = 'data/news/items.json';

export function monthOf(item) {
  return (item.published ?? item.collectedAt).slice(0, 7);
}

export async function loadItems() {
  const files = (await readdir(DIR).catch(() => [])).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort();
  const items = [];
  for (const f of files) items.push(...JSON.parse(await readFile(path.join(DIR, f), 'utf8')));
  if (await exists(LEGACY)) {
    const seen = new Set(items.map((i) => i.id));
    for (const i of JSON.parse(await readFile(LEGACY, 'utf8'))) if (!seen.has(i.id)) items.push(i);
  }
  return items;
}

// Writes every month's file (only touching files whose content changed) and removes the legacy
// single-file archive once its stories are in the monthly files.
export async function saveItems(items) {
  await mkdir(DIR, { recursive: true });
  const byMonth = new Map();
  for (const item of items) {
    const m = monthOf(item);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(item);
  }

  let written = 0;
  for (const [month, list] of byMonth) {
    // Stable order (collection time, then id) so unchanged months produce identical files.
    list.sort((a, b) => a.collectedAt.localeCompare(b.collectedAt) || a.id.localeCompare(b.id));
    const content = `[\n${list.map((i) => JSON.stringify(i)).join(',\n')}\n]\n`;
    const file = path.join(DIR, `${month}.json`);
    if ((await exists(file)) && (await readFile(file, 'utf8')) === content) continue;
    await writeFile(file, content);
    written++;
  }

  if (await exists(LEGACY)) await unlink(LEGACY);
  return { months: byMonth.size, written };
}
