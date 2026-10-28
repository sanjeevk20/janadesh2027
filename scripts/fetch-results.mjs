// Downloads 2022 candidate-level assembly results into data/raw/results/.
// Source: https://github.com/thecont1/india-votes-data (MIT), scraped from ECI results pages.
// Pinned to a commit so builds are reproducible.
//
// Gujarat and Himachal Pradesh are not in that dataset. To add them, drop a CSV with the
// same columns into data/raw/results/2022Assembly-<GJ|HP>.csv and run `npm run data:build`.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const RESULTS_SOURCE = {
  name: 'india-votes-data (ECI results)',
  url: 'https://github.com/thecont1/india-votes-data',
  commit: '7d8cf637f83d223b178d11659103a1f52647367a',
  license: 'MIT',
};
const STATES = ['UP', 'PB', 'UK', 'GA', 'MN'];
const OUT_DIR = path.resolve('data/raw/results');

if (import.meta.url === `file://${process.argv[1]}`) {
  await mkdir(OUT_DIR, { recursive: true });
  for (const id of STATES) {
    const file = `2022Assembly-${id}.csv`;
    const url = `https://raw.githubusercontent.com/thecont1/india-votes-data/${RESULTS_SOURCE.commit}/data/csv/${file}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${file}: HTTP ${res.status}`);
    await writeFile(path.join(OUT_DIR, file), Buffer.from(await res.arrayBuffer()));
    console.log(`saved data/raw/results/${file}`);
  }
}
