import maplibregl, { type LngLatBoundsLike, type MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import statesData from '../data/states.json';
import type { ConstituencyProps, StateInfo, ValidationReport } from './types';

const STATES = statesData.states as StateInfo[];

// One hue per state; chosen to stay distinguishable on a light basemap.
const STATE_COLORS: Record<string, string> = {
  UP: '#e07b39',
  PB: '#3a8fb7',
  UK: '#5aa469',
  GA: '#c25b8f',
  MN: '#8a6fc4',
  GJ: '#d4a72c',
  HP: '#3fa7a0',
};
const ISSUE_COLOR = '#d7263d';
const BASEMAP_URL = 'https://tiles.openfreemap.org/styles/positron';
// Used when the basemap is unreachable, so the constituency layers still render.
const FALLBACK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eef0f2' } }],
};
const INDIA_BOUNDS: LngLatBoundsLike = [
  [68, 8],
  [92, 33],
];

const panel = {
  list: document.getElementById('state-list')!,
  detail: document.getElementById('detail')!,
  legend: document.getElementById('legend')!,
  toggle: document.getElementById('toggle-issues') as HTMLInputElement,
};

type Feature = GeoJSON.Feature<GeoJSON.Geometry, ConstituencyProps>;

let validation: ValidationReport | null = null;
let features: Feature[] = [];
let selectedState: string | null = null;

const map = new maplibregl.Map({
  container: 'map',
  style: await loadBasemapStyle(),
  bounds: INDIA_BOUNDS,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

renderStateList();
renderLegend();
renderOverview();

map.on('load', async () => {
  const [collections, report] = await Promise.all([
    Promise.all(STATES.map((s) => fetchJson<GeoJSON.FeatureCollection>(`data/boundaries/${s.id}.geojson`))),
    fetchJson<ValidationReport>('data/validation.json'),
  ]);
  validation = report;
  features = collections.flatMap((c) => c.features as Feature[]);
  features.forEach((f, i) => (f.id = i));

  map.addSource('acs', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features },
    attribution: 'Boundaries © <a href="https://github.com/datameet/maps">DataMeet</a> (CC BY 2.5 IN)',
  });

  map.addLayer({
    id: 'ac-fill',
    type: 'fill',
    source: 'acs',
    paint: {
      'fill-color': fillColorExpression(true),
      'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.85, 0.55],
    },
  });
  map.addLayer({
    id: 'ac-line',
    type: 'line',
    source: 'acs',
    paint: { 'line-color': '#ffffff', 'line-width': 0.6 },
  });
  map.addLayer({
    id: 'ac-issue-line',
    type: 'line',
    source: 'acs',
    filter: ['!=', ['get', 'quality'], 'ok'],
    paint: { 'line-color': ISSUE_COLOR, 'line-width': 1.5 },
  });

  wireInteractions();
  renderStateList();
  renderOverview();
});

function fillColorExpression(highlightIssues: boolean): maplibregl.ExpressionSpecification {
  const byState: maplibregl.ExpressionSpecification = [
    'match',
    ['get', 'state'],
    ...Object.entries(STATE_COLORS).flat(),
    '#999999',
  ] as unknown as maplibregl.ExpressionSpecification;
  return highlightIssues ? ['case', ['!=', ['get', 'quality'], 'ok'], ISSUE_COLOR, byState] : byState;
}

function wireInteractions() {
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
  let hoveredId: number | string | undefined;

  map.on('mousemove', 'ac-fill', (e) => {
    const f = e.features?.[0];
    if (!f) return;
    if (hoveredId !== undefined) map.setFeatureState({ source: 'acs', id: hoveredId }, { hover: false });
    hoveredId = f.id;
    map.setFeatureState({ source: 'acs', id: hoveredId! }, { hover: true });
    map.getCanvas().style.cursor = 'pointer';
    popup.setLngLat(e.lngLat).setHTML(tooltipHtml(f)).addTo(map);
  });

  map.on('mouseleave', 'ac-fill', () => {
    if (hoveredId !== undefined) map.setFeatureState({ source: 'acs', id: hoveredId }, { hover: false });
    hoveredId = undefined;
    map.getCanvas().style.cursor = '';
    popup.remove();
  });

  map.on('click', 'ac-fill', (e) => {
    const f = e.features?.[0];
    if (f) renderConstituency(f.properties as ConstituencyProps);
  });

  panel.toggle.addEventListener('change', () => {
    map.setPaintProperty('ac-fill', 'fill-color', fillColorExpression(panel.toggle.checked));
    map.setLayoutProperty('ac-issue-line', 'visibility', panel.toggle.checked ? 'visible' : 'none');
  });
}

function tooltipHtml(f: MapGeoJSONFeature): string {
  const p = f.properties as ConstituencyProps;
  const name = p.ac_name || 'Unnamed shape';
  const no = p.ac_no ? `#${p.ac_no}` : 'no number';
  const flag = p.quality !== 'ok' ? `<div class="tip-flag">⚠ ${qualityLabel(p.quality)}</div>` : '';
  return `<strong>${escapeHtml(name)}</strong> <span class="muted">${no}</span><br>${escapeHtml(p.district ?? '')}${flag}`;
}

function selectState(id: string) {
  selectedState = id;
  const stateFeatures = features.filter((f) => f.properties.state === id);
  const bounds = boundsOf(stateFeatures);
  if (bounds) map.fitBounds(bounds, { padding: 32, duration: 800 });
  renderStateList();
  renderStateDetail(id);
}

function renderStateList() {
  const rounds: Array<[1 | 2, string]> = [
    [1, 'Round 1 · expected Feb–Mar 2027'],
    [2, 'Round 2 · expected Nov–Dec 2027'],
  ];
  panel.list.innerHTML = rounds
    .map(([round, label]) => {
      const cards = STATES.filter((s) => s.round === round)
        .map((s) => {
          const issues = validation?.states.find((v) => v.id === s.id)?.issues.length ?? 0;
          const badge = issues ? `<span class="badge">${issues} data issue${issues > 1 ? 's' : ''}</span>` : '';
          return `
            <button class="state-card${selectedState === s.id ? ' active' : ''}" data-id="${s.id}">
              <span class="swatch" style="background:${STATE_COLORS[s.id]}"></span>
              <span class="state-name">${s.name}</span>
              <span class="state-seats">${s.seats} seats</span>
              ${badge}
            </button>`;
        })
        .join('');
      return `<h2 class="round">${label}</h2><div class="cards">${cards}</div>`;
    })
    .join('');

  panel.list.querySelectorAll<HTMLButtonElement>('.state-card').forEach((btn) =>
    btn.addEventListener('click', () => selectState(btn.dataset.id!)),
  );
}

function renderOverview() {
  const total = STATES.reduce((n, s) => n + s.seats, 0);
  const flagged = validation?.states.filter((s) => s.issues.length).map((s) => s.name) ?? [];
  panel.detail.innerHTML = `
    <h2>Overview</h2>
    <p>${STATES.length} states and <strong>${total}</strong> assembly seats go to the polls in 2027.
    Pick a state, or click any constituency on the map.</p>
    ${
      flagged.length
        ? `<p class="callout">The boundary source has issues in <strong>${flagged.join(', ')}</strong>.
           Shapes in <span style="color:${ISSUE_COLOR}">red</span> could not be matched to a valid seat.</p>`
        : ''
    }
    <p class="muted small">Poll windows are expectations based on assembly term expiry. The Election
    Commission has not announced schedules yet.</p>`;
}

function renderStateDetail(id: string) {
  const s = STATES.find((x) => x.id === id)!;
  const v = validation?.states.find((x) => x.id === id);
  const termNote = s.termEndsConfidence === 'approximate' ? ' <span class="muted">(approx.)</span>' : '';
  const issues = !v
    ? `<p class="muted">Loading data-quality checks…</p>`
    : v.issues.length
    ? `<h3>Data quality</h3><ul class="issues">${v.issues
        .map(
          (i) =>
            `<li class="${i.severity}"><strong>${i.code}</strong> ${escapeHtml(i.message)}${
              i.values?.length && i.values.some((n) => n > 0)
                ? `<br><span class="muted small">Seats: ${i.values.filter((n) => n > 0).join(', ')}</span>`
                : ''
            }</li>`,
        )
        .join('')}</ul>`
    : `<p class="ok">✓ All ${s.seats} constituencies matched in the boundary source.</p>`;

  panel.detail.innerHTML = `
    <button class="link" id="back">← All states</button>
    <h2>${s.name}</h2>
    <dl class="facts">
      <dt>Seats</dt><dd>${s.seats} (majority ${s.majorityMark})</dd>
      <dt>Governing</dt><dd>${escapeHtml(s.governing)}</dd>
      <dt>Term ends</dt><dd>${s.termEnds}${termNote}</dd>
      <dt>Expected polls</dt><dd>${s.expectedPolls}</dd>
    </dl>
    ${s.notes ? `<p>${escapeHtml(s.notes)}</p>` : ''}
    ${issues}`;
  document.getElementById('back')!.addEventListener('click', resetView);
}

function renderConstituency(p: ConstituencyProps) {
  const s = STATES.find((x) => x.id === p.state)!;
  panel.detail.innerHTML = `
    <button class="link" id="back">← ${s.name}</button>
    <h2>${escapeHtml(p.ac_name || 'Unnamed shape')}</h2>
    <dl class="facts">
      <dt>State</dt><dd>${s.name}</dd>
      <dt>AC number</dt><dd>${p.ac_no || '—'}</dd>
      <dt>District</dt><dd>${escapeHtml(p.district ?? '—')}</dd>
      <dt>Lok Sabha seat</dt><dd>${escapeHtml(p.pc_name ?? '—')}</dd>
    </dl>
    ${
      p.quality !== 'ok'
        ? `<p class="callout">⚠ ${qualityLabel(p.quality)}. This shape needs to be repaired against official
           ECI delimitation data before it can carry results.</p>`
        : ''
    }
    <p class="muted small">2022 results and news for this seat arrive in the next phase.</p>`;
  document.getElementById('back')!.addEventListener('click', () => selectState(p.state));
}

function resetView() {
  selectedState = null;
  map.fitBounds(INDIA_BOUNDS, { duration: 800 });
  renderStateList();
  renderOverview();
}

function renderLegend() {
  panel.legend.innerHTML =
    STATES.map((s) => `<span><i style="background:${STATE_COLORS[s.id]}"></i>${s.id}</span>`).join('') +
    `<span><i style="background:${ISSUE_COLOR}"></i>Data issue</span>`;
}

function qualityLabel(q: ConstituencyProps['quality']): string {
  return q === 'unidentified' ? 'Unidentified shape (no valid seat number)' : 'Seat number shared by multiple shapes';
}

function boundsOf(fs: Feature[]): LngLatBoundsLike | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (c: unknown): void => {
    if (typeof (c as number[])[0] === 'number') {
      const [x, y] = c as number[];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    } else (c as unknown[]).forEach(visit);
  };
  for (const f of fs) if (f.geometry && 'coordinates' in f.geometry) visit(f.geometry.coordinates);
  return Number.isFinite(minX) ? [[minX, minY], [maxX, maxY]] : null;
}

async function loadBasemapStyle(): Promise<maplibregl.StyleSpecification | string> {
  try {
    const res = await fetch(BASEMAP_URL, { signal: AbortSignal.timeout(5000) });
    if (res.ok) return BASEMAP_URL;
  } catch {
    // fall through to the offline style
  }
  console.warn('Basemap unavailable; using plain background.');
  return FALLBACK_STYLE;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
