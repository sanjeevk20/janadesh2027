// Builds simplified per-state constituency GeoJSON for the 2027 election states
// and a validation report comparing the source data against known seat counts.
//
// Input:  data/raw/India_AC.{shp,shx,dbf,prj}  (run `npm run data:fetch` first)
//         data/states.json
// Output: public/data/boundaries/<STATE_ID>.geojson
//         public/data/validation.json
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import mapshaper from 'mapshaper';

const RAW = path.resolve('data/raw');
const OUT_BOUNDARIES = path.resolve('public/data/boundaries');
const OUT_VALIDATION = path.resolve('public/data/validation.json');

// Keep about 8% of vertices: enough for a state-level choropleth, small enough to load fast.
const SIMPLIFY = '8%';

const { states } = JSON.parse(await readFile('data/states.json', 'utf8'));
const input = {};
for (const ext of ['shp', 'shx', 'dbf', 'prj']) {
  input[`India_AC.${ext}`] = await readFile(path.join(RAW, `India_AC.${ext}`));
}

await mkdir(OUT_BOUNDARIES, { recursive: true });

const report = { generatedAt: new Date().toISOString(), source: 'DataMeet India_AC (CC BY 2.5 IN)', states: [] };

for (const state of states) {
  const cmd = [
    '-i India_AC.shp',
    `-filter 'ST_NAME == "${state.sourceName}"'`,
    '-clean',
    `-simplify ${SIMPLIFY} keep-shapes`,
    '-filter-fields AC_NO,AC_NAME,DIST_NAME,PC_NAME,STATUS',
    '-rename-fields ac_no=AC_NO,ac_name=AC_NAME,district=DIST_NAME,pc_name=PC_NAME,status=STATUS',
    `-each 'state="${state.id}"'`,
    `-o ${state.id}.geojson format=geojson precision=0.0001`,
  ].join(' ');

  const output = await mapshaper.applyCommands(cmd, input);
  const geojson = JSON.parse(output[`${state.id}.geojson`]);
  tagQualityFlags(state, geojson.features);
  await writeFile(path.join(OUT_BOUNDARIES, `${state.id}.geojson`), JSON.stringify(geojson));

  const result = validate(state, geojson.features);
  report.states.push(result);
  const flag = result.issues.some((i) => i.severity === 'error') ? 'FAIL' : result.issues.length ? 'WARN' : 'OK';
  console.log(`${flag.padEnd(4)} ${state.id} ${state.name}: ${geojson.features.length}/${state.seats} features, ${result.issues.length} issue(s)`);
}

await writeFile(OUT_VALIDATION, JSON.stringify(report, null, 2) + '\n');
console.log(`\nValidation report written to ${path.relative(process.cwd(), OUT_VALIDATION)}`);

// Marks each feature with a `quality` property so the map can highlight suspect shapes:
// "unidentified" (number outside the valid range), "duplicate" (number shared with
// another shape) or "ok".
function tagQualityFlags(state, features) {
  const counts = new Map();
  for (const f of features) counts.set(f.properties.ac_no, (counts.get(f.properties.ac_no) ?? 0) + 1);
  for (const f of features) {
    const no = f.properties.ac_no;
    f.properties.quality =
      !(no >= 1 && no <= state.seats) ? 'unidentified' : counts.get(no) > 1 ? 'duplicate' : 'ok';
  }
}

function validate(state, features) {
  const issues = [];
  const props = features.map((f) => f.properties);

  if (features.length !== state.seats) {
    issues.push({
      severity: 'error',
      code: 'SEAT_COUNT_MISMATCH',
      message: `Source has ${features.length} constituency shapes; the assembly has ${state.seats} seats.`,
    });
  }

  const byNo = new Map();
  for (const p of props) {
    byNo.set(p.ac_no, (byNo.get(p.ac_no) ?? 0) + 1);
  }
  const duplicates = [...byNo].filter(([, n]) => n > 1).map(([no]) => no);
  if (duplicates.length) {
    issues.push({
      severity: 'error',
      code: 'DUPLICATE_AC_NO',
      message: `${duplicates.length} constituency number(s) appear more than once.`,
      values: duplicates.sort((a, b) => a - b),
    });
  }

  const missing = [];
  for (let n = 1; n <= state.seats; n++) if (!byNo.has(n)) missing.push(n);
  if (missing.length) {
    issues.push({
      severity: 'error',
      code: 'MISSING_AC_NO',
      message: `${missing.length} constituency number(s) between 1 and ${state.seats} have no shape.`,
      values: missing,
    });
  }

  const outOfRange = [...byNo.keys()].filter((n) => !(n >= 1 && n <= state.seats));
  if (outOfRange.length) {
    issues.push({
      severity: 'error',
      code: 'AC_NO_OUT_OF_RANGE',
      message: `${outOfRange.length} shape(s) have a constituency number outside 1–${state.seats}.`,
      values: outOfRange.sort((a, b) => a - b),
    });
  }

  const unnamed = props.filter((p) => !p.ac_name || !String(p.ac_name).trim()).map((p) => p.ac_no);
  if (unnamed.length) {
    issues.push({
      severity: 'warning',
      code: 'MISSING_NAME',
      message: `${unnamed.length} shape(s) have no constituency name.`,
      values: unnamed,
    });
  }

  const preDelimitation = props.filter((p) => /pre/i.test(p.status ?? '')).length;
  if (preDelimitation) {
    issues.push({
      severity: 'warning',
      code: 'PRE_DELIMITATION',
      message: `${preDelimitation} shape(s) are marked as pre-delimitation boundaries.`,
    });
  }

  const empty = features.filter((f) => !f.geometry).map((f) => f.properties.ac_no);
  if (empty.length) {
    issues.push({
      severity: 'error',
      code: 'EMPTY_GEOMETRY',
      message: `${empty.length} shape(s) have no geometry after cleaning.`,
      values: empty,
    });
  }

  return { id: state.id, name: state.name, expectedSeats: state.seats, features: features.length, issues };
}
