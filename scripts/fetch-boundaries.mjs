// Downloads DataMeet's India Assembly Constituency shapefile into data/raw/.
// Source: https://github.com/datameet/maps/tree/master/assembly-constituencies
// License: CC BY 2.5 India
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://raw.githubusercontent.com/datameet/maps/master/assembly-constituencies';
const OUT_DIR = path.resolve('data/raw');
const PARTS = ['shp', 'shx', 'dbf', 'prj'];

await mkdir(OUT_DIR, { recursive: true });

for (const ext of PARTS) {
  const file = path.join(OUT_DIR, `India_AC.${ext}`);
  const force = process.argv.includes('--force');
  if (!force && (await exists(file))) {
    console.log(`skip  ${file} (exists; use --force to re-download)`);
    continue;
  }
  const res = await fetch(`${BASE}/India_AC.${ext}`);
  if (!res.ok) throw new Error(`Failed to fetch India_AC.${ext}: HTTP ${res.status}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  console.log(`saved ${file}`);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
