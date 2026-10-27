// Downloads 2024 Lok Sabha candidate-level results and extracts them to data/raw/ls2024/.
// Source: https://github.com/answerquest/india-elections2024-results-timewise (MIT), scraped
// from results.eci.gov.in during counting. The file holds repeated snapshots per candidate;
// build-ls2024.mjs keeps the latest one.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import SevenZip from '7z-wasm';

export const LS2024_SOURCE = {
  name: 'india-elections2024-results-timewise (ECI results)',
  url: 'https://github.com/answerquest/india-elections2024-results-timewise',
  commit: '58d26d57406e15e814a7b6443c07a5006eb576b0',
  license: 'MIT',
};
const ARCHIVE = 'Elections2024_candidates_votes_changes.csv.7z';
export const LS2024_CSV = 'Elections2024_candidates_votes_changes.csv';
const OUT_DIR = path.resolve('data/raw/ls2024');

if (import.meta.url === `file://${process.argv[1]}`) {
  await mkdir(OUT_DIR, { recursive: true });
  const url = `https://raw.githubusercontent.com/answerquest/india-elections2024-results-timewise/${LS2024_SOURCE.commit}/${ARCHIVE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${ARCHIVE}: HTTP ${res.status}`);
  const archive = new Uint8Array(await res.arrayBuffer());

  const sevenZip = await SevenZip({ print: () => {}, printErr: console.error });
  sevenZip.FS.writeFile(ARCHIVE, archive);
  sevenZip.callMain(['x', ARCHIVE, '-y']);
  await writeFile(path.join(OUT_DIR, LS2024_CSV), sevenZip.FS.readFile(LS2024_CSV));
  console.log(`saved data/raw/ls2024/${LS2024_CSV}`);
}
